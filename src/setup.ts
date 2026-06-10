import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { saveConfig, validateConfig, ConfigError } from './config.js';
import { paths } from './paths.js';
import { checkTelegramToken, checkAnthropicKey } from './preflight.js';

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

    const anthropicApiKey = (await rl.question(
      '3/5 Anthropic API key (sk-ant-…, console.anthropic.com): ',
    )).trim();
    say('    Checking the key…');
    const an = await checkAnthropicKey(anthropicApiKey);
    if (!an.ok) {
      say(`    ERROR: ${an.error}`);
      say('    Setup is not complete. Get a working key and run the wizard again: botsman setup');
      return 1;
    }
    say('    ✓ key is valid');

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
