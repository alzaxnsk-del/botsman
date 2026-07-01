/**
 * Pure presentation helpers for the Telegram gateway — no IO, no grammy, so
 * they can be unit-tested without a live bot (like home.ts / devops.ts helpers).
 * Keep anything here side-effect-free; the gateway does the actual sending.
 */

/** Max chars of raw error we surface inline, so the recovery keyboard isn't
 *  buried under a multi-thousand-char wall on a phone. */
export const FAIL_DETAIL_MAX = 1200;

/**
 * A failed-task message: a plain-language lead + a trimmed detail tail + a
 * pointer to recovery. Plain text (no Markdown) on purpose — error/log content
 * is arbitrary and would break Markdown parsing. The TAIL is kept (not the
 * head): for build/runtime failures the actual error is usually at the end.
 */
export function failureMessage(o: { slug?: string; error?: string }): string {
  const slug = o.slug ? ` ${o.slug}` : '';
  const detail = (o.error ?? 'unknown error').trim();
  const trimmed = detail.length > FAIL_DETAIL_MAX ? '…' + detail.slice(-FAIL_DETAIL_MAX) : detail;
  return [
    `❌ Couldn't finish${slug}.`,
    '',
    trimmed || '(no output)',
    '',
    'Tap 🔁 Retry to run it again, or just send a revised description.',
  ].join('\n');
}

/**
 * Append elapsed time to the active stage label once it has been running a
 * while ("🤖 Generating code · 2m"), so the user sees real progress on the
 * multi-minute stages instead of a static label. `nowMs` is passed in so this
 * stays pure and testable. Under a minute we add nothing (avoids noise).
 */
export function withElapsed(label: string, startedAtMs: number, nowMs: number): string {
  const sec = Math.floor((nowMs - startedAtMs) / 1000);
  if (sec < 60) return label;
  const min = Math.floor(sec / 60);
  return `${label} · ${min}m`;
}

// --- new-project deploy check -------------------------------------------------

export type Lang = 'ru' | 'en';

/**
 * Reply in the language the spec was written in. The agent's summary is already
 * in that language, so we detect from it (Cyrillic-vs-Latin majority). Falls back
 * to English — the product's default — when there's no signal or it's ambiguous.
 * RU + EN only: the owner writes in those; anything else degrades to English.
 */
export function detectLang(text?: string): Lang {
  if (!text) return 'en';
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr > lat ? 'ru' : 'en';
}

export interface DeployCheckFacts {
  slug: string;
  /** Public URL (https://host/), shown as the one clickable line. */
  url?: string;
  /** scp-style clone target (user@host:path); shown as a copy-pasteable command. */
  cloneCmd?: string;
  /** The agent's "what it is" description (in the spec's language). */
  summary?: string;
  costUsd?: number;
  /** Wall-clock of the build itself (excludes queue wait); shown when ≥ 1 min. */
  elapsedMs?: number;
  /** Public URL not answering yet (TLS/DNS lag) → HTTPS shown as pending + detail. */
  publicWarning?: string;
  hasScreenshot?: boolean;
}

interface CheckCopy {
  deployed: string; whatItIs: string; checklist: string;
  repo: string; container: string; https: string; httpsAuto: string; httpsPending: string;
  check: string; db: string; dbDetail: string; screenshot: string; tokens: string;
  next: string; whatToChange: string;
}

const COPY: Record<Lang, CheckCopy> = {
  en: {
    deployed: 'deployed',
    whatItIs: 'What it is:',
    checklist: 'Deploy check',
    repo: 'Repository created',
    container: 'Container built',
    https: 'HTTPS',
    httpsAuto: 'issued automatically',
    httpsPending: 'issuing — not answering yet',
    check: 'Health check',
    db: 'Database',
    dbDetail: 'Postgres ready · credentials via env only',
    screenshot: 'Screenshot below',
    tokens: 'Tokens',
    next: 'Next: change it right here — or `git clone` → edit in Claude Code → `git push`, and I redeploy it myself.',
    whatToChange: 'What should I change?',
  },
  ru: {
    deployed: 'задеплоен',
    whatItIs: 'Что это:',
    checklist: 'Чек деплоя',
    repo: 'Репозиторий создан',
    container: 'Контейнер собран',
    https: 'HTTPS',
    httpsAuto: 'выдан автоматически',
    httpsPending: 'выпускается — пока не отвечает',
    check: 'Проверка',
    db: 'База',
    dbDetail: 'Postgres готов · доступы только через env',
    screenshot: 'Скриншот ниже',
    tokens: 'Токены',
    next: 'Дальше: меняй прямо здесь — или `git clone` → правишь в Claude Code → `git push`, и я передеплою сам.',
    whatToChange: 'Что поменять?',
  },
};

/** Collapse an agent summary to a single tidy line, capped so it stays a
 *  "what it is" lead rather than a wall (the deploy facts live in the check). */
function oneLine(s: string, max = 500): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function formatDuration(ms: number, lang: Lang): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return lang === 'ru' ? `~${sec} сек` : `~${sec}s`;
  const min = Math.round(sec / 60);
  return lang === 'ru' ? `~${min} мин` : `~${min} min`;
}

/**
 * The success card for a freshly built/resumed project. Leads with the value —
 * a live HTTPS URL and a one-line "what it is" — then a concrete deploy
 * checklist (the plumbing the user DIDN'T have to do: repo + clone command,
 * container, TLS, health check, database) and a "what's next" pointer. Pure +
 * localized so it's unit-tested; the gateway sends it and the screenshot.
 */
export function formatDeployCheck(f: DeployCheckFacts, lang: Lang): string {
  const t = COPY[lang];
  const lines: string[] = [`✅ *${f.slug}* — ${t.deployed}`];
  if (f.url) lines.push(`🔗 ${f.url}`);
  if (f.summary) lines.push('', `*${t.whatItIs}* ${oneLine(f.summary)}`);

  lines.push('', `*${t.checklist}*`);
  if (f.cloneCmd) lines.push(`✓ ${t.repo} → \`git clone ${f.cloneCmd}\``);
  lines.push(`✓ ${t.container} → node:22-alpine, non-root`);
  lines.push(f.publicWarning ? `⏳ ${t.https} — ${t.httpsPending}` : `✓ ${t.https} — ${t.httpsAuto}`);
  lines.push(`✓ ${t.check} → GET / = 200`);
  lines.push(`✓ ${t.db} → ${t.dbDetail}`);
  if (f.hasScreenshot) lines.push(`📸 ${t.screenshot}`);

  const meta: string[] = [];
  if (f.costUsd && f.costUsd > 0) meta.push(`💸 ${t.tokens}: ≈$${f.costUsd.toFixed(2)}`);
  if (f.elapsedMs && f.elapsedMs >= 60_000) meta.push(`⏱ ${formatDuration(f.elapsedMs, lang)}`);
  if (meta.length) lines.push(meta.join('  ·  '));

  if (f.publicWarning) lines.push('', `⚠️ ${f.publicWarning}`);
  lines.push('', t.next, '', t.whatToChange);
  return lines.join('\n');
}

// --- edit / rollback outcome --------------------------------------------------

export interface EditOutcomeFacts {
  slug: string;
  /**
   * Whether a NEW image was actually promoted. `false` means the run shipped
   * nothing (no change, or HEAD already live) — the header must not claim a
   * deploy. `true`/undefined → a real deploy (undefined keeps older callers,
   * e.g. rollback, on the "deployed" wording).
   */
  deployed?: boolean;
  url?: string;
  summary?: string;
  warning?: string;
  costUsd?: number;
}

/**
 * The concise result card for an edit/rollback of an already-live project.
 * Honest by construction: only claims "deployed" when a new image actually went
 * live; the no-change path says so plainly instead of a false ✅. Pure + tested;
 * the gateway sends it (plus any screenshot).
 */
export function formatEditOutcome(o: EditOutcomeFacts): string {
  const lines: string[] = o.deployed === false
    ? [`ℹ️ *${o.slug}* — no changes made (nothing to deploy)`]
    : [`✅ *${o.slug}* — deployed`];
  if (o.url) lines.push(o.url);
  if (o.summary) lines.push('', o.summary.slice(0, 2000));
  if (o.warning) lines.push('', `⚠️ ${o.warning}`);
  if (o.costUsd && o.costUsd > 0) lines.push('', `💸 Tokens: ≈$${o.costUsd.toFixed(2)}`);
  lines.push('', 'What should I change?');
  return lines.join('\n');
}
