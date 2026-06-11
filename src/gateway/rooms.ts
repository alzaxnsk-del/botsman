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


/** Persistent reply keyboard — the always-visible "which room am I in" anchor. */
export function roomKeyboard(): ReturnType<Keyboard['persistent']> {
  return new Keyboard()
    .text('🏠 Home').text('🛠 Server').text('📦 Projects')
    .resized()
    .persistent();
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
