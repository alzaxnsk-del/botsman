import { spawn } from 'node:child_process';
import { isValidSlug, slugFromDescription } from './slug.js';
import { parseClaudeJson } from './agent/ClaudeCodeAgent.js';

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

/**
 * Content-free names the model emits when the description had no real product
 * in it (e.g. it was handed a meta-question like "where is the new project I
 * asked for?" → "new-project-request"). These are useless as project names, so
 * we reject them and let the caller fall back to the heuristic.
 */
const GENERIC_SLUGS = new Set([
  'new-project', 'new-project-request', 'project', 'new-service', 'service',
  'my-app', 'my-project', 'web-app', 'webapp', 'app', 'application',
  'untitled', 'example', 'test', 'demo', 'new', 'request', 'website', 'site',
]);

export function isGenericSlug(slug: string): boolean {
  return GENERIC_SLUGS.has(slug);
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
    const slug = sanitizeSlugCandidate(text);
    return slug && !isGenericSlug(slug) ? slug : null;
  } catch {
    return null;
  }
}

/**
 * Subscription-mode naming: one-turn headless Claude Code call (the Messages
 * API needs an API key, but the CLI works with the oauth token). Falls back
 * to null on any error or timeout — caller uses the heuristic then.
 */
export async function suggestSlugCLI(oauthToken: string, description: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '-p',
        `Suggest a short kebab-case slug (2-3 short english words, only [a-z0-9-]) naming this web service: "${description.slice(0, 500)}". Reply with ONLY the slug, e.g. price-watcher.`,
        '--max-turns', '1',
        '--output-format', 'json',
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '/tmp',
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 30_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const parsed = parseClaudeJson(out);
      const slug = parsed && !parsed.is_error ? sanitizeSlugCandidate(parsed.result ?? '') : null;
      resolve(slug && !isGenericSlug(slug) ? slug : null);
    });
  });
}

/** LLM name with heuristic fallback — never throws. */
export async function nameProject(apiKey: string, description: string): Promise<string> {
  return (await suggestSlugLLM(apiKey, description)) ?? slugFromDescription(description);
}
