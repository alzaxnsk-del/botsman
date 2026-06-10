import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { saveConfig, validateConfig, ConfigError } from './config.js';
import { paths } from './paths.js';
import { checkTelegramToken, checkAnthropicKey, checkClaudeOauthToken } from './preflight.js';

/**
 * Interactive first-run wizard (§4 EPIC A). Validates tokens with live probes
 * and exits with a clear message — never a traceback — on bad input (AC-A3).
 */
export async function runSetupWizard(): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const say = (s: string) => stdout.write(s + '\n');

  say('');
  say('=== Botsman setup wizard ===');
  say(`The config will be saved to ${paths.configFile()} (chmod 600).`);
  say('');

  try {
    const telegramBotToken = (await rl.question(
      '1/5 Telegram bot token (create a bot with @BotFather): ',
    )).trim();
    say('    Checking the token…');
    const tg = await checkTelegramToken(telegramBotToken);
    if (!tg.ok) {
      say(`    ERROR: the token does not work (${tg.error}). Run the wizard again: botsman setup`);
      return 1;
    }
    say('    ✓ token is valid');

    const ownerIdRaw = (await rl.question(
      '2/5 Your Telegram user ID (ask @userinfobot): ',
    )).trim();
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
    const authChoice = (await rl.question('    Choose [1/2]: ')).trim();

    let anthropicApiKey: string | undefined;
    let claudeCodeOauthToken: string | undefined;
    if (authChoice === '1') {
      claudeCodeOauthToken = (await rl.question('    Subscription token (sk-ant-oat…): ')).trim();
      say('    Checking the token (runs a tiny Claude Code request, ~15s)…');
      const probe = await checkClaudeOauthToken(claudeCodeOauthToken);
      if (!probe.ok) {
        say(`    ERROR: the token does not work (${probe.error}).`);
        say('    Setup is not complete. Generate a fresh token with `claude setup-token` and run the wizard again: botsman setup');
        return 1;
      }
      say('    ✓ token is valid (usage will count against your subscription limits)');
    } else if (authChoice === '2') {
      anthropicApiKey = (await rl.question('    Anthropic API key (sk-ant-…): ')).trim();
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

    const baseDomain = (await rl.question(
      '4/5 Base domain for your services (e.g. apps.example.com;\n    requires a wildcard DNS record *.apps.example.com → this server\'s IP): ',
    )).trim().toLowerCase();

    const telemetryAnswer = (await rl.question(
      '5/5 Allow anonymous telemetry? Only lifecycle facts (installed / first deploy /\n    returned after a week), never code or prompts. [y/N]: ',
    )).trim().toLowerCase();
    const telemetryEnabled = telemetryAnswer === 'y' || telemetryAnswer === 'yes' || telemetryAnswer === 'да';

    const config = validateConfig({
      telegramBotToken,
      ownerIds: [ownerId],
      anthropicApiKey,
      claudeCodeOauthToken,
      baseDomain,
      telemetry: { enabled: telemetryEnabled },
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
