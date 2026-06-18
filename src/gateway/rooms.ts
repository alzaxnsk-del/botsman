import { Keyboard } from 'grammy';
import type { Store } from '../db.js';

/**
 * Soft context (not hard modes): routing is content-based — any message is
 * classified by what it says, regardless of which button was last tapped. The
 * only persistent state is an optional "focused project" that biases bare
 * follow-ups ("make it dark" → the focused project). The reply keyboard is a
 * focus shortcut, not a mode wall.
 */
export type Room =
  | { kind: 'home' }
  | { kind: 'devops' }
  | { kind: 'project'; slug: string };

const focusKey = (chatId: number): string => `focus:${chatId}`;

/** The project bare follow-ups refer to; null when none / the slug was deleted. */
export function getFocus(store: Store, chatId: number): string | null {
  const slug = store.kvGet(focusKey(chatId));
  if (!slug) return null;
  if (!store.projectExists(slug)) {
    store.kvSet(focusKey(chatId), ''); // self-heal a deleted project
    return null;
  }
  return slug;
}

export function setFocus(store: Store, chatId: number, slug: string): void {
  store.kvSet(focusKey(chatId), slug);
}

export function clearFocus(store: Store, chatId: number): void {
  store.kvSet(focusKey(chatId), '');
}

// Sticky server/admin context: like project focus but for the 🛠 Server room.
// While set, bare messages lean toward server ops and the keyboard shows admin
// actions. Mutually exclusive with project focus (switchRoom coordinates both).
const roomKey = (chatId: number): string => `room:${chatId}`;

export function inServerRoom(store: Store, chatId: number): boolean {
  return store.kvGet(roomKey(chatId)) === 'devops';
}

export function setServerRoom(store: Store, chatId: number): void {
  store.kvSet(roomKey(chatId), 'devops');
}

export function clearServerRoom(store: Store, chatId: number): void {
  store.kvSet(roomKey(chatId), '');
}


/** Persistent reply keyboard — the always-visible "which room am I in" anchor. */
export function roomKeyboard(): ReturnType<Keyboard['persistent']> {
  return new Keyboard()
    .text('🏠 Home').text('🛠 Server').text('📦 Projects')
    .resized()
    .persistent();
}

/**
 * While connected to a project the global rooms are swapped for actions ON that
 * project: 🚪 Exit returns to Home; the rest (Review/Doctor/Logs) are safe,
 * read-only one-taps so the keyboard can't trigger an accidental destructive op.
 */
export function projectKeyboard(): ReturnType<Keyboard['persistent']> {
  return new Keyboard()
    .text('🚪 Exit').text('🔍 Review').text('💻 Claude Code')
    .row()
    .text('📋 Logs').text('↩️ Rollback')
    .resized()
    .persistent();
}

export type ProjectAction = 'exit' | 'review' | 'logs' | 'rollback' | 'code';

// Exact button labels (+ a few unambiguous typed synonyms), anchored so a
// multi-word edit that merely mentions "review"/"logs" is NOT hijacked. Kept
// deliberately narrow: overloaded bare words ("leave", "обзор", "log", "журнал")
// are excluded so a one-word feature request isn't mistaken for a tap.
const EXIT_RE = /^(🚪\s*)?(exit|выйти|выход)$/i;
const REVIEW_RE = /^(🔍\s*)?(review|ревью)$/i;
const PLOGS_RE = /^(📋\s*)?(logs|логи)$/i;
const ROLLBACK_RE = /^(↩️\s*)?(rollback|откат|откатить)$/i;
const CODE_RE = /^(💻\s*)?(claude\s*code|clone|клонировать|local\s*dev|локально)$/i;

/** Map a project-context keyboard tap to its action, or null. */
export function detectProjectAction(text: string): ProjectAction | null {
  const t = text.trim();
  if (EXIT_RE.test(t)) return 'exit';
  if (REVIEW_RE.test(t)) return 'review';
  if (PLOGS_RE.test(t)) return 'logs';
  if (ROLLBACK_RE.test(t)) return 'rollback';
  if (CODE_RE.test(t)) return 'code';
  return null;
}

/**
 * Server/admin-context keyboard: the global rooms are swapped for the common
 * server actions. 🚪 Exit (shared with the project keyboard, detected by
 * detectProjectAction) returns Home; read-only actions run instantly; the
 * mutating ones (Clean disk / Restart proxy / Update) go through a confirm.
 */
export function serverKeyboard(): ReturnType<Keyboard['persistent']> {
  return new Keyboard()
    .text('🚪 Exit').text('📊 Load').text('🐳 Containers')
    .row()
    .text('🧹 Clean disk').text('🔁 Restart proxy').text('⬆️ Update')
    .resized()
    .persistent();
}

export type ServerAction = 'load' | 'containers' | 'clean-disk' | 'restart-proxy' | 'update';

const SRV_LOAD_RE = /^(📊\s*)?(load|нагрузка|metrics|метрики)$/i;
const SRV_CONTAINERS_RE = /^(🐳\s*)?(containers|контейнеры)$/i;
const SRV_PRUNE_RE = /^(🧹\s*)?(clean\s*disk|cleanup|prune|очистить\s*диск|очистка\s*диска)$/i;
const SRV_PROXY_RE = /^(🔁\s*)?(restart\s*proxy|перезапустить\s*прокси)$/i;
const SRV_UPDATE_RE = /^(⬆️\s*)?(update|обновить|обновление)$/i;

/** Map a server-context keyboard tap to its action, or null. Exit is handled by
 *  detectProjectAction (the 🚪 Exit label is shared). */
export function detectServerAction(text: string): ServerAction | null {
  const t = text.trim();
  if (SRV_LOAD_RE.test(t)) return 'load';
  if (SRV_CONTAINERS_RE.test(t)) return 'containers';
  if (SRV_PRUNE_RE.test(t)) return 'clean-disk';
  if (SRV_PROXY_RE.test(t)) return 'restart-proxy';
  if (SRV_UPDATE_RE.test(t)) return 'update';
  return null;
}

const HOME_RE = /^(🏠\s*)?(home|\/home|домой|на\s*главную)$/i;
const DEVOPS_RE = /^(🛠\s*)?(server|\/server|devops|сервер)$/i;
const PROJECTS_RE = /^(📦\s*)?(projects|\/projects|проекты)$/i;
// "go to <slug>" / "switch to <slug>" / "open <slug>" / "перейди в <slug>".
// No \b — JS word boundaries don't work with Cyrillic.
const SWITCH_VERBS = /(^|\s)(go to|switch to|open|enter|use|перейд[а-яё]*|открой|зайди)(\s|$)/i;

/**
 * Detect an explicit room switch from a message. Returns a target Room, or
 * 'projects' to mean "show the project picker", or null for no switch.
 */
export function detectRoomSwitch(
  text: string,
  slugs: string[],
): Room | 'projects' | null {
  const t = text.trim();
  if (HOME_RE.test(t)) return { kind: 'home' };
  if (DEVOPS_RE.test(t)) return { kind: 'devops' };
  if (PROJECTS_RE.test(t)) return 'projects';

  // "go to <slug>" style — only when a verb is present, to avoid hijacking
  // edit instructions that merely mention a slug.
  if (SWITCH_VERBS.test(t)) {
    const lower = t.toLowerCase();
    const hit = slugs
      .filter((s) => new RegExp(`(^|[^a-z0-9-])${escapeRe(s)}([^a-z0-9-]|$)`, 'i').test(lower))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) return { kind: 'project', slug: hit };
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
