import { spawn } from 'node:child_process';
import { parseClaudeJson } from './agent/ClaudeCodeAgent.js';

/**
 * Structured-LLM helper: free text → validated JSON, working in BOTH auth modes
 * (pay-per-use API key OR Claude subscription token). Generalizes the dual
 * pattern in naming.ts (suggestSlugLLM via Messages API / suggestSlugCLI via
 * the `claude` CLI). Used by the conversational routers (DevOps, project chat).
 *
 * Every call resolves to `null` on any error/timeout/validation failure — it
 * never throws. Callers fall back to a safe default (a menu, or treat-as-edit).
 */

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface LlmJsonOptions<T> {
  /** System instruction; MUST tell the model to reply with ONLY a JSON object. */
  system: string;
  /** The user's free text / context. */
  user: string;
  /** Schema guard: return the typed value, or null to reject the response. */
  validate: (raw: unknown) => T | null;
  maxTokens?: number;
  timeoutMs?: number;
  model?: string;
}

export type StructuredLlm = <T>(opts: LlmJsonOptions<T>) => Promise<T | null>;

/**
 * Liveness signal for the structured LLM, so the gateway can tell "the router is
 * unreachable" (down / out of quota / network) from "the model replied but gave
 * no usable answer". Drives the Home status line and the degraded-mode message.
 *
 * Crux: a SUCCESSFUL HTTP/CLI response that merely fails to parse counts as
 * reachable (recordOk) — a chatty model must never mark the router "down".
 */
export interface LlmHealthSnapshot {
  reachable: boolean;
  lastError?: string;
  lastErrorAt?: string;
  lastOkAt?: string;
}

export interface LlmHealthSink {
  recordOk(): void;
  recordError(detail: string): void;
}

export interface LlmHealth extends LlmHealthSink {
  snapshot(): LlmHealthSnapshot;
}

export function makeLlmHealth(): LlmHealth {
  let reachable = true; // optimistic until proven otherwise
  let lastError: string | undefined;
  let lastErrorAt: string | undefined;
  let lastOkAt: string | undefined;
  return {
    recordOk() {
      reachable = true;
      lastOkAt = new Date().toISOString();
    },
    recordError(detail: string) {
      reachable = false;
      lastError = detail;
      lastErrorAt = new Date().toISOString();
    },
    snapshot() {
      return { reachable, lastError, lastErrorAt, lastOkAt };
    },
  };
}

/** Tolerant JSON extraction — same "first { … last }" trick as parseClaudeJson. */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Messages API path (needs an API key). */
export function makeApiKeyLlm(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  health?: LlmHealthSink,
): StructuredLlm {
  return async <T>(opts: LlmJsonOptions<T>): Promise<T | null> => {
    try {
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model ?? DEFAULT_MODEL,
          max_tokens: opts.maxTokens ?? 300,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user.slice(0, 4000) }],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        health?.recordError(`HTTP ${res.status}`);
        return null;
      }
      // Reachable: we got a valid HTTP response. A later parse/validate miss is
      // a "no answer", not an outage — record OK before touching the body.
      health?.recordOk();
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
      const json = extractJson(text);
      return json === null ? null : opts.validate(json);
    } catch (e) {
      health?.recordError((e as Error).message);
      return null;
    }
  };
}

/** Claude Code CLI path (works with the subscription oauth token). */
export function makeCliLlm(oauthToken: string, health?: LlmHealthSink): StructuredLlm {
  return <T>(opts: LlmJsonOptions<T>): Promise<T | null> => {
    return new Promise((resolve) => {
      // The CLI has no system-prompt flag here; fold the instruction into -p and
      // demand raw JSON, then extract it from the model's text `result`.
      const prompt = `${opts.system}\n\nInput:\n${opts.user.slice(0, 4000)}`;
      const child = spawn(
        'claude',
        ['-p', prompt, '--max-turns', '1', '--output-format', 'json'],
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
        health?.recordError('timeout');
        resolve(null);
      }, opts.timeoutMs ?? 25_000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', (e) => { clearTimeout(timer); health?.recordError(e.message); resolve(null); });
      child.on('close', () => {
        clearTimeout(timer);
        const parsed = parseClaudeJson(out);
        // No envelope at all (or the CLI itself errored) → unreachable. A parsed
        // envelope whose text isn't JSON is reachable-but-no-answer (recordOk).
        if (!parsed || parsed.is_error) {
          health?.recordError(parsed?.is_error ? 'cli reported an error' : 'no CLI output');
          return resolve(null);
        }
        health?.recordOk();
        const json = extractJson(parsed.result ?? '');
        resolve(json === null ? null : opts.validate(json));
      });
    });
  };
}

/** Pick the right LLM path from available auth, or undefined if none. */
export function makeStructuredLlm(
  cfg: { apiKey?: string; oauthToken?: string },
  health?: LlmHealthSink,
): StructuredLlm | undefined {
  if (cfg.apiKey) return makeApiKeyLlm(cfg.apiKey, fetch, health);
  if (cfg.oauthToken) return makeCliLlm(cfg.oauthToken, health);
  return undefined;
}
