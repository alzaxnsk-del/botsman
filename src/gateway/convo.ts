import type { Store } from '../db.js';

/**
 * Short rolling conversation memory, per chat. So a follow-up ("explain what's
 * here", "and the port?", "подробнее") carries the recent dialogue — both in a
 * project and in the 🛠 Server (admin) room. Reset on a real room switch, expired
 * after EXPIRY_MS ("the current dialogue"), and capped so a log/file dump can't
 * blow up the prompt.
 *
 * Concurrency: recordTurn/recordExchange are read-modify-write on the kv store.
 * This relies on grammy's DEFAULT sequential per-update processing (the poller
 * awaits each update before the next), so two writes for one chat never race.
 * If we ever enable grammy's concurrency runner, make this atomic in the store.
 */
export interface Turn {
  role: 'user' | 'bot';
  text: string;
  ts?: number; // epoch ms; absent on hand-built turns (treated as fresh)
}

const MAX_TURNS = 8; // rolling window of recent turns
const MAX_LEN = 1200; // per-turn char cap (a Dockerfile/log dump is trimmed)
const EXPIRY_MS = 60 * 60 * 1000; // 60 min — a dialogue older than this is "not current"
const key = (chatId: number): string => `convo:${chatId}`;

/** Append a turn to the rolling window. Pure — the caller persists the result. */
export function appendTurn(turns: Turn[], role: 'user' | 'bot', text: string, now = Date.now()): Turn[] {
  const t = text.trim();
  if (!t) return turns;
  const clipped = t.length > MAX_LEN ? `${t.slice(0, MAX_LEN)}…` : t;
  return [...turns, { role, text: clipped, ts: now }].slice(-MAX_TURNS);
}

/** Render the transcript as prompt context, oldest first. */
export function formatTranscript(turns: Turn[]): string {
  return turns.map((x) => `${x.role === 'user' ? 'User' : 'Botsman'}: ${x.text}`).join('\n');
}

// --- store-backed wrappers (thin I/O over the pure helpers above) ---

export function readTurns(store: Store, chatId: number): Turn[] {
  try {
    const raw = store.kvGet(key(chatId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Turn[]) : [];
  } catch {
    return [];
  }
}

export function recordTurn(store: Store, chatId: number, role: 'user' | 'bot', text: string): void {
  store.kvSet(key(chatId), JSON.stringify(appendTurn(readTurns(store, chatId), role, text)));
}

/** Record a user→bot exchange as one unit, so the transcript stays a clean
 *  question/answer log with no dangling user turns. */
export function recordExchange(store: Store, chatId: number, userText: string, botText: string): void {
  let turns = appendTurn(readTurns(store, chatId), 'user', userText);
  turns = appendTurn(turns, 'bot', botText);
  store.kvSet(key(chatId), JSON.stringify(turns));
}

/** The recent (non-expired) dialogue as a single context block, or null. */
export function conversationContext(store: Store, chatId: number): string | null {
  const now = Date.now();
  const fresh = readTurns(store, chatId).filter((x) => !x.ts || now - x.ts < EXPIRY_MS);
  return fresh.length ? formatTranscript(fresh) : null;
}

/** Start a fresh dialogue (on a real room switch / delete of the focused project). */
export function clearConversation(store: Store, chatId: number): void {
  store.kvSet(key(chatId), '');
}
