import type Dockerode from 'dockerode';
import type { StructuredLlm } from '../llm.js';
import type { Store } from '../db.js';
import type { DeployEngine } from '../deploy/engine.js';
import type { Orchestrator } from '../orchestrator.js';
import type { HostExec } from '../hostExec.js';
import { runDoctor } from '../doctor.js';

/**
 * DevOps room: free text → a FIXED catalog of operations. The LLM only picks an
 * op id + a slug arg; our code runs it. The model never emits shell (see
 * hostExec.ts). Read ops run immediately; mutating ops go through a confirm
 * button; host-level ops (self_update, host_update) need a second confirm.
 */
export type DevOpsOpId =
  // read — run immediately
  | 'host_metrics' | 'container_stats' | 'service_logs' | 'service_doctor' | 'project_list'
  // mutating — confirm button
  | 'restart_service' | 'redeploy_service' | 'rollback_service' | 'restart_proxy'
  | 'prune_docker' | 'self_update' | 'host_update';

/** Source of truth for which ops mutate and which need a second (host-level) confirm. */
export const OP_META: Record<DevOpsOpId, { mutating: boolean; hostLevel: boolean; needsSlug: boolean }> = {
  host_metrics:     { mutating: false, hostLevel: false, needsSlug: false },
  container_stats:  { mutating: false, hostLevel: false, needsSlug: false },
  service_logs:     { mutating: false, hostLevel: false, needsSlug: true },
  service_doctor:   { mutating: false, hostLevel: false, needsSlug: true },
  project_list:     { mutating: false, hostLevel: false, needsSlug: false },
  restart_service:  { mutating: true,  hostLevel: false, needsSlug: true },
  redeploy_service: { mutating: true,  hostLevel: false, needsSlug: true },
  rollback_service: { mutating: true,  hostLevel: false, needsSlug: true },
  restart_proxy:    { mutating: true,  hostLevel: false, needsSlug: false },
  prune_docker:     { mutating: true,  hostLevel: false, needsSlug: false },
  self_update:      { mutating: true,  hostLevel: true,  needsSlug: false },
  host_update:      { mutating: true,  hostLevel: true,  needsSlug: false },
};

const OP_IDS = Object.keys(OP_META) as DevOpsOpId[];

export interface DevOpsOp {
  op: DevOpsOpId;
  slug?: string;
  /** Plain-language description of what will happen, shown before a confirm. */
  humanSummary: string;
  mutating: boolean;
  hostLevel: boolean;
}

export interface DevOpsDeps {
  store: Store;
  docker: Dockerode;
  deployEngine: DeployEngine;
  orchestrator: Orchestrator;
  hostExec: HostExec;
  hostRepoDir: string;
}

const ROUTER_SYSTEM = `You are the DevOps router for a self-hosted deploy system. Map the user's message to ONE operation from this fixed list and reply with ONLY a JSON object {"op": "<id>", "slug": "<project-slug-or-empty>"}.

Operations:
- host_metrics: show server load, memory, disk
- container_stats: show running containers and their CPU/RAM
- service_logs: show a project's recent logs (needs slug)
- service_doctor: diagnose a project's health (needs slug)
- project_list: list all projects and statuses
- restart_service: restart a project's container (needs slug)
- redeploy_service: rebuild and redeploy a project (needs slug)
- rollback_service: roll a project back to its previous version (needs slug)
- restart_proxy: restart the reverse proxy (re-issues TLS)
- prune_docker: reclaim docker disk space
- self_update: update Botsman itself from git and restart
- host_update: update the host OS packages (apt upgrade)

Pick the single best match. If a slug is referenced, copy it exactly; otherwise use "". If nothing matches, reply {"op":"none"}.`;

interface RouterReply { op: string; slug?: string }

function validateRouterReply(raw: unknown): RouterReply | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== 'string') return null;
  return { op: r.op, slug: typeof r.slug === 'string' ? r.slug : undefined };
}

/** Free text → a validated DevOpsOp, or null (caller shows the op menu). */
export async function routeDevOps(
  llm: StructuredLlm,
  text: string,
  slugs: string[],
): Promise<DevOpsOp | null> {
  const reply = await llm({
    system: ROUTER_SYSTEM,
    user: `Projects: ${slugs.join(', ') || '(none)'}\nMessage: ${text}`,
    validate: validateRouterReply,
  });
  if (!reply) return null;
  const op = reply.op as DevOpsOpId;
  if (!OP_IDS.includes(op)) return null; // includes "none" and any hallucinated id
  const meta = OP_META[op];
  // Trust the catalog, not the model, for mutating/hostLevel.
  const slug = meta.needsSlug ? (reply.slug && slugs.includes(reply.slug) ? reply.slug : undefined) : undefined;
  return { op, slug, mutating: meta.mutating, hostLevel: meta.hostLevel, humanSummary: summarize(op, slug) };
}

export function summarize(op: DevOpsOpId, slug?: string): string {
  switch (op) {
    case 'host_metrics': return 'Show server load, memory and disk';
    case 'container_stats': return 'Show running containers and their resource use';
    case 'service_logs': return `Show recent logs for ${slug}`;
    case 'service_doctor': return `Diagnose ${slug}`;
    case 'project_list': return 'List all projects';
    case 'restart_service': return `Restart the service ${slug}`;
    case 'redeploy_service': return `Rebuild and redeploy ${slug}`;
    case 'rollback_service': return `Roll ${slug} back to the previous version`;
    case 'restart_proxy': return 'Restart the reverse proxy (re-issues TLS)';
    case 'prune_docker': return 'Reclaim docker disk space';
    case 'self_update': return '⚠️ Update Botsman from git and restart it (I will be back in ~30s)';
    case 'host_update': return '⚠️ Update the host OS packages (apt upgrade) — this changes the server';
  }
}

/** A read op needing a slug that wasn't resolved → ask for it. Returns null if fine. */
export function missingSlugPrompt(op: DevOpsOp): string | null {
  if (OP_META[op.op].needsSlug && !op.slug) {
    return `Which project? Say e.g. "${op.op.replace('_', ' ')} <name>".`;
  }
  return null;
}

export async function runReadOp(op: DevOpsOp, deps: DevOpsDeps): Promise<string> {
  switch (op.op) {
    case 'host_metrics': {
      const r = await deps.hostExec.hostMetrics();
      return r.ok ? '```\n' + r.output.slice(0, 3500) + '\n```' : `Could not read metrics: ${r.output}`;
    }
    case 'container_stats':
      return '```\n' + (await containerStats(deps.docker)).slice(0, 3500) + '\n```';
    case 'service_logs': {
      const logs = await deps.deployEngine.containerLogs(op.slug!, 50).catch((e) => `error: ${e.message}`);
      return `Logs for ${op.slug}:\n\`\`\`\n${logs.slice(-3500) || '(empty)'}\n\`\`\``;
    }
    case 'service_doctor': {
      const report = await runDoctor(op.slug!, deps.store, deps.deployEngine);
      return report ? `🩺 ${op.slug}\n\n${report.lines.join('\n')}` : `Project ${op.slug} not found.`;
    }
    case 'project_list': {
      const projects = deps.store.listProjects();
      if (!projects.length) return 'No projects yet.';
      const lines = await Promise.all(projects.map(async (p) => {
        const running = p.status === 'live' ? await deps.deployEngine.containerRunning(p.slug).catch(() => false) : false;
        const mark = p.status === 'live' ? (running ? '🟢' : '🟡') : '⚪️';
        return `${mark} ${p.slug} — ${p.status}\nhttps://${p.domain}/`;
      }));
      return lines.join('\n\n');
    }
    default:
      return 'Not a read operation.';
  }
}

export async function runMutatingOp(op: DevOpsOp, deps: DevOpsDeps): Promise<string> {
  switch (op.op) {
    case 'restart_service':
      await deps.deployEngine.restartService(op.slug!);
      return `✓ Restarted ${op.slug}.`;
    case 'redeploy_service': {
      const o = await deps.orchestrator.enqueue('redeploy', 'git push', () => {}, op.slug!);
      return o.ok ? `✓ Redeployed ${op.slug}.\n${o.url ?? ''}` : `✗ Redeploy failed: ${o.error}`;
    }
    case 'rollback_service': {
      const o = await deps.orchestrator.enqueue('rollback', 'rollback', () => {}, op.slug!);
      return o.ok ? `✓ Rolled ${op.slug} back.\n${o.url ?? ''}` : `✗ Rollback failed: ${o.error}`;
    }
    case 'restart_proxy':
      await deps.deployEngine.restartProxy();
      return '✓ Reverse proxy restarted — TLS issuance will be retried.';
    case 'prune_docker': {
      const r = await deps.hostExec.pruneDocker();
      return r.ok ? `✓ ${r.output}` : `✗ Prune failed: ${r.output}`;
    }
    case 'self_update': {
      const r = await deps.hostExec.selfUpdate(deps.hostRepoDir);
      return r.ok
        ? '✓ Update started — rebuilding and restarting. I will be back in ~30s.'
        : `✗ Self-update failed: ${r.output.slice(0, 500)}`;
    }
    case 'host_update': {
      const r = await deps.hostExec.hostPackageUpdate();
      return r.ok ? `✓ Host packages updated:\n\`\`\`\n${r.output.slice(-2000)}\n\`\`\`` : `✗ apt upgrade failed: ${r.output.slice(0, 500)}`;
    }
    default:
      return 'Not a mutating operation.';
  }
}

async function containerStats(docker: Dockerode): Promise<string> {
  const list = await docker.listContainers({ filters: { label: ['botsman.project'] } }).catch(() => []);
  if (!list.length) return '(no service containers running)';
  const rows = await Promise.all(list.map(async (c) => {
    const name = (c.Names[0] ?? c.Id).replace(/^\//, '');
    try {
      const s = await docker.getContainer(c.Id).stats({ stream: false }) as unknown as DockerStats;
      const cpu = cpuPercent(s);
      const memMb = Math.round((s.memory_stats?.usage ?? 0) / (1024 * 1024));
      return `${name}  cpu ${cpu.toFixed(1)}%  mem ${memMb}MB`;
    } catch {
      return `${name}  (stats unavailable)`;
    }
  }));
  return rows.join('\n');
}

interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number };
}

function cpuPercent(s: DockerStats): number {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus ?? 1;
  return sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
}

// --- project-room edit/question router -------------------------------------

export type ProjectRoute =
  | { kind: 'edit'; instruction: string }
  | { kind: 'question'; question: string };

const PROJECT_SYSTEM = `You classify a message about an existing deployed web service. Reply with ONLY {"kind":"edit"} or {"kind":"question"}.
- "edit": the user wants to CHANGE the service (add/remove/fix a feature, change text, style, behavior).
- "question": the user is ASKING about it (how it works, its status, what's in the logs, why something happens) without requesting a change.`;

/**
 * Decide whether a project-room message is an edit or a question. Falls back to
 * 'edit' on any LLM failure — preserving the core flow (a misrouted question
 * degrades to a harmless no-op edit, which editProject handles gracefully).
 */
export async function routeProjectMessage(llm: StructuredLlm | undefined, text: string): Promise<ProjectRoute> {
  if (!llm) return { kind: 'edit', instruction: text };
  const reply = await llm({
    system: PROJECT_SYSTEM,
    user: text,
    validate: (raw): { kind: 'edit' | 'question' } | null => {
      const k = (raw as { kind?: unknown })?.kind;
      return k === 'edit' || k === 'question' ? { kind: k } : null;
    },
  });
  if (reply?.kind === 'question') return { kind: 'question', question: text };
  return { kind: 'edit', instruction: text };
}
