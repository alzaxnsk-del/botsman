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
