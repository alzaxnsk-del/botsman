/**
 * Smoke-check (§4 EPIC E): wait until the freshly started container answers
 * HTTP 200 on "/". The daemon shares the project network, so it can reach the
 * container by name directly — no DNS or proxy needed for the check.
 */
export interface SmokeResult {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

export async function smokeCheck(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SmokeResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = 'no attempts made';
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8_000),
      });
      lastStatus = res.status;
      if (res.status === 200) {
        return { ok: true, status: 200, attempts };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, status: lastStatus, error: lastError, attempts };
}
