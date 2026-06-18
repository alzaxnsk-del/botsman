import type Dockerode from 'dockerode';
import type { StructuredLlm } from '../llm.js';
import type { Store } from '../db.js';
import type { DeployEngine } from '../deploy/engine.js';
import type { Orchestrator } from '../orchestrator.js';
import type { HostExec } from '../hostExec.js';
import { runDoctor } from '../doctor.js';
import { RESTART_NOTICE_KEY } from '../types.js';

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

/** Mutable confirm state for one pending DevOps op (kept server-side per chat). */
export interface PendingDevOps {
  op: DevOpsOp;
  /** True only once a host-level op's second-confirm warning is actually on screen. */
  confirmed: boolean;
}

/** IO seam for the confirm state machine — real impl wraps grammy; tests inject fakes. */
export interface ConfirmIO {
  /** answer the callback query (optional toast text). */
  answer: (text?: string) => Promise<void>;
  /** render the host "are you sure?" warning + second-confirm keyboard; return true iff it rendered. */
  renderWarning: (text: string) => Promise<boolean>;
  /** show the "⏳ running" state. */
  showRunning: (text: string) => Promise<void>;
  /** actually run the op; returns the result text. */
  execute: () => Promise<string>;
  /** render the final result. */
  showResult: (text: string) => Promise<void>;
  /** drop the pending entry (single-flight). */
  clearPending: () => void;
}

/**
 * DevOps confirm state machine (cancel handled by the caller). Host-level ops
 * need TWO confirms; `confirmed` is set ONLY after the warning is actually
 * rendered, so a failed edit can never collapse the gate into a double-tap of
 * the still-visible Execute button. Execution is gated on `confirmed` for host
 * ops — never on the callback-data string — so a crafted/replayed `exec2`
 * can't skip the warning.
 */
export async function runDevOpsConfirm(entry: PendingDevOps, data: string, io: ConfirmIO): Promise<void> {
  if (entry.op.hostLevel && !entry.confirmed) {
    if (data !== 'devops:exec') {
      // exec2 (or anything) before the warning was ever shown → reject.
      await io.answer('Tap Execute first.');
      return;
    }
    const rendered = await io.renderWarning(
      `${entry.op.humanSummary}\n\nThis touches the host. Are you sure?`,
    );
    if (rendered) entry.confirmed = true; // only once the warning is on screen
    await io.answer(rendered ? undefined : 'Please tap Execute again to confirm.');
    return;
  }
  // Non-host mutating op (single confirm), or host op whose 2nd confirm landed.
  entry.confirmed = true;
  io.clearPending();
  await io.answer('Working…');
  await io.showRunning(`⏳ ${entry.op.humanSummary}…`);
  const result = await io.execute();
  await io.showResult(result);
}

export interface DevOpsDeps {
  store: Store;
  docker: Dockerode;
  deployEngine: DeployEngine;
  orchestrator: Orchestrator;
  hostExec: HostExec;
  hostRepoDir: string;
}

/**
 * Cheap deterministic guard: does the message look like a SERVER/operations
 * request rather than authoring? Used to (a) skip the create/edit fast-path and
 * (b) pick the right fallback when the LLM is unavailable. It only decides
 * "this is operational, ask the catalog" — never the action itself.
 */
// Liberal on purpose: a false positive only costs one LLM call (the router
// then re-classifies correctly); a false NEGATIVE is dangerous because it lets
// the no-LLM fast-path auto-deploy an op as a code edit. So over-match.
const OP_VERBS = /(^|\s)(restart|reboot|redeploy|re-?deploy|rebuild|roll\s?back|logs?|metrics|load|cpu|ram|memory|disk|doctor|diagnose|prune|clean\s?up|update|upgrade|stop|kill|pause|shut\s?down|take\s?down|turn\s?off|bounce|disable|status|перезапус|перезагруз|передепло|пересобер|откат|логи?|нагрузк|памят|диск|диагност|очист|обнов|останов|выключ|пауз|статус)/i;
const PROXY_TLS = /(proxy|tls|ssl|cert|сертификат|прокси)/i;

export function looksOperational(text: string): boolean {
  return OP_VERBS.test(text) || PROXY_TLS.test(text);
}

// --- unified message router (soft context) ---------------------------------

export type Route =
  | { kind: 'create'; description: string; confidence?: 'low' }
  | { kind: 'edit'; slug: string; instruction: string; confidence?: 'low' }
  | { kind: 'question'; slug: string; question: string; confidence?: 'low' }
  | { kind: 'delete'; slug: string }
  | { kind: 'devops'; op: DevOpsOp }
  | { kind: 'none' };

const ROUTER_SYSTEM = `You route a message in a self-hosted "describe a web service → it gets built and deployed" system. Reply with ONLY a JSON object: {"kind":…, "slug":"<project-or-empty>", "op":"<id-or-omit>", "confidence":"high"|"low"}.

Actions:
- {"kind":"create"} — the user wants a NEW service built from a description.
- {"kind":"edit","slug":"<project>"} — CHANGE an existing service (add/fix/remove a feature, restyle, change behavior).
- {"kind":"question","slug":"<project>"} — ASK about an existing service (how it works, its status, what's in the logs) WITHOUT changing it.
- {"kind":"delete","slug":"<project>"} — the user wants to DELETE/remove an existing service ("удали X", "delete X", "remove the X project"). The system will ask for confirmation.
- {"kind":"devops","op":"<id>","slug":"<project-or-empty>"} — a SERVER/operations action. op is one of:
    host_metrics (server load/mem/disk), container_stats, service_logs (slug), service_doctor (slug),
    project_list, restart_service (slug), redeploy_service (slug), rollback_service (slug),
    restart_proxy, prune_docker (reclaim disk), self_update (update Botsman), host_update (apt upgrade).

Rules:
- Pick the single best action. Copy a referenced project slug EXACTLY from the list.
- A message about fixing, reviewing, improving, or reporting a problem ("it's broken", "crashes", "white screen", "works poorly") with an EXISTING service is an EDIT (or question) of THAT service — NOT a new project. Choose "create" ONLY for a clearly new, different service.
- Project references may be fuzzy or transliterated — e.g. «тамагочи» / "tamagochi" refers to an existing "tamagotchi-web-app". Match the message to the closest existing project before considering create.
- If a project is CONNECTED (see below), the user is actively working on it: edits and questions almost always refer to it — use it and set confidence "high".
- confidence: "high" when you are sure. "low" when you are NOT sure whether it is a new project vs a change to an existing one, or which project it refers to. When unsure, still give your best guess for kind/slug but mark confidence "low" so the system can confirm.
- If the user clearly means the connected project but doesn't name it, use it; otherwise use "". If nothing fits, reply {"kind":"none"}.`;

interface RouterReply { kind: string; op?: string; slug?: string; confidence?: 'high' | 'low' }

function validateRouterReply(raw: unknown): RouterReply | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string') return null;
  return {
    kind: r.kind,
    op: typeof r.op === 'string' ? r.op : undefined,
    slug: typeof r.slug === 'string' ? r.slug : undefined,
    confidence: r.confidence === 'low' ? 'low' : 'high',
  };
}

/**
 * One LLM call mapping free text → a routed action. Reused for the whole
 * "ambiguous tail" (authoring that the heuristic couldn't classify, or anything
 * operational). Returns {kind:'none'} on failure so the caller can fall back.
 * Confirmation policy for devops ops is always re-derived from OP_META, never
 * from the model.
 */
export async function routeMessage(
  llm: StructuredLlm,
  text: string,
  slugs: string[],
  focusedSlug: string | null,
  serverContext = false,
): Promise<Route> {
  // In the 🛠 Server room, bias the model toward devops ops: bare/ambiguous or
  // operational messages are server actions there, not new projects.
  const contextLine = serverContext
    ? 'The user is in the SERVER/admin context: prefer a devops op for operational or ambiguous messages; choose create/edit/question ONLY if the message clearly describes building or changing an app.\n'
    : '';
  const reply = await llm({
    system: ROUTER_SYSTEM,
    user: `Projects: ${slugs.join(', ') || '(none)'}\nConnected project: ${focusedSlug ?? '(none)'}\n${contextLine}Message: ${text}`,
    validate: validateRouterReply,
  });
  if (!reply) return { kind: 'none' };

  const resolveSlug = (raw?: string): string | undefined => {
    if (raw && slugs.includes(raw)) return raw;
    if (focusedSlug && slugs.includes(focusedSlug)) return focusedSlug;
    return undefined;
  };
  // A low-confidence guess on a project the user is CONNECTED to is treated as
  // confident — connecting is the explicit "stop asking me" signal.
  const conf = (slug?: string): 'low' | undefined =>
    reply.confidence === 'low' && slug !== focusedSlug ? 'low' : undefined;

  switch (reply.kind) {
    case 'create':
      return { kind: 'create', description: text, confidence: reply.confidence === 'low' ? 'low' : undefined };
    case 'edit': {
      const slug = resolveSlug(reply.slug);
      return slug ? { kind: 'edit', slug, instruction: text, confidence: conf(slug) } : { kind: 'none' };
    }
    case 'question': {
      const slug = resolveSlug(reply.slug);
      return slug ? { kind: 'question', slug, question: text, confidence: conf(slug) } : { kind: 'none' };
    }
    case 'delete': {
      const slug = resolveSlug(reply.slug);
      return slug ? { kind: 'delete', slug } : { kind: 'none' };
    }
    case 'devops': {
      const op = reply.op as DevOpsOpId;
      if (!OP_IDS.includes(op)) return { kind: 'none' };
      const slug = OP_META[op].needsSlug ? resolveSlug(reply.slug) : undefined;
      return { kind: 'devops', op: opLiteral(op, slug) };
    }
    default:
      return { kind: 'none' };
  }
}

/**
 * Build the exact DevOpsOp literal `routeMessage` produces, so menu-driven ops
 * (e.g. the Home panel's "Update Botsman") behave identically to LLM-routed ones
 * and re-derive their confirm policy from OP_META — never from the caller.
 */
export function opLiteral(op: DevOpsOpId, slug?: string): DevOpsOp {
  const meta = OP_META[op];
  return {
    op,
    slug: meta.needsSlug ? slug : undefined,
    mutating: meta.mutating,
    hostLevel: meta.hostLevel,
    humanSummary: summarize(op, slug),
  };
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
      if (r.ok) deps.store.kvSet(RESTART_NOTICE_KEY, '✓ Botsman updated and back online.');
      // The build ran in the foreground, so ok=false carries the real failure
      // (git or docker build) instead of a misleading "started".
      return r.ok
        ? '✓ Update built — restarting now. I will be back in ~30–60s.'
        : `✗ Self-update failed:\n${r.output.slice(-800) || '(no output)'}`;
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

/**
 * Cheap deterministic guard: does the message read as a QUESTION rather than an
 * imperative change? Keeps the edit hot-path ("add a dark theme") LLM-free
 * while sending questions ("how does this work?") to the router.
 */
// Liberal like looksOperational: false positives are harmless (→ LLM router),
// false negatives let a question fast-path into an unwanted code edit.
const QUESTION_START = /^(how|what|why|when|where|which|who|does|do|is|are|can|could|would|should|tell me|explain|show me|describe|walk me through|как|что|почему|зачем|когда|где|какой|какая|сколько|умеет|правда|расскажи|объясни|покажи|опиши)/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith('?') || QUESTION_START.test(t);
}
