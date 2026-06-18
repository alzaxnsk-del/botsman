import { InlineKeyboard } from 'grammy';
import type { LlmHealthSnapshot } from '../llm.js';

/**
 * The Home panel: a command-driven control surface that needs ZERO LLM calls, so
 * it keeps working when the AI router is down. These are pure helpers (no IO) so
 * they can be unit-tested without a bot, docker, or a real LLM. The gateway does
 * the IO (compute project counts, send the message, run the tapped op).
 */

export interface HomeStatusInput {
  /** Project counts (computed by the gateway via deployEngine.containerRunning). */
  projects: { live: number; down: number; total: number };
  /** LLM liveness snapshot, or null when no health signal is wired. */
  llm: LlmHealthSnapshot | null;
  /** Whether a structured LLM is configured at all (false → no auth). */
  llmConfigured: boolean;
  /** Count of warnings from the last startup preflight. */
  preflightWarnings: number;
}

/** Render the Home status section (plain text — slugs/errors aren't Markdown-safe). */
export function homeStatusLines(input: HomeStatusInput): string[] {
  const lines: string[] = [
    '🏠 Home',
    '',
    '💬 To build a new project, just describe it here — e.g. "make a TODO app with a task list".',
    '💻 Already have one? Develop it on your computer with Claude Code — tap 💻 below.',
    '',
  ];

  if (input.projects.total === 0) {
    lines.push('📦 No projects yet — just describe one and I’ll build it.');
  } else {
    const down = input.projects.down > 0 ? ` · ⚠️ ${input.projects.down} container down` : '';
    lines.push(`📦 Projects: ${input.projects.live} live${down} · ${input.projects.total} total`);
  }

  if (!input.llmConfigured) {
    lines.push('🤖 AI router: not configured — tap 🔧 Setup → auth.');
  } else if (input.llm && !input.llm.reachable) {
    const why = input.llm.lastError ? ` (${input.llm.lastError})` : '';
    lines.push(
      `🤖 AI router: ⚠️ unreachable${why} — it may be down or out of quota. ` +
      'The commands below still work. Fix: check your API key/quota, or 🔧 Setup → auth.',
    );
  } else {
    lines.push('🤖 AI router: reachable.');
  }

  if (input.preflightWarnings > 0) {
    lines.push(
      `⚠️ ${input.preflightWarnings} startup warning${input.preflightWarnings === 1 ? '' : 's'} ` +
      '— see the last restart notice, or /doctor a project.',
    );
  }
  return lines;
}

/** The Home inline keyboard — the basic, always-available command set. */
export function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Server status', 'home:metrics')
    .text('📦 Projects', 'home:projects')
    .row()
    .text('⬆️ Update Botsman', 'home:update')
    .text('🔧 Setup', 'home:setup')
    .row()
    .text('💻 Code on your computer', 'home:clone');
}

/**
 * When the router came back {kind:'none'}, decide whether that was an OUTAGE
 * (so we say so and point at Home) rather than a genuine "couldn't classify".
 * Returns the message to show, or null to fall through to normal handling.
 */
export function degradedNoneMessage(snap: LlmHealthSnapshot | null): string | null {
  if (snap && !snap.reachable) {
    return "⚠️ I couldn't reach the AI router right now (it may be down or out of quota). " +
      "Try again in a moment, or tap 🏠 Home for commands that don't need it.";
  }
  return null;
}
