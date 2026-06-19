/**
 * Botsman version, shown in the bot (/version and the post-update "back online"
 * notice). Bump BOTH fields by hand on each release to main.
 *
 * Kept deliberately OUT of package.json: the Dockerfile does `COPY package*.json
 * → npm ci → playwright install (slow Chromium download) → COPY src`, so a
 * version bump in package.json would bust the npm/playwright layer cache and
 * make every self-update rebuild slow. Living in src/ means a bump only
 * re-runs the fast `COPY src` + tsc layers, keeping self-update snappy.
 */
export const VERSION = '0.3.1';
export const RELEASED = '2026-06-19';

/** One-line version label for chat messages. */
export function versionLine(): string {
  return `🏷 Botsman v${VERSION} · ${RELEASED}`;
}
