import fs from 'node:fs';
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
    const task = this.store.createTask(slug, 'create', description);
    report('accepted', slug);

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

    try {
      await initProjectRepo(slug);
      await this.pgAdmin.ensureProjectDb(project);

      report('generating');
      const gen = await this.runAgentWithSecretGuard(slug, description, 'create', report);
      if (!gen.ok) {
        this.store.setStatus(slug, 'failed');
        this.store.finishTask(task.id, 'failed', undefined, gen.error);
        return { ok: false, slug, error: gen.error };
      }

      report('committing');
      const commit = await commitAll(slug, description);
      if (!commit) {
        const err = 'Агент не создал ни одного файла. Попробуйте переформулировать запрос.';
        this.store.setStatus(slug, 'failed');
        this.store.finishTask(task.id, 'failed', undefined, err);
        return { ok: false, slug, error: err, costUsd: gen.costUsd };
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
    if (!project) return { ok: false, slug, error: `Проект ${slug} не найден.` };
    const task = this.store.createTask(slug, 'edit', instruction);
    report('accepted', slug);

    // Pick up commits the user pushed since the last deploy; refuse to work on
    // top of a diverged history (the force-push later would discard their work).
    const sync = await syncFromBareIfAhead(slug).catch(() => 'none' as const);
    if (sync === 'diverged') {
      const err =
        'История git разошлась: в репозитории есть и ваши, и мои коммиты, которых нет друг у друга. ' +
        'Сделайте git pull/rebase и git push в проектный репозиторий, потом повторите запрос.';
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
        this.store.finishTask(task.id, 'done', gen.summary ?? 'Изменений не потребовалось.');
        return {
          ok: true, slug, url: `https://${project.domain}/`,
          summary: gen.summary ?? 'Агент не внёс изменений.', costUsd: gen.costUsd,
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
          error: `${deployed.error}\n\nРабочая версия не тронута и продолжает отвечать.`,
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
    if (!project) return { ok: false, slug, error: `Проект ${slug} не найден.` };
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
    return { ok: true, slug, url: res.url, summary: 'Откатил на предыдущую рабочую версию.' };
  }

  // --- delete ---

  private async deleteProject(slug: string): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Проект ${slug} не найден.` };
    await this.deployEngine.remove(project);
    await this.pgAdmin.dropProjectDb(project).catch((e) =>
      logger.warn('db drop failed', { slug, error: String(e) }));
    fs.rmSync(paths.projectDir(slug), { recursive: true, force: true });
    fs.rmSync(paths.bareRepo(slug), { recursive: true, force: true });
    this.store.deleteProject(slug);
    return { ok: true, slug, summary: `Проект ${slug} остановлен и удалён.` };
  }

  // --- push-to-deploy (AC-E1) ---

  private async redeployFromPush(slug: string, report: StageReporter): Promise<TaskOutcome> {
    const project = this.store.getProject(slug);
    if (!project) return { ok: false, slug, error: `Проект ${slug} не найден.` };
    const task = this.store.createTask(slug, 'redeploy', 'git push');
    report('accepted', slug);
    try {
      const commit = await syncFromBare(slug);
      if (!commit) throw new Error('Не удалось получить коммит из bare-репозитория.');
      const deployed = await this.deployCommit(project, commit, report);
      this.store.finishTask(task.id, deployed.ok ? 'done' : 'failed', undefined, deployed.error);
      return deployed.ok
        ? { ok: true, slug, url: deployed.url, screenshotPath: deployed.screenshotPath, summary: 'Передеплоил из git push.' }
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
    const run = await this.agent.run({ projectDir: dir, instruction, mode, context });
    let costUsd = run.costUsd ?? 0;
    if (!run.ok) return { ok: false, error: run.error, costUsd: costUsd || undefined };

    let findings = scanForSecrets(dir);
    if (findings.length) {
      report('generating', 'найдены захардкоженные секреты, прошу агента убрать');
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
        return { ok: false, error: `Секреты в коде, авто-исправление не удалось: ${fixRun.error}`, costUsd: costUsd || undefined };
      }
      findings = scanForSecrets(dir);
      if (findings.length) {
        return {
          ok: false,
          error: 'В сгенерированном коде остались захардкоженные секреты: ' +
            findings.map((f) => f.file).join(', ') + '. Деплой отменён.',
          costUsd: costUsd || undefined,
        };
      }
    }
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
  async reconcileOnStartup(docker: Dockerode): Promise<string[]> {
    const notes: string[] = [];
    const interrupted = this.store.failInterruptedTasks();
    if (interrupted > 0) {
      notes.push(`задач прервано перезапуском демона: ${interrupted}`);
    }
    for (const p of this.store.listProjects()) {
      if (p.status === 'creating' || p.status === 'building' || p.status === 'deploying') {
        const next = p.currentImage ? 'live' : 'failed';
        this.store.setStatus(p.slug, next);
        notes.push(`${p.slug}: статус ${p.status} → ${next}`);
      }
      await ensureBareRepo(p.slug, this.controlUrl, this.controlToken).catch((e) =>
        logger.warn('hook refresh failed', { slug: p.slug, error: String(e) }));
    }
    try {
      const orphans = await docker.listContainers({ all: true, filters: { label: [AGENT_LABEL] } });
      for (const c of orphans) {
        await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
      }
      if (orphans.length) notes.push(`удалено зависших контейнеров агента: ${orphans.length}`);
    } catch (e) {
      logger.warn('agent container cleanup failed', { error: String(e) });
    }
    return notes;
  }

  // --- queries used by the gateway ---

  async statusText(slug: string): Promise<string | null> {
    const p = this.store.getProject(slug);
    if (!p) return null;
    const running = await this.deployEngine.containerRunning(slug).catch(() => false);
    const history = await gitLog(slug, 5).catch(() => '(нет истории)');
    // The repo path as seen on the HOST (we run in a container where it is /data/...).
    const hostHome = process.env.BOTSMAN_HOST_DIR ?? paths.home();
    const cloneUrl = `<user>@<server>:${hostHome}/repos/${slug}.git`;
    return [
      `*${p.slug}* — ${p.status}${p.status === 'live' && !running ? ' ⚠️ контейнер не работает' : ''}`,
      `URL: https://${p.domain}/`,
      `Коммит: ${p.currentCommit?.slice(0, 8) ?? '—'}`,
      `Создан: ${p.createdAt.slice(0, 16).replace('T', ' ')}`,
      '',
      'Последние коммиты:',
      '```', history, '```',
      `Клонировать: \`git clone ${cloneUrl}\``,
      'После `git push` проект передеплоится автоматически.',
    ].join('\n');
  }
}
