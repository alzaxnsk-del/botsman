import { describe, it, expect } from 'vitest';
import {
  parseVersionField, compareVersions, isNewer, resolveVersionUrl, fetchLatestVersion,
  isQuietMoment, shouldPromptUpdate, UpdateChecker,
  LATEST_VERSION_KEY, LAST_CHECK_KEY, PROMPT_VERSION_KEY,
  type UpdateCheckerDeps,
} from '../src/update.js';

describe('parseVersionField', () => {
  it('extracts the VERSION literal from a version.ts blob', () => {
    expect(parseVersionField("export const VERSION = '0.4.0';")).toBe('0.4.0');
    expect(parseVersionField('export const VERSION = "1.2.30";\nexport const RELEASED=...')).toBe('1.2.30');
  });
  it('returns null when there is no version', () => {
    expect(parseVersionField('nothing here')).toBeNull();
    expect(parseVersionField("const V = '0.1';")).toBeNull(); // not X.Y.Z
  });
});

describe('compareVersions / isNewer', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('0.3.7', '0.3.8')).toBe(-1);
    expect(compareVersions('0.4.0', '0.3.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1); // numeric, not lexical
  });
  it('isNewer is strictly greater', () => {
    expect(isNewer('0.4.0', '0.3.7')).toBe(true);
    expect(isNewer('0.3.7', '0.3.7')).toBe(false);
    expect(isNewer('0.3.6', '0.3.7')).toBe(false);
  });
});

describe('resolveVersionUrl', () => {
  it('defaults to the public raw version.ts, env overrides for forks', () => {
    expect(resolveVersionUrl({})).toContain('raw.githubusercontent.com');
    expect(resolveVersionUrl({ BOTSMAN_UPDATE_URL: 'https://example.com/v.ts' })).toBe('https://example.com/v.ts');
  });
});

describe('fetchLatestVersion', () => {
  it('parses the version from a 200 response', async () => {
    const fetchFn = (async () => ({ ok: true, text: async () => "export const VERSION = '0.9.1';" })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ url: 'x', fetchFn })).toBe('0.9.1');
  });
  it('returns null on non-200, unparseable body, or a thrown error (never throws)', async () => {
    const notOk = (async () => ({ ok: false, text: async () => '' })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ url: 'x', fetchFn: notOk })).toBeNull();
    const garbage = (async () => ({ ok: true, text: async () => 'no version here' })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ url: 'x', fetchFn: garbage })).toBeNull();
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ url: 'x', fetchFn: boom })).toBeNull();
  });
});

describe('isQuietMoment', () => {
  const now = 10_000_000;
  const idleMs = 60 * 60 * 1000;
  it('is NOT quiet while a task runs/queues', () => {
    expect(isQuietMoment({ lastActivityIso: null, queueLength: 1, now, idleMs })).toBe(false);
  });
  it('is quiet when idle long enough, not quiet when recently active', () => {
    const recent = new Date(now - 5 * 60 * 1000).toISOString(); // 5 min ago
    const old = new Date(now - 90 * 60 * 1000).toISOString();   // 90 min ago
    expect(isQuietMoment({ lastActivityIso: recent, queueLength: 0, now, idleMs })).toBe(false);
    expect(isQuietMoment({ lastActivityIso: old, queueLength: 0, now, idleMs })).toBe(true);
  });
  it('treats no/unparseable activity as quiet (never blocks forever)', () => {
    expect(isQuietMoment({ lastActivityIso: null, queueLength: 0, now, idleMs })).toBe(true);
    expect(isQuietMoment({ lastActivityIso: 'garbage', queueLength: 0, now, idleMs })).toBe(true);
  });
});

describe('shouldPromptUpdate', () => {
  const base = { current: '0.3.7', quiet: true, enabled: true, promptedVersion: null, promptedAt: null, now: 1000, reofferMs: 24 * 3600_000 };
  it('offers a newer version when enabled and quiet', () => {
    expect(shouldPromptUpdate({ ...base, latest: '0.4.0' })).toBe(true);
  });
  it('does not offer when disabled, no latest, not newer, or not quiet', () => {
    expect(shouldPromptUpdate({ ...base, latest: '0.4.0', enabled: false })).toBe(false);
    expect(shouldPromptUpdate({ ...base, latest: null })).toBe(false);
    expect(shouldPromptUpdate({ ...base, latest: '0.3.7' })).toBe(false); // same
    expect(shouldPromptUpdate({ ...base, latest: '0.4.0', quiet: false })).toBe(false);
  });
  it('snoozes the same version within the re-offer window, but a NEWER version offers again', () => {
    const snoozed = { ...base, latest: '0.4.0', promptedVersion: '0.4.0', promptedAt: 900, now: 1000 };
    expect(shouldPromptUpdate(snoozed)).toBe(false); // just offered
    expect(shouldPromptUpdate({ ...snoozed, now: 900 + 24 * 3600_000 + 1 })).toBe(true); // window elapsed
    expect(shouldPromptUpdate({ ...snoozed, latest: '0.5.0' })).toBe(true); // newer → offer
  });
});

function fakeStore() {
  const m = new Map<string, string>();
  return {
    kvGet: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    kvSet: (k: string, v: string): void => { m.set(k, v); },
  };
}

describe('UpdateChecker.tick', () => {
  const mkChecker = (over: Partial<UpdateCheckerDeps> = {}) => {
    const store = fakeStore();
    let remote = '0.4.0';
    let fetchCalls = 0;
    const offered: string[] = [];
    let now = 1_700_000_000_000;
    const checker = new UpdateChecker({
      store,
      currentVersion: '0.3.7',
      versionUrl: 'http://x/version.ts',
      isEnabled: () => true,
      isQuiet: () => true,
      offer: async (l) => { offered.push(l); },
      fetchFn: (async () => { fetchCalls++; return { ok: true, text: async () => `export const VERSION = '${remote}';` }; }) as unknown as typeof fetch,
      now: () => now,
      ...over,
    });
    return {
      checker, store, offered,
      calls: () => fetchCalls,
      setRemote: (v: string) => { remote = v; },
      advance: (ms: number) => { now += ms; },
    };
  };

  it('checks once, stores latest, and offers a newer version when quiet', async () => {
    const h = mkChecker();
    await h.checker.tick();
    expect(h.calls()).toBe(1);
    expect(h.store.kvGet(LATEST_VERSION_KEY)).toBe('0.4.0');
    expect(h.offered).toEqual(['0.4.0']);
  });

  it('throttles the network check to once per interval and snoozes a just-offered version', async () => {
    const h = mkChecker();
    await h.checker.tick();
    await h.checker.tick(); // immediately again
    expect(h.calls()).toBe(1);       // no second network hit
    expect(h.offered).toEqual(['0.4.0']); // not re-offered
  });

  it('does not offer while busy, then offers once quiet (no extra network hit)', async () => {
    let quiet = false;
    const h = mkChecker({ isQuiet: () => quiet });
    await h.checker.tick();
    expect(h.calls()).toBe(1);
    expect(h.offered).toEqual([]); // found but not a good moment
    quiet = true;
    await h.checker.tick();
    expect(h.calls()).toBe(1);          // still within interval → no re-fetch
    expect(h.offered).toEqual(['0.4.0']); // offered now that it's quiet
  });

  it('does nothing when disabled', async () => {
    const h = mkChecker({ isEnabled: () => false });
    await h.checker.tick();
    expect(h.calls()).toBe(0);
    expect(h.offered).toEqual([]);
    expect(h.store.kvGet(LAST_CHECK_KEY)).toBeNull();
  });

  it('re-offers when a newer version appears after the interval', async () => {
    const h = mkChecker();
    await h.checker.tick();
    expect(h.offered).toEqual(['0.4.0']);
    h.setRemote('0.5.0');
    h.advance(25 * 60 * 60 * 1000); // past the 24h check interval
    await h.checker.tick();
    expect(h.calls()).toBe(2);
    expect(h.offered).toEqual(['0.4.0', '0.5.0']);
    expect(h.store.kvGet(PROMPT_VERSION_KEY)).toBe('0.5.0');
  });

  it('swallows a failing offer, records the snooze BEFORE sending, and does not re-offer next tick', async () => {
    let offerCalls = 0;
    const h = mkChecker({ offer: async () => { offerCalls++; throw new Error('send failed'); } });
    // Contract 1: tick never throws (it's fired via bare `void this.tick()`).
    await expect(h.checker.tick()).resolves.toBeUndefined();
    expect(offerCalls).toBe(1);
    // Contract 2: the snooze keys are written BEFORE the (failing) send…
    expect(h.store.kvGet(PROMPT_VERSION_KEY)).toBe('0.4.0');
    // …so the next tick doesn't loop-spam the owner despite the failed offer.
    await h.checker.tick();
    expect(offerCalls).toBe(1);
  });
});
