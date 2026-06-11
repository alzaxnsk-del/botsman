import { Keyboard } from 'grammy';
import type { Store } from '../db.js';

/**
 * Conversational rooms: the owner talks in one of three contexts and switches
 * between them. Switching is deterministic (regex + button texts) so it is
 * instant; within-room routing is the only place that uses an LLM.
 */
export type Room =
  | { kind: 'home' }
  | { kind: 'devops' }
  | { kind: 'project'; slug: string };

const HOME: Room = { kind: 'home' };

const roomKey = (chatId: number): string => `room:${chatId}`;

export function getRoom(store: Store, chatId: number): Room {
  const raw = store.kvGet(roomKey(chatId));
  if (!raw) return HOME;
  let parsed: Room;
  try {
    parsed = JSON.parse(raw) as Room;
  } catch {
    return HOME;
  }
  // Self-heal: a project room whose slug was deleted falls back to home.
  if (parsed.kind === 'project') {
    if (!parsed.slug || !store.projectExists(parsed.slug)) return HOME;
    return parsed;
  }
  return parsed.kind === 'devops' ? parsed : HOME;
}

export function setRoom(store: Store, chatId: number, room: Room): void {
  store.kvSet(roomKey(chatId), JSON.stringify(room));
}

export function roomLabel(room: Room): string {
  switch (room.kind) {
    case 'home': return '🏠 Home';
    case 'devops': return '🛠 Server';
    case 'project': return `📦 ${room.slug}`;
  }
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
  if (HOME_RE.test(t)) return HOME;
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
