import readline from 'node:readline/promises';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { stdin, stdout } from 'node:process';
import { saveConfig, validateConfig, ConfigError } from './config.js';
import { paths } from './paths.js';
import { checkTelegramToken, checkAnthropicKey, checkClaudeOauthToken } from './preflight.js';

/**
 * Interactive first-run wizard (§4 EPIC A). Validates tokens with live probes
 * and exits with a clear message — never a traceback — on bad input (AC-A3).
 *
 * Re-runs are cheap: existing config values are offered as defaults (Enter
 * keeps them). Secret prompts accept multi-line paste: long tokens copied from
 * a terminal arrive with embedded line breaks, so we collect lines until an
 * empty one and strip all whitespace.
 */
export async function runSetupWizard(): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const say = (s: string) => stdout.write(s + '\n');
  const prev = loadExistingConfig();

  const ask = async (prompt: string, current?: string): Promise<string> => {
    const hint = current ? ` [Enter = keep ${current}]` : '';
    const a = (await rl.question(`${prompt}${hint}: `)).trim();
    return a || current || '';
  };

  // NB: collected via the 'line' event, NOT rl.question in a loop — readline
  // drops lines that arrive between questions, so a fast multi-line paste
  // would lose every chunk after the first.
  const askSecret = (prompt: string, current?: string): Promise<string> => {
    const hint = current ? ` [Enter = keep ${mask(current)}]` : '';
    say(`${prompt}${hint}`);
    say('    (paste the value — a multi-line paste is fine — then press Enter on an empty line)');
    stdout.write('    > ');
    return new Promise((resolve) => {
      const parts: string[] = [];
      const onLine = (raw: string) => {
        const line = raw.replace(/\s+/g, '');
        if (!line) {
          if (parts.length) {
            rl.off('line', onLine);
            resolve(parts.join(''));
            return;
          }
          if (current) {
            rl.off('line', onLine);
            resolve(current);
            return;
          }
          stdout.write('    > '); // nothing pasted yet — keep waiting
          return;
        }
        parts.push(line);
        stdout.write('    > ');
      };
      rl.on('line', onLine);
    });
  };

  say('');
  say('=== Botsman setup wizard ===');
  say(`The config will be saved to ${paths.configFile()} (chmod 600).`);
  if (prev) say('Existing config found — press Enter at any prompt to keep the current value.');
  say('');

  try {
    const telegramBotToken = await askSecret(
      '1/5 Telegram bot token (create a bot with @BotFather)',
      prev?.telegramBotToken,
    );
    say('    Checking the token…');
    const tg = await checkTelegramToken(telegramBotToken);
    if (!tg.ok) {
      say(`    ERROR: the token does not work (${tg.error}). Run the wizard again: botsman setup`);
      return 1;
    }
    say('    ✓ token is valid');

    const ownerIdRaw = await ask(
      '2/5 Your Telegram user ID (ask @userinfobot)',
      prev?.ownerIds?.[0] ? String(prev.ownerIds[0]) : undefined,
    );
    const ownerId = Number(ownerIdRaw);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      say('    ERROR: a positive number expected. Run the wizard again: botsman setup');
      return 1;
    }

    say('3/5 How should the coding agent authenticate?');
    say('    1) Claude subscription (Pro/Max) — no extra API bills, uses your plan limits.');
    say('       Run `claude setup-token` on a machine where you are logged into Claude Code,');
    say('       and paste the resulting token (sk-ant-oat…).');
    say('    2) Anthropic API key (sk-ant-api…, pay-per-use, console.anthropic.com).');
    const prevAuth = prev?.claudeCodeOauthToken ? '1' : prev?.anthropicApiKey ? '2' : undefined;
    const authChoice = await ask('    Choose [1/2]', prevAuth);

    let anthropicApiKey: string | undefined;
    let claudeCodeOauthToken: string | undefined;
    if (authChoice === '1') {
      claudeCodeOauthToken = await askSecret(
        '    Subscription token (sk-ant-oat…)',
        prev?.claudeCodeOauthToken,
      );
      if (!/^sk-ant-oat/.test(claudeCodeOauthToken)) {
        say('    ERROR: that does not look like a `claude setup-token` value (must start with sk-ant-oat).');
        say('    If the paste got mangled, try again — multi-line paste is supported.');
        return 1;
      }
      say('    Checking the token (runs a tiny Claude Code request, ~15s)…');
      const probe = await checkClaudeOauthToken(claudeCodeOauthToken);
      if (!probe.ok) {
        say(`    ERROR: the token does not work (${probe.error}).`);
        say('    Setup is not complete. Generate a fresh token with `claude setup-token` and run the wizard again: botsman setup');
        return 1;
      }
      say('    ✓ token is valid (usage will count against your subscription limits)');
    } else if (authChoice === '2') {
      anthropicApiKey = await askSecret('    Anthropic API key (sk-ant-…)', prev?.anthropicApiKey);
      say('    Checking the key…');
      const an = await checkAnthropicKey(anthropicApiKey);
      if (!an.ok) {
        say(`    ERROR: ${an.error}`);
        say('    Setup is not complete. Get a working key and run the wizard again: botsman setup');
        return 1;
      }
      say('    ✓ key is valid');
    } else {
      say('    ERROR: expected 1 or 2. Run the wizard again: botsman setup');
      return 1;
    }

    say('4/5 Base domain for your services (e.g. apps.example.com).');
    say('    At your DNS provider, create a wildcard A-record pointing at THIS server:');
    say('      type: A    host: *.apps (or just * if the whole domain is for Botsman)');
    say('      value: <this server\'s public IP>');
    say('    Verify with: dig +short anything.apps.example.com');
    const baseDomain = (await ask('    Base domain', prev?.baseDomain)).toLowerCase();
    say('    Checking the wildcard DNS record…');
    try {
      await dns.lookup(`botsman-dns-probe.${baseDomain}`);
      say('    ✓ wildcard DNS resolves');
    } catch {
      say(`    WARNING: botsman-dns-probe.${baseDomain} does not resolve yet.`);
      say('    Links and TLS will not work until the wildcard record exists.');
      say('    Setup continues — the record can be added later (propagation may take minutes).');
    }

    const prevTelemetry = prev ? (prev.telemetry?.enabled ? 'y' : 'n') : undefined;
    const telemetryAnswer = (await ask(
      '5/5 Allow anonymous telemetry? Only lifecycle facts (installed / first deploy /\n    returned after a week), never code or prompts. [y/N]',
      prevTelemetry,
    )).toLowerCase();
    const telemetryEnabled = telemetryAnswer === 'y' || telemetryAnswer === 'yes' || telemetryAnswer === 'да';

    const config = validateConfig({
      telegramBotToken,
      ownerIds: [ownerId],
      anthropicApiKey,
      claudeCodeOauthToken,
      baseDomain,
      telemetry: { enabled: telemetryEnabled, endpoint: prev?.telemetry?.endpoint },
    });
    saveConfig(config);
    say('');
    say(`✓ Config saved: ${paths.configFile()}`);
    say('✓ Telemetry: ' + (telemetryEnabled ? 'ON (disable with "telemetry": {"enabled": false} in the config)' : 'off'));
    say('');
    say('Next: start the daemon (it starts automatically when installed via install.sh):');
    say('  docker compose up -d');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      say(`CONFIG ERROR: ${e.message}`);
      return 1;
    }
    say(`ERROR: ${(e as Error).message}`);
    return 1;
  } finally {
    rl.close();
  }
}

interface ExistingConfig {
  telegramBotToken?: string;
  ownerIds?: number[];
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  baseDomain?: string;
  telemetry?: { enabled?: boolean; endpoint?: string };
}

function loadExistingConfig(): ExistingConfig | null {
  try {
    return JSON.parse(fs.readFileSync(paths.configFile(), 'utf8')) as ExistingConfig;
  } catch {
    return null;
  }
}

function mask(s: string): string {
  return s.length > 8 ? `…${s.slice(-4)}` : '…';
}
