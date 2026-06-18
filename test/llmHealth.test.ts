import { describe, it, expect } from 'vitest';
import { makeLlmHealth, makeApiKeyLlm } from '../src/llm.js';

const validate = (raw: unknown): { op: string } | null =>
  raw && typeof raw === 'object' && typeof (raw as { op?: unknown }).op === 'string'
    ? (raw as { op: string })
    : null;

const fakeFetch = (body: unknown, ok = true, status = 200) =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

describe('makeLlmHealth', () => {
  it('starts reachable, flips on error, recovers on ok', () => {
    const h = makeLlmHealth();
    expect(h.snapshot().reachable).toBe(true);
    h.recordError('HTTP 429');
    const s = h.snapshot();
    expect(s.reachable).toBe(false);
    expect(s.lastError).toBe('HTTP 429');
    h.recordOk();
    expect(h.snapshot().reachable).toBe(true);
  });
});

describe('makeApiKeyLlm health recording', () => {
  it('HTTP error → null and unreachable', async () => {
    const h = makeLlmHealth();
    const llm = makeApiKeyLlm('k', fakeFetch({}, false, 503), h);
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
    expect(h.snapshot().reachable).toBe(false);
    expect(h.snapshot().lastError).toBe('HTTP 503');
  });

  it('200 but unparseable body → null BUT reachable (no false outage)', async () => {
    const h = makeLlmHealth();
    const llm = makeApiKeyLlm('k', fakeFetch({ content: [{ type: 'text', text: 'sorry, no json' }] }), h);
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
    // The crux: a reachable router that just didn't answer must NOT read as down.
    expect(h.snapshot().reachable).toBe(true);
    expect(h.snapshot().lastOkAt).toBeDefined();
  });

  it('200 with valid JSON → value and reachable', async () => {
    const h = makeLlmHealth();
    const llm = makeApiKeyLlm('k', fakeFetch({ content: [{ type: 'text', text: '{"op":"x"}' }] }), h);
    expect(await llm({ system: 's', user: 'u', validate })).toEqual({ op: 'x' });
    expect(h.snapshot().reachable).toBe(true);
  });

  it('thrown fetch (network failure) → null and unreachable', async () => {
    const h = makeLlmHealth();
    const throwing = (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch;
    const llm = makeApiKeyLlm('k', throwing, h);
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
    const s = h.snapshot();
    expect(s.reachable).toBe(false);
    expect(s.lastError).toBe('socket hang up');
  });
});
