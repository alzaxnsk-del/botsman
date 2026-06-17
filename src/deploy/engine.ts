import Dockerode from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { pack } from 'tar-fs';
import { paths } from '../paths.js';
import { logger } from '../logger.js';
import { CaddyClient } from './caddy.js';
import { dbEnvFor, PG_CONTAINER, type ProjectDb } from './postgres.js';
import { smokeCheck } from './smoke.js';
import { takeScreenshot } from './screenshot.js';
import { DEFAULT_DOCKERFILE, BUILD_IGNORE } from './templates.js';
import type { ProjectMeta, StageReporter } from '../types.js';

export const SERVICE_PORT = 3000;
export const DAEMON_CONTAINER = 'botsman-daemon';
export const CADDY_CONTAINER = 'botsman-caddy';

export interface DeployResult {
  ok: boolean;
  image?: string;
  containerName?: string;
  url?: string;
  screenshotPath?: string | null;
  /** Deploy succeeded internally, but the public URL didn't answer (DNS/TLS). */
  publicWarning?: string;
  error?: string;
}

export interface DeployEngine {
  deploy(project: ProjectMeta, commit: string, report: StageReporter): Promise<DeployResult>;
  rollback(project: ProjectMeta, report: StageReporter): Promise<DeployResult>;
  remove(project: ProjectMeta): Promise<void>;
  containerLogs(slug: string, lines: number): Promise<string>;
  containerRunning(slug: string): Promise<boolean>;
  /** Remove stale per-commit images, keeping the listed tags (current + prev). */
  cleanupImages(slug: string, keep: Array<string | null | undefined>): Promise<void>;
  /** One-shot internal HTTP probe of the running service (for /doctor). */
  probeInternal(slug: string): Promise<{ ok: boolean; detail: string }>;
  /** Restart the service container (one-tap fix in /doctor). */
  restartService(slug: string): Promise<void>;
  /** Restart the reverse proxy — retries TLS issuance immediately (one-tap fix). */
  restartProxy(): Promise<void>;
}

/**
 * Docker-based deploy engine (§4 EPIC E).
 *
 * Topology per project: a private network "botsman-svc-<slug>" containing the
 * service container, Caddy, the daemon and the shared Postgres. Services of
 * different projects never share a network (§5 isolation). Containers run
 * unprivileged, resource-limited, without the Docker socket or the Botsman
 * config (AC-D2/AC-D3).
 *
 * Zero-downtime-ish: a new container (named by commit) starts alongside the
 * old one; only after the smoke-check passes does the Caddy route switch and
 * the old container stop (AC-C2). The previous image is kept for /rollback.
 */
export class DockerDeployEngine implements DeployEngine {
  constructor(
    private docker: Dockerode,
    private caddy: CaddyClient,
    private baseDomain: string,
  ) {}

  netName(slug: string): string {
    return `botsman-svc-${slug}`;
  }

  containerName(slug: string, commit: string): string {
    return `botsman-app-${slug}-${commit.slice(0, 8)}`;
  }

  imageTag(slug: string, commit: string): string {
    return `botsman/${slug}:${commit.slice(0, 12)}`;
  }

  hostFor(slug: string): string {
    return `${slug}.${this.baseDomain}`;
  }

  async deploy(project: ProjectMeta, commit: string, report: StageReporter): Promise<DeployResult> {
    const { slug } = project;
    const dir = paths.projectDir(slug);
    const image = this.imageTag(slug, commit);
    // Unique per deploy: redeploying the same commit (e.g. a git push with no
    // new changes) must not collide with the running container's name.
    const name = `${this.containerName(slug, commit)}-${Date.now().toString(36).slice(-4)}`;
    const host = this.hostFor(slug);
    const db: ProjectDb = { dbName: project.dbName, dbUser: project.dbUser, dbPassword: project.dbPassword };

    try {
      report('building');
      await this.buildImage(dir, image);

      await this.ensureNetwork(slug);

      // Migrations (if the project defines them) run before the new version starts.
      if (this.hasMigrateScript(dir)) {
        report('deploying', 'database migrations');
        await this.runMigrations(slug, image, db);
      }

      report('deploying');
      const oldContainers = await this.findProjectContainers(slug);
      await this.startContainer(name, image, slug, db);

      report('checking');
      const internalUrl = `http://${name}:${SERVICE_PORT}/`;
      const smoke = await smokeCheck(internalUrl);
      if (!smoke.ok) {
        // New version is bad: kill it, leave the old one untouched (AC-C2).
        const crashLogs = await this.containerLogsByName(name, 30).catch(() => '');
        await this.removeContainer(name).catch(() => {});
        return {
          ok: false,
          error: `Smoke-check failed after ${smoke.attempts} attempts (${smoke.error ?? 'no response'}).` +
            (crashLogs ? `\nLast container logs:\n${crashLogs.slice(-1000)}` : ''),
        };
      }

      await this.caddy.upsertRoute(slug, host, `${name}:${SERVICE_PORT}`);

      for (const old of oldContainers) {
        if (old !== name) await this.removeContainer(old).catch(() => {});
      }

      // The service is live internally; verify the public URL too (DNS + TLS).
      // Failure here is a WARNING, not a deploy failure — issuance can lag.
      report('checking', 'public URL');
      const publicUrl = `https://${host}/`;
      const pub = await smokeCheck(publicUrl, { timeoutMs: 45_000, intervalMs: 5_000 });
      const publicWarning = pub.ok
        ? undefined
        : `The service is up internally, but ${publicUrl} is not answering yet (${pub.error ?? 'no response'}). ` +
          `Check the wildcard DNS record *.${this.baseDomain} → this server's IP; the TLS certificate may take a couple more minutes to issue.`;

      report('screenshot');
      const screenshotPath = await takeScreenshot(internalUrl, slug);

      return { ok: true, image, containerName: name, url: publicUrl, screenshotPath, publicWarning };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async rollback(project: ProjectMeta, report: StageReporter): Promise<DeployResult> {
    const { slug, prevImage, prevCommit } = project;
    if (!prevImage || !prevCommit) {
      return { ok: false, error: 'No previous working version to roll back to.' };
    }
    // Unique suffix: repeated rollbacks to the same commit must not collide on container name.
    const name = `${this.containerName(slug, prevCommit)}-rb${Date.now().toString(36).slice(-4)}`;
    const host = this.hostFor(slug);
    const db: ProjectDb = { dbName: project.dbName, dbUser: project.dbUser, dbPassword: project.dbPassword };
    try {
      report('deploying', 'rolling back to the previous image');
      const oldContainers = await this.findProjectContainers(slug);
      await this.startContainer(name, prevImage, slug, db);
      report('checking');
      const smoke = await smokeCheck(`http://${name}:${SERVICE_PORT}/`);
      if (!smoke.ok) {
        await this.removeContainer(name).catch(() => {});
        return { ok: false, error: `Rollback failed the smoke-check: ${smoke.error}` };
      }
      await this.caddy.upsertRoute(slug, host, `${name}:${SERVICE_PORT}`);
      for (const old of oldContainers) {
        if (old !== name) await this.removeContainer(old).catch(() => {});
      }
      return { ok: true, image: prevImage, containerName: name, url: `https://${host}/` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async remove(project: ProjectMeta): Promise<void> {
    const { slug } = project;
    await this.caddy.removeRoute(slug).catch((e) => logger.warn('route remove failed', { slug, error: String(e) }));
    for (const c of await this.findProjectContainers(slug)) {
      await this.removeContainer(c).catch(() => {});
    }
    await this.removeNetwork(slug).catch(() => {});
    // Images are kept on disk until pruned; cheap and useful for forensics.
  }

  /** Per-commit images accumulate fast on a small VPS — GC all but current+prev. */
  async cleanupImages(slug: string, keep: Array<string | null | undefined>): Promise<void> {
    const keepSet = new Set(keep.filter((t): t is string => !!t));
    const images = await this.docker
      .listImages({ filters: { reference: [`botsman/${slug}`] } })
      .catch(() => [] as Dockerode.ImageInfo[]);
    for (const img of images) {
      const tags = img.RepoTags ?? [];
      if (tags.some((t) => keepSet.has(t))) continue;
      for (const t of tags) {
        await this.docker.getImage(t).remove().catch(() => {}); // in use → skip silently
      }
    }
  }

  async containerRunning(slug: string): Promise<boolean> {
    const names = await this.findProjectContainers(slug, true);
    return names.length > 0;
  }

  async probeInternal(slug: string): Promise<{ ok: boolean; detail: string }> {
    const names = await this.findProjectContainers(slug, true);
    if (!names.length) return { ok: false, detail: 'no running container' };
    const res = await smokeCheck(`http://${names[0]}:${SERVICE_PORT}/`, {
      timeoutMs: 10_000,
      intervalMs: 2_500,
    });
    return res.ok
      ? { ok: true, detail: 'HTTP 200' }
      : { ok: false, detail: res.error ?? `HTTP ${res.status}` };
  }

  async restartService(slug: string): Promise<void> {
    for (const name of await this.findProjectContainers(slug)) {
      await this.docker.getContainer(name).restart({ t: 5 }).catch(() => {});
    }
  }

  async restartProxy(): Promise<void> {
    // Caddy reloads its autosaved config on start (--resume) and immediately
    // re-attempts certificate issuance for every configured host.
    await this.docker.getContainer(CADDY_CONTAINER).restart({ t: 5 });
  }

  async containerLogs(slug: string, lines = 50): Promise<string> {
    const names = await this.findProjectContainers(slug);
    if (!names.length) return '(container not found)';
    return this.containerLogsByName(names[0], lines);
  }

  // --- internals ---

  private async buildImage(dir: string, tag: string): Promise<void> {
    if (!fs.existsSync(path.join(dir, 'Dockerfile'))) {
      // The default Dockerfile does `COPY package*.json ./` — without one, the
      // build fails with an opaque "COPY failed: no source files were
      // specified". Fail early with a message that says what's actually wrong.
      if (!fs.existsSync(path.join(dir, 'package.json'))) {
        throw new Error(
          'no application source: the project has neither a Dockerfile nor a package.json to build from.',
        );
      }
      fs.writeFileSync(path.join(dir, 'Dockerfile'), DEFAULT_DOCKERFILE);
    }
    const tarStream = pack(dir, {
      ignore: (p) => {
        const rel = path.relative(dir, p);
        return BUILD_IGNORE.some((ig) => rel === ig || rel.startsWith(ig + path.sep));
      },
    });
    // Build steps run arbitrary RUN commands from the (agent-written) Dockerfile —
    // network is required for npm install, but RAM/CPU are capped (§5).
    const stream = await this.docker.buildImage(tarStream as unknown as NodeJS.ReadableStream, {
      t: tag,
      memory: 1536 * 1024 * 1024,
      cpuperiod: 100_000,
      cpuquota: 100_000, // 1 CPU
    });
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null, res: Array<{ error?: string; errorDetail?: { message?: string } }>) => {
          if (err) return reject(err);
          const failed = res?.find((r) => r.error);
          if (failed) return reject(new Error(`docker build: ${failed.errorDetail?.message ?? failed.error}`));
          resolve();
        },
      );
    });
  }

  private hasMigrateScript(dir: string): boolean {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return typeof pkg.scripts?.migrate === 'string';
    } catch {
      return false;
    }
  }

  private async runMigrations(slug: string, image: string, db: ProjectDb): Promise<void> {
    const name = `botsman-migrate-${slug}-${Date.now()}`;
    const container = await this.docker.createContainer({
      name,
      Image: image,
      Cmd: ['npm', 'run', 'migrate'],
      Env: this.serviceEnv(db),
      User: 'node',
      HostConfig: {
        NetworkMode: this.netName(slug),
        Memory: 512 * 1024 * 1024,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges:true'],
      },
    });
    try {
      await container.start();
      const status = await container.wait();
      if (status.StatusCode !== 0) {
        const logs = await this.containerLogsByName(name, 50).catch(() => '');
        throw new Error(`Migrations failed (exit ${status.StatusCode}):\n${logs.slice(-800)}`);
      }
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  private serviceEnv(db: ProjectDb): string[] {
    const env = { PORT: String(SERVICE_PORT), NODE_ENV: 'production', ...dbEnvFor(db) };
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  private async startContainer(name: string, image: string, slug: string, db: ProjectDb): Promise<void> {
    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: this.serviceEnv(db),
      Labels: { 'botsman.project': slug },
      // Enforced non-root regardless of what the (agent-written) Dockerfile
      // says — the stack contract mandates node:22-alpine, which has this user.
      User: 'node',
      HostConfig: {
        NetworkMode: this.netName(slug),
        // §5: resource limits — sane defaults for a 2 vCPU / 4 GB box.
        Memory: 512 * 1024 * 1024,
        NanoCpus: 500_000_000, // 0.5 CPU
        PidsLimit: 256,
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        // No port publishing: only Caddy (same network) reaches the service.
      },
    });
    await container.start();
  }

  private async ensureNetwork(slug: string): Promise<void> {
    const name = this.netName(slug);
    const nets = await this.docker.listNetworks({ filters: { name: [name] } });
    if (!nets.some((n) => n.Name === name)) {
      await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: false });
    }
    // Caddy must reach the service; the daemon needs it for smoke-checks and
    // screenshots; Postgres serves the project's database. Attaching shared
    // infra to the per-project network keeps services isolated from each other.
    for (const member of [CADDY_CONTAINER, DAEMON_CONTAINER, PG_CONTAINER]) {
      await this.connectToNetwork(name, member);
    }
  }

  private async connectToNetwork(network: string, containerName: string): Promise<void> {
    try {
      await this.docker.getNetwork(network).connect({ Container: containerName });
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/already exists in network|already connected/i.test(msg)) {
        logger.warn('network connect failed', { network, containerName, error: msg });
      }
    }
  }

  private async removeNetwork(slug: string): Promise<void> {
    const name = this.netName(slug);
    const net = this.docker.getNetwork(name);
    for (const member of [CADDY_CONTAINER, DAEMON_CONTAINER, PG_CONTAINER]) {
      await net.disconnect({ Container: member, Force: true }).catch(() => {});
    }
    await net.remove().catch(() => {});
  }

  private async findProjectContainers(slug: string, runningOnly = false): Promise<string[]> {
    const list = await this.docker.listContainers({
      all: !runningOnly,
      filters: { label: [`botsman.project=${slug}`] },
    });
    return list.map((c) => c.Names[0]?.replace(/^\//, '') ?? c.Id);
  }

  private async removeContainer(name: string): Promise<void> {
    const c = this.docker.getContainer(name);
    await c.stop({ t: 5 }).catch(() => {});
    await c.remove({ force: true });
  }

  private async containerLogsByName(name: string, lines: number): Promise<string> {
    const c = this.docker.getContainer(name);
    const buf = (await c.logs({
      stdout: true,
      stderr: true,
      tail: lines,
      timestamps: false,
    })) as unknown as Buffer;
    return demuxDockerLogs(buf);
  }
}

/** Docker multiplexes stdout/stderr with 8-byte frame headers; strip them. */
export function demuxDockerLogs(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';
  // TTY containers return plain text; multiplexed streams start with 0x01/0x02.
  if (buf[0] !== 0x01 && buf[0] !== 0x02 && buf[0] !== 0x00) {
    return buf.toString('utf8');
  }
  let out = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    out += buf.subarray(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
  }
  return out;
}
