import readline from 'node:readline/promises';
import fs from 'node:fs';
import { stdin, stdout } from 'node:process';
import { saveConfig, validateConfig, ConfigError } from './config.js';
import { paths } from './paths.js';
import { checkTelegramToken } from './preflight.js';
import { banner, stepHeader, ok, bad, hint, divider, say, c, PROMPT } from './ui.js';

/**
 * Console bootstrap (§4 EPIC A): asks ONLY for the trust channel — the bot
 * token and the owner's Telegram ID. Everything else (agent auth, domain,
 * telemetry) is collected interactively in the Telegram chat, where buttons,
 * live checks and human help are available. Validates the token with a live
 * probe and exits with a clear message — never a traceback (AC-A3).
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

  banner('Two quick questions — the rest happens in the Telegram chat');
  hint(`Config will be saved to ${paths.configFile()} (chmod 600)`);

  try {
    stepHeader(1, 2, 'Telegram bot token');
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

    stepHeader(2, 2, 'Your Telegram user ID');
    hint('Ask @userinfobot — it replies with your numeric ID. Only this account will be served.');
    const ownerIdRaw = await ask('User ID', prev?.ownerIds?.[0] ? String(prev.ownerIds[0]) : undefined);
    const ownerId = Number(ownerIdRaw);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      bad('A positive number expected.');
      hint('Run the wizard again: botsman setup');
      return 1;
    }
    ok(`owner: ${ownerId}`);

    // Preserve everything already configured (re-runs must not lose state).
    const config = validateConfig({
      ...(prev ?? {}),
      telegramBotToken,
      ownerIds: [ownerId],
    });
    saveConfig(config);

    say();
    divider();
    say();
    say(`  ${c.green(c.bold('✓ Saved!'))}`);
    say();
    ok(`config: ${paths.configFile()}`);
    say();
    say(`    ${c.bold('Next:')} open Telegram, find your bot and send ${c.bold('/start')} —`);
    say('    it will walk you through the rest (coding agent, domain) right in the chat.');
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

function loadExistingConfig(): Record<string, unknown> & {
  telegramBotToken?: string;
  ownerIds?: number[];
} | null {
  try {
    return JSON.parse(fs.readFileSync(paths.configFile(), 'utf8'));
  } catch {
    return null;
  }
}

function mask(s: string): string {
  return s.length > 8 ? `…${s.slice(-4)}` : '…';
}
