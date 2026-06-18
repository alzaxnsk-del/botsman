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
        Labels: { 'botsman.hostexec': '1' },
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
    const safe = repoDir.replace(/'/g, '');
    // Robust update:
    //  - `git fetch + reset --hard` tolerates a dirty / divergent / shallow
    //    (`clone --depth 1`) checkout that `git pull --ff-only` would choke on;
    //    safe.directory avoids git's "dubious ownership" refusal under host root.
    //    (reset --hard only touches tracked files — the untracked .env is kept.)
    //  - the BUILD runs in the FOREGROUND so a failure is reported to the owner
    //    instead of vanishing into a backgrounded log; only the final `up -d`
    //    (which recreates, and so kills, this daemon) is detached so it can
    //    finish after the daemon goes down.
    const script =
      `cd '${safe}' && ` +
      `git config --global --add safe.directory '${safe}' && ` +
      `git fetch origin main && git reset --hard FETCH_HEAD && ` +
      `docker compose build && ` +
      `(nohup docker compose up -d >/tmp/botsman-selfupdate.log 2>&1 &)`;
    // Foreground build can take a few minutes on a small VPS (tsc + any changed
    // layers); generous cap. Cached rebuilds (only src changed) are ~1 min.
    return this.runOnHost(script, { label: 'self_update', timeoutMs: 12 * 60_000 });
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
