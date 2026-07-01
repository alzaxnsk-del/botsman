/**
 * Auto update-check: a cheap, daily "is there a newer Botsman?" probe that pings
 * the owner to update ONLY at a quiet moment (no task running, chat idle) — never
 * mid-conversation. The actual update still goes through the existing, double-
 * confirmed self_update op; this module only decides WHEN to offer.
 *
 * Cheap by design: Botsman is a public repo, so "latest version" is one HTTP GET
 * of src/version.ts on main — no git, no docker build, no auth. Comparing the
 * VERSION string (which is bumped on every release) means docs/test-only commits
 * never trigger a false "update available". The same check gates the MANUAL
 * update button so tapping it when you're already current does nothing expensive.
 *
 * Pure helpers live here (unit-tested without a network or a bot); the daemon
 * wires the schedule + Telegram IO in index.ts / the gateway.
 */

import { logger } from './logger.js';

/** Upstream version file (public repo → no auth). Overridable for forks. */
export const DEFAULT_VERSION_URL =
  'https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/src/version.ts';

/** Poll the network at most this often; the daily cadence the owner asked for. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How often the scheduler wakes to (maybe) check / (maybe) offer. */
export const TICK_MS = 30 * 60 * 1000;
/** First check shortly after startup, not immediately (let the daemon settle). */
export const FIRST_CHECK_DELAY_MS = 3 * 60 * 1000;
/** Don't re-offer the SAME version more than once per this window. */
export const REOFFER_MS = 24 * 60 * 60 * 1000;
/** "Quiet" = the chat has been idle at least this long (owner's choice: 60 min). */
export const UPDATE_IDLE_MS = 60 * 60 * 1000;

// kv keys — all update-check state lives in the store so restarts don't spam.
export const LAST_CHECK_KEY = 'update_last_check';
export const LATEST_VERSION_KEY = 'update_latest_version';
export const PROMPT_VERSION_KEY = 'update_prompt_version';
export const PROMPT_AT_KEY = 'update_prompt_at';

/** Resolve the version-check URL, allowing a fork to override via env. */
export function resolveVersionUrl(env: Record<string, string | undefined> = process.env): string {
  return env.BOTSMAN_UPDATE_URL?.trim() || DEFAULT_VERSION_URL;
}

/** Extract the VERSION literal from a version.ts source blob, or null. */
export function parseVersionField(source: string): string | null {
  const m = source.match(/VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/);
  return m ? m[1] : null;
}

/** Semver-ish compare of dotted numeric versions: -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0) || 0;
    const y = Number(pb[i] ?? 0) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True if `remote` is a strictly newer version than `local`. */
export function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

/** Fetch the upstream version string. Best-effort — resolves to null on any
 *  network/HTTP/parse failure (never throws, never blocks the daemon). */
export async function fetchLatestVersion(opts: {
  url: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) return null;
    return parseVersionField(await res.text());
  } catch {
    return null;
  }
}

/** A moment is "quiet" when nothing is building/queued AND the chat has been
 *  idle for a while — so an update ping never lands mid-conversation. */
export function isQuietMoment(opts: {
  lastActivityIso: string | null | undefined;
  queueLength: number;
  now: number;
  idleMs: number;
}): boolean {
  if (opts.queueLength > 0) return false;
  if (!opts.lastActivityIso) return true; // never active → definitely quiet
  const t = Date.parse(opts.lastActivityIso);
  if (Number.isNaN(t)) return true; // unparseable → don't block forever
  return opts.now - t >= opts.idleMs;
}

/** Whether to offer the update right now. Pure so the policy is unit-tested. */
export function shouldPromptUpdate(opts: {
  latest: string | null;
  current: string;
  quiet: boolean;
  enabled: boolean;
  promptedVersion: string | null;
  promptedAt: number | null;
  now: number;
  reofferMs: number;
}): boolean {
  if (!opts.enabled || !opts.latest) return false;
  if (!isNewer(opts.latest, opts.current)) return false;
  if (!opts.quiet) return false;
  // Don't spam: the same version is re-offered at most once per reofferMs. A
  // NEWER version (promptedVersion differs) always offers regardless.
  if (opts.promptedVersion === opts.latest && opts.promptedAt != null && opts.now - opts.promptedAt < opts.reofferMs) {
    return false;
  }
  return true;
}

/** Minimal kv surface the checker needs (satisfied by Store). */
export interface KvStore {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

export interface UpdateCheckerDeps {
  store: KvStore;
  currentVersion: string;
  versionUrl: string;
  /** Read live so the /setup toggle takes effect with no restart. */
  isEnabled: () => boolean;
  /** Read live: no task running/queued AND the chat is idle. */
  isQuiet: () => boolean;
  /** Send the owner the update offer (Telegram IO lives in the gateway). */
  offer: (latest: string) => Promise<void>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Drives the daily check + quiet-moment offer. One background timer; all state
 * in kv. tick() is idempotent and safe to call repeatedly — it hits the network
 * at most once per CHECK_INTERVAL_MS and offers at most once per REOFFER_MS per
 * version, only when quiet.
 */
export class UpdateChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: UpdateCheckerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  start(): void {
    this.first = setTimeout(() => void this.tick(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One evaluation: refresh the known-latest version (throttled), then offer if
   *  it's newer, enabled, quiet and not recently offered. Never throws. */
  async tick(): Promise<void> {
    try {
      if (!this.deps.isEnabled()) return;
      const { store } = this.deps;
      const now = this.now();

      const lastCheck = Number(store.kvGet(LAST_CHECK_KEY) || 0);
      if (now - lastCheck >= CHECK_INTERVAL_MS) {
        const latest = await fetchLatestVersion({ url: this.deps.versionUrl, fetchFn: this.deps.fetchFn });
        store.kvSet(LAST_CHECK_KEY, String(now));
        if (latest) store.kvSet(LATEST_VERSION_KEY, latest);
      }

      const latest = store.kvGet(LATEST_VERSION_KEY) || null;
      const promptedVersion = store.kvGet(PROMPT_VERSION_KEY) || null;
      const promptedAt = Number(store.kvGet(PROMPT_AT_KEY) || 0) || null;
      if (
        shouldPromptUpdate({
          latest,
          current: this.deps.currentVersion,
          quiet: this.deps.isQuiet(),
          enabled: true,
          promptedVersion,
          promptedAt,
          now,
          reofferMs: REOFFER_MS,
        })
      ) {
        // Record the offer BEFORE sending, so a send that partially fails can't
        // loop-spam on the next tick.
        store.kvSet(PROMPT_VERSION_KEY, latest!);
        store.kvSet(PROMPT_AT_KEY, String(now));
        await this.deps.offer(latest!);
        logger.info('update available — offered to owner', { latest, current: this.deps.currentVersion });
      }
    } catch (e) {
      logger.warn('update check tick failed', { error: String((e as Error).message) });
    }
  }
}
