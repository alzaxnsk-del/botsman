import dns from 'node:dns/promises';
import type Dockerode from 'dockerode';
import { logger } from './logger.js';
import type { BotsmanConfig } from './types.js';
import type { CaddyClient } from './deploy/caddy.js';

export interface PreflightResult {
  fatal: string[];
  warnings: string[];
}

/**
 * Startup checks (§4 EPIC A): docker socket, token validity (live probes),
 * DNS wildcard (warning only — not a blocker).
 */
export async function preflight(
  config: BotsmanConfig,
  docker: Dockerode,
  caddy: CaddyClient,
  agentImage?: string,
): Promise<PreflightResult> {
  const fatal: string[] = [];
  const warnings: string[] = [];

  try {
    await docker.ping();
  } catch (e) {
    fatal.push(`Docker is unreachable (${(e as Error).message}). Check that the docker socket is mounted into the container.`);
  }

  if (agentImage && fatal.length === 0) {
    try {
      await docker.getImage(agentImage).inspect();
    } catch {
      warnings.push(
        `Coding agent image "${agentImage}" not found — run docker compose build, otherwise code generation will not start.`,
      );
    }
  }

  const tg = await checkTelegramToken(config.telegramBotToken);
  if (!tg.ok) fatal.push(`Telegram bot token does not work: ${tg.error}`);

  const claude = await checkAnthropicKey(config.anthropicApiKey);
  if (!claude.ok) fatal.push(`Anthropic API key does not work: ${claude.error}`);

  if (!(await caddy.ping())) {
    warnings.push('Caddy Admin API is unreachable — deploys cannot publish routes until Caddy is up.');
  }

  const probe = `botsman-dns-probe.${config.baseDomain}`;
  try {
    await dns.lookup(probe);
  } catch {
    warnings.push(
      `DNS: ${probe} does not resolve. A wildcard record *.${config.baseDomain} → this server's IP is required, otherwise links and TLS will not work.`,
    );
  }

  for (const w of warnings) logger.warn(`preflight: ${w}`);
  for (const f of fatal) logger.error(`preflight: ${f}`);
  return { fatal, warnings };
}

export async function checkTelegramToken(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    return body.ok ? { ok: true } : { ok: false, error: body.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function checkAnthropicKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Cheapest possible probe: count_tokens costs nothing and validates auth.
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'key rejected (401/403) — make sure it is a valid sk-ant-… key' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
