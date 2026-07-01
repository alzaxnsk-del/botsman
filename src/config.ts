import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import type { BotsmanConfig } from './types.js';

export class ConfigError extends Error {}

export function configExists(): boolean {
  return fs.existsSync(paths.configFile());
}

export function loadConfig(): BotsmanConfig {
  const file = paths.configFile();
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `Config not found at ${file}. Run "botsman setup" first.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Config at ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): BotsmanConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('Config must be a JSON object');
  }
  const c = raw as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof c.telegramBotToken !== 'string' || !/^\d+:[\w-]{30,}$/.test(c.telegramBotToken)) {
    problems.push('telegramBotToken: expected "<digits>:<token>" from @BotFather');
  }
  const ownerIds = Array.isArray(c.ownerIds) ? c.ownerIds : [];
  if (!ownerIds.length || !ownerIds.every((v) => Number.isInteger(v) && (v as number) > 0)) {
    problems.push('ownerIds: expected non-empty array of positive Telegram user IDs');
  }
  // Auth and domain are OPTIONAL here: the console bootstrap saves only the
  // bot token + owner ID, the rest arrives via in-chat onboarding. Formats
  // are still validated when the fields are present.
  const apiKey = typeof c.anthropicApiKey === 'string' && c.anthropicApiKey ? c.anthropicApiKey : undefined;
  const oauthToken = typeof c.claudeCodeOauthToken === 'string' && c.claudeCodeOauthToken ? c.claudeCodeOauthToken : undefined;
  if (apiKey && apiKey.length < 20) {
    problems.push('anthropicApiKey: expected an Anthropic API key (sk-ant-...)');
  }
  if (oauthToken && !/^sk-ant-oat/.test(oauthToken)) {
    problems.push('claudeCodeOauthToken: expected a token from `claude setup-token` (sk-ant-oat…)');
  }
  const baseDomain = typeof c.baseDomain === 'string' && c.baseDomain ? c.baseDomain : undefined;
  if (baseDomain && !isValidDomain(baseDomain)) {
    problems.push('baseDomain: expected a domain like "apps.example.com"');
  }
  if (problems.length) {
    throw new ConfigError(`Invalid config:\n  - ${problems.join('\n  - ')}`);
  }

  const telemetryRaw = (c.telemetry ?? {}) as Record<string, unknown>;
  return {
    telegramBotToken: c.telegramBotToken as string,
    ownerIds: ownerIds as number[],
    anthropicApiKey: apiKey,
    claudeCodeOauthToken: oauthToken,
    baseDomain: baseDomain?.toLowerCase(),
    telemetry: {
      enabled: telemetryRaw.enabled === true, // strictly opt-in, default OFF
      endpoint: typeof telemetryRaw.endpoint === 'string' ? telemetryRaw.endpoint : undefined,
    },
    agent: (c.agent as BotsmanConfig['agent']) ?? {},
    // Pass through as-is (optional STT). Kept in the returned object so an
    // updateConfigFile() merge — e.g. /setup saving the Whisper key — doesn't
    // silently drop it on the next rewrite.
    transcription: c.transcription as BotsmanConfig['transcription'],
    docker: (c.docker as BotsmanConfig['docker']) ?? {},
    // Default: unix socket shared with the caddy container via a volume —
    // unreachable from deployed services (§5). http:// URLs work for dev.
    caddyAdminUrl:
      typeof c.caddyAdminUrl === 'string'
        ? c.caddyAdminUrl
        : process.env.CADDY_ADMIN_URL ?? 'unix:/run/caddy/admin.sock',
  };
}

export function isValidDomain(s: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
}

/** Which onboarding pieces are still missing (asked for in the Telegram chat). */
export function missingSetup(config: BotsmanConfig): Array<'auth' | 'domain'> {
  const missing: Array<'auth' | 'domain'> = [];
  if (!config.anthropicApiKey && !config.claudeCodeOauthToken) missing.push('auth');
  if (!config.baseDomain) missing.push('domain');
  return missing;
}

export function saveConfig(config: BotsmanConfig): void {
  const file = paths.configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600); // enforce even if file pre-existed
}

/**
 * Merge a patch into config.json on disk (used by in-chat onboarding: each
 * completed step persists immediately, so the config file IS the wizard
 * state — a restart resumes at the first missing field).
 */
export function updateConfigFile(patch: Record<string, unknown>): BotsmanConfig {
  const file = paths.configFile();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* start from scratch */ }
  const merged = { ...raw, ...patch };
  // undefined values mean "remove the field" (e.g. /setup clearing auth).
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  const validated = validateConfig(merged);
  saveConfig(validated);
  return validated;
}
