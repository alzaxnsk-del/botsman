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
    updateCheck: c.updateCheck as BotsmanConfig['updateCheck'],
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

/** Auto update-check is ON unless the owner explicitly turned it off in /setup. */
export function updateCheckEnabled(config: BotsmanConfig): boolean {
  return config.updateCheck?.enabled !== false;
}

/**
 * Merge fields to back up into the single /setup restore slot, FIRST-CAPTURE
 * WINS: a field already present in the backup is never overwritten. This makes
 * two things safe: (1) changing auth AND domain before the restart preserves
 * both prior values (no single-slot clobber), and (2) re-tapping the SAME item
 * can't overwrite the real backed-up value with the now-cleared `undefined`.
 * A corrupt/empty existing backup is treated as no backup.
 */
export function mergeSetupBackup(
  existing: string | null | undefined,
  patch: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try { base = JSON.parse(existing) as Record<string, unknown>; } catch { /* start fresh */ }
  }
  const merged = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in merged)) merged[k] = v; // don't clobber an earlier capture
  }
  return JSON.stringify(merged);
}

/**
 * Turn a saved /setup backup blob into the patch to apply on /cancel (restore).
 * Crucial fix: the coding-agent auth is a MUTUALLY-EXCLUSIVE pair
 * (anthropicApiKey ⟂ claudeCodeOauthToken). When only one was set, the other is
 * `undefined` and JSON.stringify DROPS it from the backup — so a naive restore
 * would leave whatever method the user switched INTO during the reconfig still
 * set, contradicting "kept your previous settings". Here we re-add the missing
 * half of the auth pair as an explicit `undefined`, which updateConfigFile
 * deletes — so restore fully returns to the pre-reconfig auth. Non-auth fields
 * (baseDomain) are passed through unchanged. Returns null for a missing/corrupt
 * blob (nothing to restore).
 */
export function restoreSetupBackupPatch(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  let patch: Record<string, unknown>;
  try { patch = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if ('anthropicApiKey' in patch || 'claudeCodeOauthToken' in patch) {
    if (!('anthropicApiKey' in patch)) patch.anthropicApiKey = undefined;
    if (!('claudeCodeOauthToken' in patch)) patch.claudeCodeOauthToken = undefined;
  }
  return patch;
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
