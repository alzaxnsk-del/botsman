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
  const apiKey = typeof c.anthropicApiKey === 'string' ? c.anthropicApiKey : undefined;
  const oauthToken = typeof c.claudeCodeOauthToken === 'string' ? c.claudeCodeOauthToken : undefined;
  if (!apiKey && !oauthToken) {
    problems.push(
      'agent auth: set anthropicApiKey (sk-ant-api…) or claudeCodeOauthToken (sk-ant-oat…, from `claude setup-token`)',
    );
  }
  if (apiKey && apiKey.length < 20) {
    problems.push('anthropicApiKey: expected an Anthropic API key (sk-ant-...)');
  }
  if (oauthToken && !/^sk-ant-oat/.test(oauthToken)) {
    problems.push('claudeCodeOauthToken: expected a token from `claude setup-token` (sk-ant-oat…)');
  }
  if (typeof c.baseDomain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.baseDomain)) {
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
    baseDomain: (c.baseDomain as string).toLowerCase(),
    telemetry: {
      enabled: telemetryRaw.enabled === true, // strictly opt-in, default OFF
      endpoint: typeof telemetryRaw.endpoint === 'string' ? telemetryRaw.endpoint : undefined,
    },
    agent: (c.agent as BotsmanConfig['agent']) ?? {},
    docker: (c.docker as BotsmanConfig['docker']) ?? {},
    // Default: unix socket shared with the caddy container via a volume —
    // unreachable from deployed services (§5). http:// URLs work for dev.
    caddyAdminUrl:
      typeof c.caddyAdminUrl === 'string'
        ? c.caddyAdminUrl
        : process.env.CADDY_ADMIN_URL ?? 'unix:/run/caddy/admin.sock',
  };
}

export function saveConfig(config: BotsmanConfig): void {
  const file = paths.configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600); // enforce even if file pre-existed
}
