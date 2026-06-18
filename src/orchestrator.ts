import fs from 'node:fs';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { paths } from './paths.js';
import { logger } from './logger.js';
import { Store } from './db.js';
import { slugFromDescription, uniqueSlug } from './slug.js';
import {
  initProjectRepo, commitAll, headCommit, checkoutCommit,
  ensureBareRepo, syncToBare, syncFromBare, syncFromBareIfAhead, log as gitLog,
} from './git.js';
import { AGENT_LABEL } from './agent/ClaudeCodeAgent.js';
import { serverPublicIp } from './doctor.js';
import { cloneUrl } from './clone.js';
import { scanForSecrets } from './deploy/secretScan.js';
import { dbNamesForSlug, generatePassword, dbEnvFor, type PostgresAdmin } from './deploy/postgres.js';
import { SERVICE_PORT, type DeployEngine } from './deploy/engine.js';
import type { CodingAgent } from './agent/CodingAgent.js';
import type { ProjectMeta, StageReporter, TaskKind } from './types.js';
import type { Telemetry } from './telemetry.js';

export interface TaskOutcome {
  ok: boolean;
  slug: string;
  url?: string;
  screenshotPath?: string | null;
  summary?: string;
  /** Non-fatal issue worth telling the user (e.g. public URL not answering yet). */
  warning?: string;
  /** API spend reported by the coding agent. */
  costUsd?: number;
  error?: string;
}

interface QueueItem {
  kind: TaskKind;
  slug?: string;
  instruction: string;
  report: StageReporter;
  resolve: (o: TaskOutcome) => void;
}

/**
 * Orchestrator (§2): owns the project lifecycle. Tasks run strictly one at a
 * time — a single-user system doesn't need more, and serialization avoids
 * docker/caddy races.
 */
export class Orchestrator {
  private queue: QueueItem[] = [];
  private running = false;

  constructor(
    private store: Store,
    private agent: CodingAgent,
    private deployEngine: DeployEngine,
    private pgAdmin: PostgresAdmin,
    private baseDomain: string,
    private controlUrl: string,
    private controlToken: string,
    private telemetry: Telemetry,
    /** Optional LLM-based namer; falls back to the transliteration heuristic. */
    private suggestName?: (description: string) => Promise<string | null>,
  ) {}

  get queueLength(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  enqueue(kind: TaskKind, instruction: string, report: StageReporter, slug?: string): Promise<TaskOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ kind, slug, instruction, report, resolve });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        let outcome: TaskOutcome;
        try {
          outcome = await this.execute(item);
        } catch (e) {
          logger.error('task crashed', { error: (e as Error).stack });
          outcome = { ok: false, slug: item.slug ?? '?', error: (e as Error).message };
        }
        item.resolve(outcome);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(item: QueueItem): Promise<TaskOutcome> {
    switch (item.kind) {
      case 'create': return this.createProject(item.instruction, item.report);
      case 'resume': return this.resumeCreate(item.slug!, item.report);
      case 'edit': return this.editProject(item.slug!, item.instruction, item.report);
      case 'rollback': return this.rollbackProject(item.slug!, item.report);
      case 'delete': return this.deleteProject(item.slug!);
      case 'redeploy': return this.redeployFromPush(item.slug!, item.report);
    }
  }

  // --- create (§1 happy path) ---

  private async createProject(description: string, report: StageReporter): Promise<TaskOutcome> {
    const suggested = this.suggestName ? await this.suggestName(description).catch(() => null) : null;
    const base = suggested ?? slugFromDescription(description);
    const slug = uniqueSlug(base, (s) => this.store.projectExists(s));

    const { dbName, dbUser } = dbNamesForSlug(slug);
    const project = this.store.createProject({
      slug,
      name: slug,
      description,
      status: 'creating',
      domain: `${slug}.${this.baseDomain}`,
      internalPort: SERVICE_PORT,
      currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
      dbName, dbUser, dbPassword: generatePassword(),
    });
    return this.buildNewProject(project, description, report);
  }

  /**
   * Resume a create that a daemon restart interrupted. The project row, repo and
   * database already exist; we rebuild from the ORIGINAL description stored on
   * the project — so the agent gets the real request, not whatever the user
   * happened to type after the restart (which is how the original intent got
   * lost and a wrong app got built).
   */
  async resumeCreate(slug: string, report: StageReporter): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Project ${slug} not found.` };
    return this.buildNewProject(project, project.description, report);
  }

  /** The create build pipeline, shared by a fresh create and a resumed one. */
  private async buildNewProject(
    project: ProjectMeta,
    description: string,
    report: StageReporter,
  ): Promise<TaskOutcome> {
    const slug = project.slug;
    const task = this.store.createTask(slug, 'create', description);
    this.store.setStatus(slug, 'creating');
    report('accepted', slug);

    try {
      await initProjectRepo(slug);
      seedProjectMemory(slug, description);
      await this.pgAdmin.ensureProjectDb(project);

      report('generating');
      const gen = await this.runAgentWithSecretGuard(slug, description, 'create', report);
      if (!gen.ok) {
        this.store.setStatus(slug, 'failed');
        this.store.finishTask(task.id, 'failed', undefined, gen.error);
        return { ok: false, slug, error: gen.error, costUsd: gen.costUsd };
      }

      report('committing');
      const commit = await commitAll(slug, description);
      if (!commit) {
        const err = 'The agent did not create any files. Try rephrasing the request.';
        this.store.setStatus(slug, 'failed');
        this.store.finishTask(task.id, 'failed', undefined, err);
        return { ok: false, slug, error: err, costUsd: gen.costUsd };
      }
      // The agent reported success but left only the seeded .gitignore/CLAUDE.md
      // — it produced no application files at all. commitAll still returns a
      // commit (the seeds are new), so the "no files" check above can't catch
      // this. Fail with a clear message instead of deploying an empty project.
      if (!agentProducedAppFiles(slug)) {
        const err =
          'The agent finished without creating any application files. ' +
          'Try rephrasing the request with a bit more detail about what to build.';
        this.store.setStatus(slug, 'failed');
        this.store.finishTask(task.id, 'failed', gen.summary, err);
        return { ok: false, slug, error: err, summary: gen.summary, costUsd: gen.costUsd };
      }
      await ensureBareRepo(slug, this.controlUrl, this.controlToken);
      await syncToBare(slug);

      const deployed = await this.deployCommit(project, commit, report);
      if (!deployed.ok) {
        this.store.finishTask(task.id, 'failed', gen.summary, deployed.error);
        return { ok: false, slug, error: deployed.error, summary: gen.summary, costUsd: gen.costUsd };
      }
      this.store.finishTask(task.id, 'done', gen.summary);
      await this.telemetry.onFirstDeploy();
      report('done');
      return {
        ok: true, slug, url: deployed.url, screenshotPath: deployed.screenshotPath,
        summary: gen.summary, warning: deployed.warning, costUsd: gen.costUsd,
      };
    } catch (e) {
      this.store.setStatus(slug, 'failed');
      this.store.finishTask(task.id, 'failed', undefined, (e as Error).message);
      return { ok: false, slug, error: (e as Error).message };
    }
  }

  // --- edit (§1 iteration) ---

  private async editProject(slug: string, instruction: string, report: StageReporter): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Project ${slug} not found.` };
    const task = this.store.createTask(slug, 'edit', instruction);
    report('accepted', slug);

    // Pick up commits the user pushed since the last deploy; refuse to work on
    // top of a diverged history (the force-push later would discard their work).
    const sync = await syncFromBareIfAhead(slug).catch(() => 'none' as const);
    if (sync === 'diverged') {
      const err =
        'Git history has diverged: the repo has both your commits and mine that the other side is missing. ' +
        'Run git pull/rebase and git push in the project repo, then retry.';
      this.store.finishTask(task.id, 'failed', undefined, err);
      return { ok: false, slug, error: err };
    }

    const commitBefore = await headCommit(slug);
    try {
      report('generating');
      const gen = await this.runAgentWithSecretGuard(slug, instruction, 'edit', report);
      if (!gen.ok) {
        // Working tree may be half-edited: restore the deployed state.
        if (commitBefore) await checkoutCommit(slug, commitBefore);
        this.store.finishTask(task.id, 'failed', undefined, gen.error);
        return { ok: false, slug, error: gen.error };
      }

      report('committing');
      const commit = await commitAll(slug, instruction);
      if (!commit) {
        this.store.finishTask(task.id, 'done', gen.summary ?? 'No changes were needed.');
        return {
          ok: true, slug, url: `https://${project.domain}/`,
          summary: gen.summary ?? 'The agent made no changes.', costUsd: gen.costUsd,
        };
      }
      await syncToBare(slug);

      const deployed = await this.deployCommit(project, commit, report);
      if (!deployed.ok) {
        // AC-C2: failed deploy must not kill the live version — the engine
        // never switched the route; just record the failure.
        this.store.setStatus(slug, project.currentImage ? 'live' : 'failed');
        this.store.finishTask(task.id, 'failed', gen.summary, deployed.error);
        return {
          ok: false, slug, summary: gen.summary, costUsd: gen.costUsd,
          error: `${deployed.error}\n\nThe live version is untouched and still serving.`,
        };
      }
      this.store.finishTask(task.id, 'done', gen.summary);
      report('done');
      return {
        ok: true, slug, url: deployed.url, screenshotPath: deployed.screenshotPath,
        summary: gen.summary, warning: deployed.warning, costUsd: gen.costUsd,
      };
    } catch (e) {
      this.store.finishTask(task.id, 'failed', undefined, (e as Error).message);
      return { ok: false, slug, error: (e as Error).message };
    }
  }

  // --- rollback (AC-C3) ---

  private async rollbackProject(slug: string, report: StageReporter): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Project ${slug} not found.` };
    const task = this.store.createTask(slug, 'rollback', 'rollback');
    const res = await this.deployEngine.rollback(project, report);
    if (!res.ok) {
      this.store.finishTask(task.id, 'failed', undefined, res.error);
      return { ok: false, slug, error: res.error };
    }
    if (project.prevCommit) await checkoutCommit(slug, project.prevCommit).catch(() => {});
    await syncToBare(slug).catch(() => {});
    this.store.updateProject(slug, {
      status: 'live',
      currentCommit: project.prevCommit,
      currentImage: project.prevImage,
      prevCommit: project.currentCommit,
      prevImage: project.currentImage,
    });
    this.store.finishTask(task.id, 'done', 'rolled back');
    return { ok: true, slug, url: res.url, summary: 'Rolled back to the previous working version.' };
  }

  // --- delete ---

  private async deleteProject(slug: string): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Project ${slug} not found.` };
    await this.deployEngine.remove(project);
    await this.pgAdmin.dropProjectDb(project).catch((e) =>
      logger.warn('db drop failed', { slug, error: String(e) }));
    fs.rmSync(paths.projectDir(slug), { recursive: true, force: true });
    fs.rmSync(paths.bareRepo(slug), { recursive: true, force: true });
    this.store.deleteProject(slug);
    return { ok: true, slug, summary: `Project ${slug} stopped and removed.` };
  }

  // --- push-to-deploy (AC-E1) ---

  private async redeployFromPush(slug: string, report: StageReporter): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Project ${slug} not found.` };
    const task = this.store.createTask(slug, 'redeploy', 'git push');
    report('accepted', slug);
    try {
      const commit = await syncFromBare(slug);
      if (!commit) throw new Error('Could not read the pushed commit from the bare repository.');
      // A push with no new commits (or a re-push of the deployed commit) is a no-op.
      if (commit === project.currentCommit && await this.deployEngine.containerRunning(slug)) {
        this.store.finishTask(task.id, 'done', 'already up to date');
        return { ok: true, slug, url: `https://${project.domain}/`, summary: 'Already up to date — the pushed commit is live.' };
      }
      const deployed = await this.deployCommit(project, commit, report);
      this.store.finishTask(task.id, deployed.ok ? 'done' : 'failed', undefined, deployed.error);
      return deployed.ok
        ? { ok: true, slug, url: deployed.url, screenshotPath: deployed.screenshotPath, summary: 'Redeployed from git push.' }
        : { ok: false, slug, error: deployed.error };
    } catch (e) {
      this.store.finishTask(task.id, 'failed', undefined, (e as Error).message);
      return { ok: false, slug, error: (e as Error).message };
    }
  }

  // --- shared pipeline pieces ---

  /** Agent run + secret scan with ONE corrective retry, then hard fail (AC-B5). */
  private async runAgentWithSecretGuard(
    slug: string,
    instruction: string,
    mode: 'create' | 'edit',
    report: StageReporter,
  ): Promise<{ ok: boolean; summary?: string; error?: string; costUsd?: number }> {
    const project = this.store.getProject(slug)!;
    const dir = paths.projectDir(slug);
    const context = [
      `Project slug: ${slug}. Public URL after deploy: https://${project.domain}/`,
      `Postgres is available; env vars at runtime: ${Object.keys(dbEnvFor(project)).join(', ')}.`,
    ];
    // Layer-2 continuity: hand the agent its last completed change so it has
    // immediate context even before reading CLAUDE.md (cheap, ~1 line).
    const lastDone = this.store.tasksForProject(slug).find((t) => t.status === 'done' && t.summary);
    if (lastDone?.summary) {
      context.push(`Most recent completed change: ${lastDone.summary.slice(0, 500)}`);
    }
    const run = await this.agent.run({ projectDir: dir, instruction, mode, context });
    let costUsd = run.costUsd ?? 0;
    if (!run.ok) return { ok: false, error: run.error, costUsd: costUsd || undefined };

    let findings = scanForSecrets(dir);
    if (findings.length) {
      report('generating', 'hardcoded secrets found, asking the agent to remove them');
      const fixRun = await this.agent.run({
        projectDir: dir,
        mode: 'edit',
        instruction:
          'Security check failed: hardcoded secrets were detected in these files: ' +
          findings.map((f) => `${f.file} (${f.pattern})`).join(', ') +
          '. Remove them and read these values from environment variables instead. Do not change anything else.',
      });
      costUsd += fixRun.costUsd ?? 0;
      if (!fixRun.ok) {
        return { ok: false, error: `Secrets in the code and the automatic fix failed: ${fixRun.error}`, costUsd: costUsd || undefined };
      }
      findings = scanForSecrets(dir);
      if (findings.length) {
        return {
          ok: false,
          error: 'Generated code still contains hardcoded secrets: ' +
            findings.map((f) => f.file).join(', ') + '. Deploy cancelled.',
          costUsd: costUsd || undefined,
        };
      }
    }
    capProjectMemory(slug); // keep CLAUDE.md from growing unbounded (soft, never fails)
    return { ok: true, summary: run.summary, costUsd: costUsd || undefined };
  }

  private async deployCommit(
    project: ProjectMeta,
    commit: string,
    report: StageReporter,
  ): Promise<{ ok: boolean; url?: string; screenshotPath?: string | null; warning?: string; error?: string }> {
    this.store.setStatus(project.slug, 'building');
    const res = await this.deployEngine.deploy(project, commit, report);
    if (!res.ok) {
      this.store.setStatus(project.slug, project.currentImage ? 'live' : 'failed');
      return { ok: false, error: res.error };
    }
    this.store.updateProject(project.slug, {
      status: 'live',
      prevCommit: project.currentCommit,
      prevImage: project.currentImage,
      currentCommit: commit,
      currentImage: res.image ?? null,
    });
    // GC per-commit images: keep only the new current and the rollback target.
    await this.deployEngine
      .cleanupImages(project.slug, [res.image, project.currentImage])
      .catch((e) => logger.warn('image gc failed', { slug: project.slug, error: String(e) }));
    return { ok: true, url: res.url, screenshotPath: res.screenshotPath, warning: res.publicWarning };
  }

  // --- startup reconciliation (a daemon restart must not leave ghosts) ---

  /**
   * Called once at startup: fail tasks interrupted by the restart, normalize
   * stuck project statuses (creating/building/deploying → live or failed),
   * refresh post-receive hooks (control token may have rotated) and remove
   * orphaned agent containers. Returns human-readable notes for the owner.
   */
  async reconcileOnStartup(
    docker: Dockerode,
  ): Promise<{ notes: string[]; resumable: Array<{ slug: string; instruction: string }> }> {
    const notes: string[] = [];
    const interrupted = this.store.failInterruptedTasks();
    if (interrupted.length > 0) {
      notes.push(`tasks interrupted by the restart: ${interrupted.length}`);
    }
    for (const p of this.store.listProjects()) {
      if (p.status === 'creating' || p.status === 'building' || p.status === 'deploying') {
        const next = p.currentImage ? 'live' : 'failed';
        this.store.setStatus(p.slug, next);
        // Don't claim "live" if the container isn't actually up — surface it so
        // the owner can /doctor it instead of trusting a stale promotion.
        const running = next === 'live'
          ? await this.deployEngine.containerRunning(p.slug).catch(() => false)
          : false;
        const suffix = next === 'live' && !running ? ' (container down — run /doctor)' : '';
        notes.push(`${p.slug}: status ${p.status} → ${next}${suffix}`);
      }
      await ensureBareRepo(p.slug, this.controlUrl, this.controlToken).catch((e) =>
        logger.warn('hook refresh failed', { slug: p.slug, error: String(e) }));
    }
    // An interrupted CREATE whose project row still exists can be resumed from
    // its original instruction — the caller offers the owner a one-tap resume.
    const resumable = interrupted
      .filter((t) => t.kind === 'create' && !!this.store.getProject(t.projectSlug))
      .map((t) => ({ slug: t.projectSlug, instruction: t.instruction }));
    try {
      const orphans = await docker.listContainers({ all: true, filters: { label: [AGENT_LABEL] } });
      for (const c of orphans) {
        await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
      }
      if (orphans.length) notes.push(`removed stale agent containers: ${orphans.length}`);
    } catch (e) {
      logger.warn('agent container cleanup failed', { error: String(e) });
    }
    return { notes, resumable };
  }

  // --- queries used by the gateway ---

  /**
   * Answer a QUESTION about a project (project-room chat). Runs the agent in
   * read-only 'ask' mode and returns its text — NEVER commits or deploys. Runs
   * outside the serialized task queue (no write race), so questions stay snappy
   * even while a deploy is in flight.
   */
  async askProject(slug: string, question: string): Promise<{ ok: boolean; answer: string; costUsd?: number }> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, answer: `Project ${slug} not found.` };
    const logs = await this.deployEngine.containerLogs(slug, 40).catch(() => '');
    const context = [
      `Project slug: ${slug}. Public URL: https://${project.domain}/`,
      logs ? `Recent container logs (last lines):\n${logs.slice(-2000)}` : '',
    ].filter(Boolean);
    const run = await this.agent.run({
      projectDir: paths.projectDir(slug),
      instruction: question,
      mode: 'ask',
      context,
    });
    return run.ok
      ? { ok: true, answer: run.summary, costUsd: run.costUsd }
      : { ok: false, answer: run.error ?? 'Could not answer the question.' };
  }

  async statusText(slug: string): Promise<string | null> {
    const p = this.store.getProject(slug);
    if (!p) return null;
    const running = await this.deployEngine.containerRunning(slug).catch(() => false);
    const history = await gitLog(slug, 5).catch(() => '(no history)');
    // Fill in the SSH user + public IP so the clone command is (almost)
    // copy-paste — same builder as the 💻 Claude Code flow. '~/.botsman' (NOT
    // the container's /data) when the host path isn't set.
    const hostHome = process.env.BOTSMAN_HOST_DIR ?? '~/.botsman';
    const host = (await serverPublicIp()) ?? '<server>';
    const clone = cloneUrl({ slug, hostHome, host });
    return [
      `*${p.slug}* — ${p.status}${p.status === 'live' && !running ? ' ⚠️ container is down' : ''}`,
      `URL: https://${p.domain}/`,
      `Commit: ${p.currentCommit?.slice(0, 8) ?? '—'}`,
      `Created: ${p.createdAt.slice(0, 16).replace('T', ' ')}`,
      '',
      'Recent commits:',
      '```', history, '```',
      `Clone: \`git clone ${clone}\``,
      'A `git push` redeploys the project automatically.',
    ].join('\n');
  }
}

export const MEMORY_FILE = 'CLAUDE.md';
const MEMORY_MAX_LINES = 300;
const MEMORY_MAX_BYTES = 16 * 1024;

/**
 * Did the agent produce any application files, or just the seeds the
 * orchestrator wrote before it ran (.gitignore, CLAUDE.md)? A tree that is
 * exactly the seeds means the agent created nothing — deploying it would build
 * an empty project. The narrower "no package.json/Dockerfile" case is caught
 * later by the deploy engine with its own clear message.
 */
function agentProducedAppFiles(slug: string): boolean {
  const seeds = new Set(['.git', '.gitignore', MEMORY_FILE]);
  try {
    return fs.readdirSync(paths.projectDir(slug)).some((name) => !seeds.has(name));
  } catch {
    return false;
  }
}

/**
 * Seed the project's memory file so it exists from the very first agent run
 * (claude -p auto-loads /work/CLAUDE.md). The agent enriches/prunes it per the
 * PROJECT MEMORY system-prompt section; commitAll persists it in git.
 */
function seedProjectMemory(slug: string, description: string): void {
  const file = path.join(paths.projectDir(slug), MEMORY_FILE);
  if (fs.existsSync(file)) return; // never clobber an existing memory
  const body = [
    `# ${slug}`,
    '',
    "Botsman project memory. Auto-loaded into the coding agent's context every run.",
    'Keep it concise and current; never put secrets, credentials or connection strings here.',
    '',
    '## What this service is',
    description.trim() || '(to be filled in)',
    '',
    '## Decisions & constraints',
    '(none yet)',
    '',
    '## Conventions & preferences',
    '(none yet)',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(file, body);
  } catch (e) {
    logger.warn('failed to seed project memory', { slug, error: (e as Error).message });
  }
}

/**
 * Soft cap on memory size: if the agent let CLAUDE.md grow too large, truncate
 * it (never fail the deploy — memory is not safety-critical and self-heals when
 * the agent re-curates next run).
 */
function capProjectMemory(slug: string): void {
  const file = path.join(paths.projectDir(slug), MEMORY_FILE);
  try {
    if (!fs.existsSync(file)) return;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    if (content.length <= MEMORY_MAX_BYTES && lines.length <= MEMORY_MAX_LINES) return;
    const trimmed = lines.slice(0, MEMORY_MAX_LINES).join('\n').slice(0, MEMORY_MAX_BYTES);
    fs.writeFileSync(file, trimmed + '\n\n<!-- truncated by botsman: keep CLAUDE.md concise -->\n');
    logger.warn('project memory truncated', { slug, lines: lines.length, bytes: content.length });
  } catch (e) {
    logger.warn('failed to cap project memory', { slug, error: (e as Error).message });
  }
}
