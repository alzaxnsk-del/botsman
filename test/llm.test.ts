import { describe, it, expect } from 'vitest';
import { extractJson, makeApiKeyLlm } from '../src/llm.js';

describe('extractJson', () => {
  it('parses a clean object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('extracts JSON wrapped in prose', () => {
    expect(extractJson('Sure! Here it is:\n{"op":"x"}\nHope that helps.')).toEqual({ op: 'x' });
  });
  it('returns null for non-JSON', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
  it('returns null for malformed JSON', () => {
    expect(extractJson('{ broken: }')).toBeNull();
  });
});

describe('makeApiKeyLlm', () => {
  const fakeFetch = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  interface Op { op: string }
  const validate = (raw: unknown): Op | null => {
    if (typeof raw === 'object' && raw && typeof (raw as Op).op === 'string') return raw as Op;
    return null;
  };

  it('extracts and validates a structured reply', async () => {
    const llm = makeApiKeyLlm('sk-ant-x', fakeFetch({
      content: [{ type: 'text', text: '{"op":"restart_service"}' }],
    }));
    expect(await llm({ system: 's', user: 'u', validate })).toEqual({ op: 'restart_service' });
  });

  it('returns null when validation rejects the shape', async () => {
    const llm = makeApiKeyLlm('sk-ant-x', fakeFetch({
      content: [{ type: 'text', text: '{"wrong":"field"}' }],
    }));
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
  });

  it('returns null on non-JSON model text', async () => {
    const llm = makeApiKeyLlm('sk-ant-x', fakeFetch({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
    }));
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
  });

  it('returns null on API error', async () => {
    const llm = makeApiKeyLlm('sk-ant-x', fakeFetch({}, false));
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
  });

  it('returns null on network failure', async () => {
    const throwing = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const llm = makeApiKeyLlm('sk-ant-x', throwing);
    expect(await llm({ system: 's', user: 'u', validate })).toBeNull();
  });
});
