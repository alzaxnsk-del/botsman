import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { logger } from './logger.js';

/**
 * ⚠️ PRIVILEGED HOST EXECUTION — the highest-risk module in Botsman.
 *
 * The daemon runs in a container, so host-level operations (metrics, apt
 * upgrade, self-update) are performed by spawning a one-off container with
 * `Privileged: true` + `PidMode: 'host'` and `nsenter`-ing into PID 1's
 * namespaces. That container is effectively ROOT ON THE HOST — it deliberately
 * punctures the §5 isolation the rest of Botsman maintains (agent and service
 * containers drop ALL caps).
 *
 * This is only acceptable because of the guards OUTSIDE this module:
 *  - reachable only from the owner-only "Server" (devops) room;
 *  - every mutating op requires a confirm button (host-level ops: two);
 *  - commands are assembled by OUR code from a fixed op catalog — the LLM never
 *    emits shell. Nothing here takes free-form user text as a command.
 * Every invocation is audit-logged below.
 */

export interface HostExecResult {
  ok: boolean;
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/** Docker label on the one-off privileged nsenter helper containers. */
export const HOSTEXEC_LABEL = 'botsman.hostexec';

export class HostExec {
  constructor(
    private docker: Dockerode,
    /** Small image with nsenter (util-linux). alpine has it via busybox. */
    private image = 'alpine:3.20',
  ) {}

  /**
   * Run a shell command ON THE HOST via nsenter into PID 1. PRIVILEGED.
   * `script` is assembled by Botsman from the op catalog — never raw user input.
   */
  async runOnHost(script: string, opts: { timeoutMs?: number; label?: string } = {}): Promise<HostExecResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    logger.info('hostExec runOnHost', { label: opts.label ?? 'host', script });
    return this.spawn(
      {
        Image: this.image,
        Entrypoint: ['nsenter'],
        Cmd: ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', script],
        HostConfig: {
          Privileged: true,
          PidMode: 'host',
          NetworkMode: 'host',
          AutoRemove: false,
        },
        Labels: { [HOSTEXEC_LABEL]: '1' },
      },
      timeoutMs,
    );
  }

  /** Host load / memory / disk — read-only, but needs host namespaces. */
  async hostMetrics(): Promise<HostExecResult> {
    return this.runOnHost(
      'echo "== uptime / load =="; uptime; echo; echo "== memory (MB) =="; free -m; echo; echo "== disk =="; df -h / 2>/dev/null',
      { label: 'host_metrics', timeoutMs: 20_000 },
    );
  }

  /** apt update && upgrade — host-level mutation, slow. */
  async hostPackageUpdate(): Promise<HostExecResult> {
    return this.runOnHost(
      'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get -y upgrade 2>&1 | tail -40',
      { label: 'host_update', timeoutMs: 8 * 60_000 },
    );
  }

  /**
   * Reclaim docker disk. Uses the docker SOCKET (not a privileged container) —
   * minimizes privileged surface.
   */
  async pruneDocker(): Promise<HostExecResult> {
    logger.info('hostExec pruneDocker');
    try {
      const images = await this.docker.pruneImages({ filters: { dangling: { false: true } } as never });
      const builder = await this.docker.pruneBuilder().catch(() => ({ SpaceReclaimed: 0 }));
      const reclaimed =
        (images.SpaceReclaimed ?? 0) + ((builder as { SpaceReclaimed?: number }).SpaceReclaimed ?? 0);
      const mb = Math.round(reclaimed / (1024 * 1024));
      return { ok: true, exitCode: 0, output: `Reclaimed ~${mb} MB of docker disk.`, timedOut: false };
    } catch (e) {
      return { ok: false, exitCode: 1, output: (e as Error).message, timedOut: false };
    }
  }

  /**
   * Pull the latest Botsman, rebuild and restart. Runs on the host (the daemon
   * cannot `docker compose up` its own container from inside). INTENTIONALLY
   * bounces the daemon — the caller must warn the user it will be back shortly.
   */
  async selfUpdate(repoDir: string): Promise<HostExecResult> {
    // repoDir comes from our own env (BOTSMAN_REPO_DIR / install.sh), never user
    // text — but fail LOUDLY on an unexpected path instead of silently rewriting
    // it. Validated to an absolute, shell-safe path so the single-quoting below
    // is sound.
    if (!/^\/[\w./-]+$/.test(repoDir)) {
      return { ok: false, exitCode: -1, output: `Refusing to self-update: unexpected repo path ${JSON.stringify(repoDir)}.`, timedOut: false };
    }
    const r = repoDir;
    const log = '/tmp/botsman-selfupdate.log';
    // Robust update:
    //  - `git fetch + reset --hard` tolerates a dirty / divergent / shallow
    //    (`clone --depth 1`) checkout that `git pull --ff-only` would choke on;
    //    safe.directory (added idempotently) avoids git's "dubious ownership"
    //    refusal under host root. reset --hard only touches tracked files (the
    //    untracked .env is kept).
    //  - `config -q` then `build` run in the FOREGROUND so their failures are
    //    reported (ok=false), not lost to a log.
    //  - NO-OP by IMAGE IDENTITY, not git HEAD: compare the running daemon's
    //    image to the freshly-built one. A docs/test-only commit moves HEAD but
    //    leaves every layer cached → identical image → nothing to restart, so we
    //    print BOTSMAN_NOOP instead of promising a restart that never comes. This
    //    also self-heals a stale image whose HEAD already matched origin/main.
    //  - CRUX: `docker compose up -d` recreates — and so kills — this daemon, so
    //    it must OUTLIVE the nsenter helper container. A backgrounded process
    //    stays in the helper's cgroup and is killed when HostExec.spawn force-
    //    removes the helper (nsenter doesn't enter a cgroup namespace) — that is
    //    why the previous `nohup … &` silently never restarted. Hand it to host
    //    systemd (its own cgroup, survives the helper's removal); fall back to a
    //    foreground up -d (the daemon dies mid-recreate before it can remove the
    //    helper, so the helper lives on to finish it). up -d's output is appended
    //    to the log the owner is pointed at — including on the systemd path.
    const upd = `cd '${r}' && docker compose up -d >>${log} 2>&1`;
    const script = [
      `cd '${r}' || exit 1`,
      `git config --global --get-all safe.directory 2>/dev/null | grep -qxF '${r}' || git config --global --add safe.directory '${r}'`,
      `git fetch origin main || exit 1`,
      `git reset --hard FETCH_HEAD || exit 1`,
      `docker compose config -q || exit 1`,
      `running="$(docker inspect --format '{{.Image}}' botsman-daemon 2>/dev/null || true)"`,
      `docker compose build || exit 1`,
      `built="$(docker image inspect --format '{{.Id}}' botsman 2>/dev/null || true)"`,
      `[ -n "$built" ] && [ "$running" = "$built" ] && { echo BOTSMAN_NOOP; exit 0; }`,
      `if command -v systemd-run >/dev/null 2>&1; then systemd-run --no-block --collect sh -c "${upd}" >/dev/null 2>&1 || ( ${upd} ); else ( ${upd} ); fi`,
    ].join('\n');
    // A cold rebuild re-runs the slow `playwright install` (Chromium download);
    // give it real headroom so the cap doesn't SIGKILL it. Cached rebuilds
    // (only src changed) are ~1 min.
    return this.runOnHost(script, { label: 'self_update', timeoutMs: 20 * 60_000 });
  }

  /** Pull the helper image if it isn't on the host — createContainer won't. */
  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return; // already present
    } catch { /* needs pulling */ }
    logger.info('hostExec pulling image', { image: this.image });
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(this.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err ?? new Error('no pull stream'));
        this.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
      });
    });
  }

  private spawn(
    createOpts: Dockerode.ContainerCreateOptions,
    timeoutMs: number,
  ): Promise<HostExecResult> {
    return (async () => {
      let container: Dockerode.Container | null = null;
      try {
        await this.ensureImage(); // createContainer does NOT auto-pull
        container = await this.docker.createContainer(createOpts);
        const attach = await container.attach({ stream: true, stdout: true, stderr: true });
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        const outPT = new PassThrough().on('data', (c: Buffer) => outChunks.push(c));
        const errPT = new PassThrough().on('data', (c: Buffer) => errChunks.push(c));
        this.docker.modem.demuxStream(attach, outPT, errPT);

        await container.start();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          void container!.kill().catch(() => {});
        }, timeoutMs);
        const status = await container.wait();
        clearTimeout(timer);

        const output = (Buffer.concat(outChunks).toString('utf8') + Buffer.concat(errChunks).toString('utf8')).trim();
        const exitCode = status.StatusCode ?? -1;
        return { ok: !timedOut && exitCode === 0, exitCode, output, timedOut };
      } catch (e) {
        return { ok: false, exitCode: -1, output: (e as Error).message, timedOut: false };
      } finally {
        if (container) await container.remove({ force: true }).catch(() => {});
      }
    })();
  }
}
