import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import fs from 'node:fs';
import { logger } from '../logger.js';
import { detectIntent } from '../intent.js';
import { isValidSlug } from '../slug.js';
import type { Orchestrator, TaskOutcome } from '../orchestrator.js';
import type { Store } from '../db.js';
import type { Telemetry } from '../telemetry.js';
import type { DeployEngine } from '../deploy/engine.js';
import type { Stage } from '../types.js';

const STAGE_LABELS: Record<Stage, string> = {
  accepted: '📥 Принял, делаю…',
  generating: '🤖 Генерирую код',
  committing: '💾 Коммичу изменения',
  building: '🔨 Собираю образ',
  deploying: '🚀 Деплою',
  checking: '🔍 Проверяю, что сервис отвечает',
  screenshot: '📸 Делаю скриншот',
  done: '✅ Готово',
  failed: '❌ Ошибка',
};

const HEARTBEAT_MS = 25_000; // never silent longer than 30s (§4 EPIC B)

/**
 * Telegram Gateway (§2): long polling, owner whitelist, commands + free text.
 */
export class TelegramGateway {
  private bot: Bot;
  /** slug awaiting a second-message confirmation for /delete (§5). */
  private pendingDelete = new Map<number, string>();
  /** free text awaiting "new or edit?" disambiguation, keyed by chat; messageId guards stale buttons. */
  private pendingAmbiguous = new Map<number, { messageId: number; text: string }>();

  constructor(
    private token: string,
    private ownerIds: number[],
    private orchestrator: Orchestrator,
    private store: Store,
    private deployEngine: DeployEngine,
    private telemetry: Telemetry,
  ) {
    this.bot = new Bot(token);
    this.wire();
  }

  private isOwner(ctx: Context): boolean {
    return !!ctx.from && this.ownerIds.includes(ctx.from.id);
  }

  private wire(): void {
    // AC-D4: non-whitelisted users get a flat refusal, zero project info.
    this.bot.use(async (ctx, next) => {
      if (!this.isOwner(ctx)) {
        logger.warn('rejected non-owner message', { from: ctx.from?.id });
        if (ctx.message) await ctx.reply('Это приватный бот. Доступ только у владельца.');
        return;
      }
      await this.telemetry.onActivity();
      await next();
    });

    this.bot.command('start', (ctx) =>
      ctx.reply(
        [
          'Привет! Я Botsman — деплою веб-сервисы по описанию.',
          '',
          'Просто напиши, какой сервис нужен, например:',
          '«сделай TODO-сервис со списком задач и возможностью отмечать выполненные»',
          '',
          'Через несколько минут пришлю ссылку и скриншот. Правки — тем же чатом.',
          '',
          'Команды:',
          '/list — все проекты',
          '/status <slug> — статус и git-доступ',
          '/logs <slug> — логи контейнера',
          '/rollback <slug> — откат на предыдущую версию',
          '/delete <slug> — удалить проект',
        ].join('\n'),
      ),
    );

    this.bot.command('list', async (ctx) => {
      const projects = this.store.listProjects();
      if (!projects.length) {
        await ctx.reply('Проектов пока нет. Опиши сервис — и я его создам.');
        return;
      }
      const lines = await Promise.all(
        projects.map(async (p) => {
          const running = p.status === 'live'
            ? await this.deployEngine.containerRunning(p.slug).catch(() => false)
            : false;
          const mark = p.status === 'live' ? (running ? '🟢' : '🟡 (контейнер упал)') : statusEmoji(p.status);
          return `${mark} *${p.slug}* — ${p.status}\nhttps://${p.domain}/`;
        }),
      );
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    });

    this.bot.command('status', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Использование: /status <slug>');
      const text = await this.orchestrator.statusText(slug);
      if (!text) return void ctx.reply(`Проект ${slug} не найден.`);
      await this.replyMdSafe(ctx, text);
    });

    this.bot.command('logs', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Использование: /logs <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Проект ${slug} не найден.`);
      const logs = await this.deployEngine.containerLogs(slug, 50).catch((e) => `Ошибка: ${e.message}`);
      await this.replyMdSafe(ctx, `Логи ${slug} (последние строки):\n\`\`\`\n${logs.slice(-3500) || '(пусто)'}\n\`\`\``);
    });

    this.bot.command('rollback', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Использование: /rollback <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Проект ${slug} не найден.`);
      await this.runTask('rollback', slug, 'rollback', ctx);
    });

    this.bot.command('delete', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Использование: /delete <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Проект ${slug} не найден.`);
      this.pendingDelete.set(ctx.chat!.id, slug);
      await ctx.reply(
        `⚠️ Удалить проект *${slug}* вместе с базой данных и кодом? Это необратимо.\n\nОтветь «да» для подтверждения, что-либо другое — отмена.`,
        { parse_mode: 'Markdown' },
      );
    });

    // Disambiguation buttons for free text.
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.chat?.id;
      await ctx.answerCallbackQuery();
      if (!chatId) return;
      const pending = this.pendingAmbiguous.get(chatId);
      // A click on an outdated question must not apply the latest text.
      if (!pending || pending.messageId !== ctx.callbackQuery.message?.message_id) {
        return void ctx.reply('Эта кнопка устарела, напиши запрос заново.');
      }
      this.pendingAmbiguous.delete(chatId);
      if (data === 'intent:new') {
        await this.runTask('create', undefined, pending.text, ctx);
      } else if (data.startsWith('intent:edit:')) {
        await this.runTask('edit', data.slice('intent:edit:'.length), pending.text, ctx);
      }
    });

    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();

      // /delete confirmation flow (second message, §5).
      const pending = this.pendingDelete.get(chatId);
      if (pending) {
        this.pendingDelete.delete(chatId);
        if (/^(да|yes|y)\.?$/i.test(text)) {
          const outcome = await this.orchestrator.enqueue('delete', '', () => {}, pending);
          await ctx.reply(outcome.ok ? `🗑 ${outcome.summary}` : `❌ ${outcome.error}`);
        } else {
          await ctx.reply('Удаление отменено.');
        }
        return;
      }

      const intent = detectIntent(
        text,
        this.store.listProjects().map((p) => p.slug),
        this.store.kvGet(`last_active:${chatId}`),
      );

      if (intent.kind === 'ambiguous') {
        const kb = new InlineKeyboard().text('🆕 Новый сервис', 'intent:new');
        if (intent.lastSlug && this.store.projectExists(intent.lastSlug)) {
          kb.text(`✏️ Правка ${intent.lastSlug}`, `intent:edit:${intent.lastSlug}`);
        }
        const sent = await ctx.reply('Это новый сервис или правка существующего?', { reply_markup: kb });
        this.pendingAmbiguous.set(chatId, { messageId: sent.message_id, text });
        return;
      }

      if (intent.kind === 'create') {
        await this.runTask('create', undefined, intent.description, ctx);
      } else {
        await this.runTask('edit', intent.slug, intent.instruction, ctx);
      }
    });

    this.bot.catch((err) => logger.error('telegram handler error', { error: String(err.error) }));
  }

  /** Run a long task with a live-updating status message + 30s heartbeat. */
  private async runTask(
    kind: 'create' | 'edit' | 'rollback',
    slug: string | undefined,
    instruction: string,
    ctx: Context,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    const queued = this.orchestrator.queueLength > 0 ? ' (в очереди за текущей задачей)' : '';
    const statusMsg = await ctx.reply(`${STAGE_LABELS.accepted}${queued}`);

    let lastText = STAGE_LABELS.accepted;
    let dots = 0;
    const update = async (text: string) => {
      lastText = text;
      dots = 0;
      await this.bot.api.editMessageText(chatId, statusMsg.message_id, text).catch(() => {});
    };
    // Heartbeat: append dots so the user sees progress even in long stages (AC-F2 responsiveness).
    const heartbeat = setInterval(() => {
      dots = (dots % 3) + 1;
      void this.bot.api
        .editMessageText(chatId, statusMsg.message_id, `${lastText}${'.'.repeat(dots)}`)
        .catch(() => {});
    }, HEARTBEAT_MS);

    try {
      const outcome = await this.orchestrator.enqueue(
        kind,
        instruction,
        (stage, detail) => {
          if (stage === 'accepted' && detail) slug = detail;
          void update(`${STAGE_LABELS[stage]}${detail && stage !== 'accepted' ? ` — ${detail}` : ''}`);
        },
        slug,
      );
      clearInterval(heartbeat);
      await this.reportOutcome(ctx, chatId, statusMsg.message_id, outcome);
      if (outcome.slug) this.store.kvSet(`last_active:${chatId}`, outcome.slug);
    } catch (e) {
      clearInterval(heartbeat);
      await update(`${STAGE_LABELS.failed} — ${(e as Error).message}`);
    }
  }

  private async reportOutcome(ctx: Context, chatId: number, statusMsgId: number, o: TaskOutcome): Promise<void> {
    if (!o.ok) {
      await this.bot.api.editMessageText(
        chatId, statusMsgId,
        `❌ Не получилось с «${o.slug}»:\n\n${(o.error ?? 'неизвестная ошибка').slice(0, 3000)}`,
      ).catch(() => {});
      return;
    }
    const lines = [`✅ *${o.slug}* — задеплоен`];
    if (o.url) lines.push(o.url);
    if (o.summary) lines.push('', o.summary.slice(0, 2000));
    if (o.warning) lines.push('', `⚠️ ${o.warning}`);
    if (o.costUsd && o.costUsd > 0) lines.push('', `💸 Токены: ≈$${o.costUsd.toFixed(2)}`);
    lines.push('', 'Что поправить?');
    await this.bot.api.editMessageText(chatId, statusMsgId, lines.join('\n'), {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    }).catch(async () => {
      // Markdown in agent summaries can be malformed — retry as plain text.
      await this.bot.api.editMessageText(chatId, statusMsgId, lines.join('\n')).catch(() => {});
    });
    if (o.screenshotPath && fs.existsSync(o.screenshotPath)) {
      await ctx.replyWithPhoto(new InputFile(o.screenshotPath)).catch((e) =>
        logger.warn('screenshot send failed', { error: String(e) }),
      );
    }
  }

  /** Markdown with arbitrary content (logs, commit subjects) may not parse — fall back to plain. */
  private async replyMdSafe(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    } catch {
      await ctx.reply(text).catch(() => {});
    }
  }

  private argSlug(ctx: Context): string | null {
    const arg = (ctx.match as string | undefined)?.trim() ?? '';
    return isValidSlug(arg) ? arg : null;
  }

  /** Notify the owner out-of-band (push-to-deploy results). */
  async notifyOwner(text: string): Promise<void> {
    for (const id of this.ownerIds) {
      await this.bot.api.sendMessage(id, text).catch(() => {});
    }
  }

  async start(): Promise<void> {
    // Long polling (§2): no public IP / webhook needed.
    void this.bot.start({
      onStart: (me) => logger.info('telegram gateway started', { username: me.username }),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'live': return '🟢';
    case 'failed': return '🔴';
    case 'stopped': return '⚪️';
    default: return '🟠';
  }
}
