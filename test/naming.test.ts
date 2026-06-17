import { describe, it, expect } from 'vitest';
import { sanitizeSlugCandidate, suggestSlugLLM, isGenericSlug } from '../src/naming.js';

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

  it('rejects content-free names so the caller falls back to the heuristic', async () => {
    // The model summarised a meta-question instead of naming a product —
    // exactly the "new-project-request" failure from the incident.
    const slug = await suggestSlugLLM('sk-ant-x', 'где новый проект, который я просил?', fakeFetch({
      content: [{ type: 'text', text: 'new-project-request' }],
    }));
    expect(slug).toBeNull();
  });
});

describe('isGenericSlug', () => {
  it('flags content-free names but keeps real ones', () => {
    expect(isGenericSlug('new-project-request')).toBe(true);
    expect(isGenericSlug('new-project')).toBe(true);
    expect(isGenericSlug('app')).toBe(true);
    expect(isGenericSlug('price-watcher')).toBe(false);
    expect(isGenericSlug('todo-list')).toBe(false);
  });
});
