import { isValidSlug, slugFromDescription } from './slug.js';

/**
 * Project naming. The transliteration heuristic gives ugly slugs for russian
 * descriptions («форма, куда вставляешь…» → forma-kuda-vstavlyaesh), so we ask
 * a cheap fast model for a proper name first (the spec's example expects
 * price-watcher) and fall back to the heuristic on any error or bad output.
 */
export function sanitizeSlugCandidate(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/["'`.]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return isValidSlug(s) ? s : null;
}

export async function suggestSlugLLM(
  apiKey: string,
  description: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        system:
          'Reply with ONLY a short kebab-case slug (2-3 short english words, [a-z0-9-]) ' +
          'naming the described web service, e.g. "price-watcher". No explanations.',
        messages: [{ role: 'user', content: description.slice(0, 1000) }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
    return sanitizeSlugCandidate(text);
  } catch {
    return null;
  }
}

/** LLM name with heuristic fallback — never throws. */
export async function nameProject(apiKey: string, description: string): Promise<string> {
  return (await suggestSlugLLM(apiKey, description)) ?? slugFromDescription(description);
}
