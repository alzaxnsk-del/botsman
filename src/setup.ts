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
  say('=== Botsman — мастер настройки ===');
  say(`Конфиг будет сохранён в ${paths.configFile()} (chmod 600).`);
  say('');

  try {
    const telegramBotToken = (await rl.question(
      '1/5 Telegram bot token (создай бота у @BotFather): ',
    )).trim();
    say('    Проверяю токен…');
    const tg = await checkTelegramToken(telegramBotToken);
    if (!tg.ok) {
      say(`    ОШИБКА: токен не работает (${tg.error}). Запусти мастер заново: botsman setup`);
      return 1;
    }
    say('    ✓ токен валиден');

    const ownerIdRaw = (await rl.question(
      '2/5 Твой Telegram user ID (узнать: напиши @userinfobot): ',
    )).trim();
    const ownerId = Number(ownerIdRaw);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      say('    ОШИБКА: ожидается положительное число. Запусти мастер заново: botsman setup');
      return 1;
    }

    const anthropicApiKey = (await rl.question(
      '3/5 Anthropic API key (sk-ant-…, console.anthropic.com): ',
    )).trim();
    say('    Проверяю ключ…');
    const an = await checkAnthropicKey(anthropicApiKey);
    if (!an.ok) {
      say(`    ОШИБКА: ${an.error}`);
      say('    Установка не завершена. Получи рабочий ключ и запусти мастер заново: botsman setup');
      return 1;
    }
    say('    ✓ ключ валиден');

    const baseDomain = (await rl.question(
      '4/5 Базовый домен для сервисов (например apps.example.com;\n    нужна DNS-запись *.apps.example.com → IP этого сервера): ',
    )).trim().toLowerCase();

    const telemetryAnswer = (await rl.question(
      '5/5 Разрешить анонимную телеметрию? Только факты «установлен / первый деплой /\n    вернулся через неделю», без кода и промптов. [y/N]: ',
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
    say(`✓ Конфиг сохранён: ${paths.configFile()}`);
    say('✓ Телеметрия: ' + (telemetryEnabled ? 'ВКЛ (отключить: "telemetry": {"enabled": false} в конфиге)' : 'выкл'));
    say('');
    say('Дальше: запусти демон (или он стартует сам, если установка шла через install.sh):');
    say('  docker compose up -d');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      say(`ОШИБКА конфигурации: ${e.message}`);
      return 1;
    }
    say(`ОШИБКА: ${(e as Error).message}`);
    return 1;
  } finally {
    rl.close();
  }
}
