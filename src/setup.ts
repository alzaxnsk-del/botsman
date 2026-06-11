import readline from 'node:readline/promises';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { stdin, stdout } from 'node:process';
import { saveConfig, validateConfig, ConfigError } from './config.js';
import { paths } from './paths.js';
import { checkTelegramToken, checkAnthropicKey, checkClaudeOauthToken } from './preflight.js';
import { banner, stepHeader, ok, bad, hint, divider, say, c, PROMPT } from './ui.js';

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
  const prev = loadExistingConfig();

  const ask = async (label: string, current?: string): Promise<string> => {
    const hintStr = current ? c.dim(` [Enter = keep ${current}]`) : '';
    const a = (await rl.question(`${PROMPT}${label}${hintStr}: `)).trim();
    return a || current || '';
  };

  // NB: collected via the 'line' event, NOT rl.question in a loop — readline
  // drops lines that arrive between questions, so a fast multi-line paste
  // would lose every chunk after the first.
  const askSecret = (label: string, current?: string): Promise<string> => {
    const hintStr = current ? c.dim(` [Enter = keep ${mask(current)}]`) : '';
    say(`${PROMPT}${label}${hintStr}`);
    hint('paste the value (multi-line is fine), then press Enter on an empty line');
    stdout.write(PROMPT);
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
          stdout.write(PROMPT); // nothing pasted yet — keep waiting
          return;
        }
        parts.push(line);
        stdout.write(PROMPT);
      };
      rl.on('line', onLine);
    });
  };

  banner('Setup wizard — five quick steps, ~2 minutes');
  hint(`Config will be saved to ${paths.configFile()} (chmod 600)`);
  if (prev) hint('Existing config found — press Enter at any prompt to keep the current value');

  try {
    stepHeader(1, 5, 'Telegram bot token');
    hint('Create a bot with @BotFather and paste its token.');
    const telegramBotToken = await askSecret('Bot token', prev?.telegramBotToken);
    hint('checking…');
    const tg = await checkTelegramToken(telegramBotToken);
    if (!tg.ok) {
      bad(`The token does not work (${tg.error}).`);
      hint('Run the wizard again: botsman setup');
      return 1;
    }
    ok('token is valid');

    stepHeader(2, 5, 'Your Telegram user ID');
    hint('Ask @userinfobot — it replies with your numeric ID. Only this account will be served.');
    const ownerIdRaw = await ask('User ID', prev?.ownerIds?.[0] ? String(prev.ownerIds[0]) : undefined);
    const ownerId = Number(ownerIdRaw);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      bad('A positive number expected.');
      hint('Run the wizard again: botsman setup');
      return 1;
    }
    ok(`owner: ${ownerId}`);

    stepHeader(3, 5, 'Coding agent auth');
    say(`    ${c.bold('1.')} Claude subscription (Pro/Max) — ${c.dim('no extra API bills, uses your plan limits')}`);
    say(`       ${c.dim('run `claude setup-token` where you are logged into Claude Code, paste the sk-ant-oat… token')}`);
    say(`    ${c.bold('2.')} Anthropic API key — ${c.dim('pay-per-use, sk-ant-api…, console.anthropic.com')}`);
    const prevAuth = prev?.claudeCodeOauthToken ? '1' : prev?.anthropicApiKey ? '2' : undefined;
    const authChoice = await ask('Choose 1 or 2', prevAuth);

    let anthropicApiKey: string | undefined;
    let claudeCodeOauthToken: string | undefined;
    if (authChoice === '1') {
      claudeCodeOauthToken = await askSecret('Subscription token (sk-ant-oat…)', prev?.claudeCodeOauthToken);
      if (!/^sk-ant-oat/.test(claudeCodeOauthToken)) {
        bad('That does not look like a `claude setup-token` value (must start with sk-ant-oat).');
        hint('If the paste got mangled, run the wizard again — multi-line paste is supported.');
        return 1;
      }
      hint('checking — runs a tiny Claude Code request, ~15s…');
      const probe = await checkClaudeOauthToken(claudeCodeOauthToken);
      if (!probe.ok) {
        bad(`The token does not work (${probe.error}).`);
        hint('Generate a fresh one with `claude setup-token` and run the wizard again: botsman setup');
        return 1;
      }
      ok('token is valid — usage counts against your subscription limits');
    } else if (authChoice === '2') {
      anthropicApiKey = await askSecret('API key (sk-ant-…)', prev?.anthropicApiKey);
      hint('checking…');
      const an = await checkAnthropicKey(anthropicApiKey);
      if (!an.ok) {
        bad(`${an.error}`);
        hint('Get a working key and run the wizard again: botsman setup');
        return 1;
      }
      ok('key is valid');
    } else {
      bad('Expected 1 or 2.');
      hint('Run the wizard again: botsman setup');
      return 1;
    }

    stepHeader(4, 5, 'Base domain');
    hint('e.g. apps.example.com — every project gets its own subdomain under it.');
    hint('At your DNS provider create a wildcard A-record:');
    hint('  type A · host *.apps (or * if the whole domain is for Botsman) · value = this server\'s IP');
    hint('Cloudflare: the record must be "DNS only" (grey cloud), NOT Proxied.');
    const baseDomain = (await ask('Base domain', prev?.baseDomain)).toLowerCase();
    hint('checking the wildcard DNS record…');
    try {
      await dns.lookup(`botsman-dns-probe.${baseDomain}`);
      ok('wildcard DNS resolves');
    } catch {
      bad(`botsman-dns-probe.${baseDomain} does not resolve yet.`);
      hint('Links and TLS will not work until the record exists (propagation may take minutes).');
      hint('Setup continues — you can add the record later.');
    }

    stepHeader(5, 5, 'Anonymous telemetry');
    hint('Strictly opt-in. Only lifecycle facts (installed / first deploy / returned after a week) —');
    hint('never code, prompts or project content. Off by default.');
    const prevTelemetry = prev ? (prev.telemetry?.enabled ? 'y' : 'n') : undefined;
    const telemetryAnswer = (await ask('Allow? y/N', prevTelemetry)).toLowerCase();
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

    say();
    divider();
    say();
    say(`  ${c.green(c.bold('✓ All set!'))}`);
    say();
    ok(`config saved: ${paths.configFile()}`);
    ok(`telemetry: ${telemetryEnabled ? 'on (disable in config: "telemetry": {"enabled": false})' : 'off'}`);
    hint('The daemon starts automatically when installed via install.sh (or run: docker compose up -d).');
    say();
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      bad(`Config error: ${e.message}`);
      return 1;
    }
    bad(`${(e as Error).message}`);
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
