import { describe, it, expect } from 'vitest';
import { sanitizeSlugCandidate, suggestSlugLLM } from '../src/naming.js';

describe('sanitizeSlugCandidate', () => {
  it('cleans up typical model replies', () => {
    expect(sanitizeSlugCandidate('price-watcher\n')).toBe('price-watcher');
    expect(sanitizeSlugCandidate('  `Todo-List` ')).toBe('todo-list');
    expect(sanitizeSlugCandidate('Price Watcher')).toBe('price-watcher');
  });

  it('rejects garbage', () => {
    expect(sanitizeSlugCandidate('')).toBeNull();
    expect(sanitizeSlugCandidate('Вот хороший слаг: ---')).toBeNull();
  });
});

describe('suggestSlugLLM', () => {
  const fakeFetch = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('extracts and sanitizes the suggestion', async () => {
    const slug = await suggestSlugLLM('sk-ant-x', 'форма для отслеживания цен', fakeFetch({
      content: [{ type: 'text', text: 'price-watcher' }],
    }));
    expect(slug).toBe('price-watcher');
  });

  it('returns null on API error (caller falls back to heuristic)', async () => {
    expect(await suggestSlugLLM('sk-ant-x', 'x', fakeFetch({}, false))).toBeNull();
  });

  it('returns null on network failure', async () => {
    const throwingFetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    expect(await suggestSlugLLM('sk-ant-x', 'x', throwingFetch)).toBeNull();
  });
});
