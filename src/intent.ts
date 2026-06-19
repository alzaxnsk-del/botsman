import { transliterate, STOP_WORDS } from './slug.js';

/**
 * Free-text intent detection (§4 EPIC B). Deliberately simple and explicit,
 * matching the spec's rule: slug mention OR last-project context → edit;
 * explicit "make me a service" phrasing → create; only when there is no
 * context at all do we ask one clarifying question.
 */
export type Intent =
  | { kind: 'create'; description: string }
  | { kind: 'edit'; slug: string; instruction: string }
  | { kind: 'ambiguous'; lastSlug: string | null };

// NB: no \b after the group — JS word boundaries don't work with Cyrillic.
const CREATE_VERBS = /^(сделай|создай|собери|построй|напиши|нужен|нужна|нужно|хочу|новый|новая|новое|make|build|create|new|i want|i need)(\s|[:,]|$)/i;
const PRODUCT_NOUNS = /(сервис|приложение|бот|сайт|страничк|service|app|site|bot)/i;

export function detectIntent(
  text: string,
  existingSlugs: string[],
  lastActiveSlug: string | null,
): Intent {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Explicit slug mention wins.
  const mentioned = existingSlugs
    .filter((slug) => new RegExp(`(^|[^a-z0-9-])${escapeRe(slug)}([^a-z0-9-]|$)`, 'i').test(lower))
    .sort((a, b) => b.length - a.length)[0];
  if (mentioned) {
    return { kind: 'edit', slug: mentioned, instruction: trimmed };
  }

  // 2. Clear "create me a <service>" phrasing → new project, even mid-conversation.
  if (CREATE_VERBS.test(lower) && PRODUCT_NOUNS.test(lower)) {
    return { kind: 'create', description: trimmed };
  }

  // 3. Nothing exists yet — can only be a creation request.
  if (existingSlugs.length === 0) {
    return { kind: 'create', description: trimmed };
  }

  // 4. Spec §1 dialogue: a follow-up right after working on a project is an
  //    edit of that project («сделай тёмную тему…» → правка, без переспроса).
  if (lastActiveSlug && existingSlugs.includes(lastActiveSlug)) {
    return { kind: 'edit', slug: lastActiveSlug, instruction: trimmed };
  }

  // 5. Projects exist but no recent context (e.g. fresh chat) → ask once.
  return { kind: 'ambiguous', lastSlug: null };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the message read as "make me a new thing"? Used to keep create-phrased
 *  messages out of the no-LLM edit fast-path (they must go to the LLM router,
 *  which can tell "make me a shop" from an edit of the focused project). */
export function looksLikeCreate(text: string): boolean {
  return CREATE_VERBS.test(text.trim().toLowerCase());
}

// No \b (Cyrillic). Keep delete-phrased messages out of the edit fast-path so
// they reach the LLM router, which maps them to a delete-with-confirmation.
const DELETE_VERBS = /(^|\s)(удали[а-яё]*|снес[а-яё]*|delete|remove|drop)(\s|$)/i;

export function looksLikeDelete(text: string): boolean {
  return DELETE_VERBS.test(text.trim().toLowerCase());
}

const NOISE_TOKENS = new Set(['web', 'app', 'application', 'service', 'api', 'site', 'bot', 'server', 'review', 'app2']);

/**
 * Before creating, catch the "accidental near-duplicate": a message that names
 * (even fuzzily / transliterated, e.g. «тамагочи» → tamagotchi-web-app) an
 * EXISTING project, so the user likely meant to change it, not make a clone.
 * Returns the similar existing slug, or null.
 */
export function findSimilarProject(text: string, slugs: string[]): string | null {
  const words = transliterate(text)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 4 && !NOISE_TOKENS.has(w) && !STOP_WORDS.has(w));
  if (!words.length) return null;

  for (const slug of slugs) {
    const slugTokens = slug.split('-').filter((t) => t.length >= 4 && !NOISE_TOKENS.has(t));
    for (const st of slugTokens) {
      for (const w of words) {
        if (tokensSimilar(w, st)) return slug;
      }
    }
  }
  return null;
}

function tokensSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 5 && long.includes(short)) return true; // todo ⊂ todolist
  return sharedPrefix(a, b) >= 6; // tamagochi / tamagotchi → "tamago"
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Decision for a create request: build straight away, or confirm against the
 *  projects that already exist (offered closest-match first, capped). */
export interface CreatePlan {
  /** No projects yet → build immediately, nothing to confuse it with. */
  build: boolean;
  /** Closest-looking existing project, if any. */
  similar: string | null;
  /** Existing projects to offer as "improve instead" options, closest first, capped. */
  shown: string[];
  /** More projects existed than we show. */
  hasMore: boolean;
}

/**
 * Decide whether a create-phrased request should build immediately or first
 * confirm against existing projects (so it can't silently become a duplicate).
 * Pure — the gateway turns this into a message + buttons.
 */
export function planCreate(description: string, slugs: string[], cap = 6): CreatePlan {
  if (slugs.length === 0) return { build: true, similar: null, shown: [], hasMore: false };
  const similar = findSimilarProject(description, slugs);
  const ordered = similar ? [similar, ...slugs.filter((s) => s !== similar)] : slugs;
  const shown = ordered.slice(0, cap);
  return { build: false, similar, shown, hasMore: ordered.length > shown.length };
}
