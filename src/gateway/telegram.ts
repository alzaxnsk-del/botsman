import { Bot, InlineKeyboard, type Context } from 'grammy';
import { InputFile } from 'grammy';
import type Dockerode from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { paths } from '../paths.js';
import { detectIntent, looksLikeCreate } from '../intent.js';
import { isValidSlug } from '../slug.js';
import { runDoctor, type FixId } from '../doctor.js';
import { updateConfigFile } from '../config.js';
import { MODEL_CHOICES, isModelId, modelLabel } from '../agent/models.js';
import { getFocus, setFocus, clearFocus, roomKeyboard, detectRoomSwitch, type Room } from './rooms.js';
import {
  routeMessage, runReadOp, runMutatingOp, looksOperational, looksLikeQuestion, missingSlugPrompt,
  runDevOpsConfirm,
  type DevOpsOp, type DevOpsDeps, type Route,
} from './devops.js';
import type { StructuredLlm } from '../llm.js';
import type { HostExec } from '../hostExec.js';
import { MEMORY_FILE, type Orchestrator, type TaskOutcome } from '../orchestrator.js';
import type { Store } from '../db.js';
import type { Telemetry } from '../telemetry.js';
import type { DeployEngine } from '../deploy/engine.js';
import type { Stage } from '../types.js';

const STAGE_LABELS: Record<Stage, string> = {
  accepted: '📥 Got it, working…',
  generating: '🤖 Generating code',
  committing: '💾 Committing changes',
  building: '🔨 Building the image',
  deploying: '🚀 Deploying',
  checking: '🔍 Checking the service responds',
  screenshot: '📸 Taking a screenshot',
  done: '✅ Done',
  failed: '❌ Failed',
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
  /** DevOps op awaiting a confirm button; messageId guards stale clicks. */
  private pendingDevOps = new Map<number, { messageId: number; op: DevOpsOp; confirmed: boolean }>();

  constructor(
    private token: string,
    private ownerIds: number[],
    private orchestrator: Orchestrator,
    private store: Store,
    private deployEngine: DeployEngine,
    private telemetry: Telemetry,
    private docker: Dockerode,
    private hostExec: HostExec,
    private hostRepoDir: string,
    private structuredLlm?: StructuredLlm,
  ) {
    this.bot = new Bot(token);
    this.wire();
  }

  /** Current coding-agent model from config (for the /setup label). */
  private currentModel(): string | undefined {
    try {
      return updateConfigFile({}).agent?.model;
    } catch {
      return undefined;
    }
  }

  private devopsDeps(): DevOpsDeps {
    return {
      store: this.store,
      docker: this.docker,
      deployEngine: this.deployEngine,
      orchestrator: this.orchestrator,
      hostExec: this.hostExec,
      hostRepoDir: this.hostRepoDir,
    };
  }

  private isOwner(ctx: Context): boolean {
    return !!ctx.from && this.ownerIds.includes(ctx.from.id);
  }

  private wire(): void {
    // AC-D4: non-whitelisted users get a flat refusal, zero project info.
    this.bot.use(async (ctx, next) => {
      if (!this.isOwner(ctx)) {
        logger.warn('rejected non-owner message', { from: ctx.from?.id });
        if (ctx.message) await ctx.reply('This is a private bot. Only its owner can use it.');
        return;
      }
      await this.telemetry.onActivity();
      await next();
    });

    this.bot.command('start', (ctx) =>
      ctx.reply(
        [
          "Hi! I'm Botsman — I build and deploy web services from plain descriptions.",
          '',
          'Just tell me what you need, for example:',
          '"make a TODO service with a task list and the ability to mark tasks done"',
          '',
          "In a few minutes you'll get a link and a screenshot. Iterate in this same chat.",
          '',
          'Just talk — I figure out what you mean:',
          '• "make a TODO app" → builds a new service',
          '• "add a dark theme" → changes the one you\'re working on',
          '• "how is this built?" → answers without deploying',
          '• "show the load" / "restart todo" / "update the server" → server ops (with confirmation)',
          '',
          'The buttons below are shortcuts: 🏠 reset · 🛠 server help · 📦 focus a project.',
          '',
          'Commands:',
          '/list — all projects',
          '/status <slug> — status and git access',
          '/logs <slug> — container logs',
          '/memory <slug> — what the agent remembers about a project',
          '/doctor <slug> — diagnose problems, with one-tap fixes',
          '/rollback <slug> — roll back to the previous version',
          '/delete <slug> — delete a project',
          '/setup — change agent auth, domain or telemetry',
        ].join('\n'),
        { reply_markup: roomKeyboard() },
      ),
    );

    this.bot.command('list', async (ctx) => {
      const projects = this.store.listProjects();
      if (!projects.length) {
        await ctx.reply('No projects yet. Describe a service — and I will build it.', { reply_markup: roomKeyboard() });
        return;
      }
      const lines = await Promise.all(
        projects.map(async (p) => {
          const running = p.status === 'live'
            ? await this.deployEngine.containerRunning(p.slug).catch(() => false)
            : false;
          const mark = p.status === 'live' ? (running ? '🟢' : '🟡 (container down)') : statusEmoji(p.status);
          return `${mark} *${p.slug}* — ${p.status}\nhttps://${p.domain}/`;
        }),
      );
      // Tappable: each project enters its room.
      const kb = new InlineKeyboard();
      for (const p of projects) kb.text(`📦 ${p.slug}`, `room:project:${p.slug}`).row();
      await ctx.reply(lines.join('\n\n'), {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      });
    });

    this.bot.command('status', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /status <slug>');
      const text = await this.orchestrator.statusText(slug);
      if (!text) return void ctx.reply(`Project ${slug} not found.`);
      await this.replyMdSafe(ctx, text);
    });

    this.bot.command('logs', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /logs <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Project ${slug} not found.`);
      const logs = await this.deployEngine.containerLogs(slug, 50).catch((e) => `Error: ${e.message}`);
      await this.replyMdSafe(ctx, `Logs for ${slug} (last lines):\n\`\`\`\n${logs.slice(-3500) || '(empty)'}\n\`\`\``);
    });

    // View the project's memory (CLAUDE.md) — what the agent persists across
    // iterations. Read-only here; edit it via `git clone` + push.
    this.bot.command('memory', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /memory <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Project ${slug} not found.`);
      let content = '';
      try {
        content = fs.readFileSync(path.join(paths.projectDir(slug), MEMORY_FILE), 'utf8');
      } catch {
        return void ctx.reply(`No memory recorded yet for ${slug}.`);
      }
      await this.replyMdSafe(ctx, `Memory for ${slug} (CLAUDE.md):\n\`\`\`\n${content.slice(-3500) || '(empty)'}\n\`\`\``);
    });

    this.bot.command('rollback', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /rollback <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Project ${slug} not found.`);
      await this.runTask('rollback', slug, 'rollback', ctx);
    });

    this.bot.command('delete', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /delete <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Project ${slug} not found.`);
      this.pendingDelete.set(ctx.chat!.id, slug);
      await ctx.reply(
        `⚠️ Delete project *${slug}* together with its database and code? This cannot be undone.\n\nReply "yes" to confirm; anything else cancels.`,
        { parse_mode: 'Markdown' },
      );
    });

    // Re-configuration without a console: clearing a config piece and
    // restarting drops the daemon into in-chat onboarding for that piece.
    this.bot.command('setup', async (ctx) => {
      const kb = new InlineKeyboard()
        .text('🔑 Coding agent auth', 'setup:auth')
        .text('🌐 Domain', 'setup:domain')
        .row()
        .text('🧠 Model', 'setup:model')
        .text('📊 Toggle telemetry', 'setup:telemetry');
      await ctx.reply(`What do you want to change? Current model: ${modelLabel(this.currentModel())}.`, {
        reply_markup: kb,
      });
    });

    // In-chat diagnostics with one-tap fixes (no console needed).
    this.bot.command('doctor', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /doctor <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Project ${slug} not found.`);
      const msg = await ctx.reply(`🩺 Checking ${slug}…`);
      await this.editDoctorReport(ctx.chat!.id, msg.message_id, slug);
    });

    // Buttons: intent disambiguation + doctor fixes.
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.chat?.id;
      if (!chatId) return void ctx.answerCallbackQuery();

      // Model picker: choose, then save+restart (handled in setupmodel: below).
      if (data === 'setup:model') {
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard();
        for (const m of MODEL_CHOICES) kb.text(m.label, `setupmodel:${m.id}`).row();
        await ctx.reply(
          'Pick the model that writes your code:\n' + MODEL_CHOICES.map((m) => `${m.label} — ${m.blurb}`).join('\n'),
          { reply_markup: kb },
        );
        return;
      }
      if (data.startsWith('setupmodel:')) {
        await ctx.answerCallbackQuery();
        const id = data.slice('setupmodel:'.length);
        if (!isModelId(id)) return;
        const cfg = updateConfigFile({});
        updateConfigFile({ agent: { ...cfg.agent, model: id } });
        await ctx.reply(`Switching to ${modelLabel(id)} — restarting to apply (~10s)…`);
        logger.info('setup model change, restarting', { model: id });
        setTimeout(() => process.exit(0), 1500);
        return;
      }

      if (data.startsWith('setup:')) {
        await ctx.answerCallbackQuery();
        const what = data.slice('setup:'.length);
        if (what === 'auth') {
          updateConfigFile({ anthropicApiKey: undefined, claudeCodeOauthToken: undefined });
          await ctx.reply('Restarting into setup — I will ask for the new agent auth here in ~10s…');
        } else if (what === 'domain') {
          updateConfigFile({ baseDomain: undefined });
          await ctx.reply('Restarting into setup — I will ask for the new domain here in ~10s…\n(existing projects keep their current addresses)');
        } else if (what === 'telemetry') {
          const cfg = updateConfigFile({});
          const enabled = !cfg.telemetry.enabled;
          updateConfigFile({ telemetry: { ...cfg.telemetry, enabled } });
          await ctx.reply(`Telemetry will be ${enabled ? 'ON' : 'OFF'} — restarting to apply (~10s)…`);
        } else {
          return;
        }
        logger.info('setup change requested, restarting', { what });
        setTimeout(() => process.exit(0), 1500);
        return;
      }

      if (data.startsWith('fix:')) {
        const [, action, slug] = data.split(':');
        if (!slug || !this.store.projectExists(slug)) {
          return void ctx.answerCallbackQuery({ text: 'Project no longer exists.' });
        }
        await ctx.answerCallbackQuery({ text: 'Working…' });
        const msgId = ctx.callbackQuery.message?.message_id;
        if (action === 'proxy') {
          await this.deployEngine.restartProxy().catch(() => {});
          await sleep(15_000); // give Caddy time to come up and re-attempt issuance
        } else if (action === 'app') {
          await this.deployEngine.restartService(slug).catch(() => {});
          await sleep(8_000);
        }
        if (msgId) await this.editDoctorReport(chatId, msgId, slug);
        return;
      }

      // Enter a project room from the /list or /projects picker.
      if (data.startsWith('room:project:')) {
        await ctx.answerCallbackQuery();
        const slug = data.slice('room:project:'.length);
        if (!this.store.projectExists(slug)) return void ctx.reply('That project no longer exists.');
        await this.switchRoom(ctx, { kind: 'project', slug });
        return;
      }

      // DevOps confirm / cancel (with a second confirm for host-level ops).
      if (data === 'devops:exec' || data === 'devops:cancel' || data === 'devops:exec2') {
        const entry = this.pendingDevOps.get(chatId);
        if (!entry || entry.messageId !== ctx.callbackQuery.message?.message_id) {
          await ctx.answerCallbackQuery({ text: 'This button is stale.' });
          return;
        }
        if (data === 'devops:cancel') {
          this.pendingDevOps.delete(chatId);
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          await this.bot.api.editMessageText(chatId, entry.messageId, 'Cancelled.').catch(() => {});
          return;
        }
        // The whole exec/exec2 gate lives in runDevOpsConfirm (unit-tested);
        // here we just wire grammy IO to it. `confirmed` is set only after the
        // warning renders, so a failed edit can't collapse the double-confirm.
        await runDevOpsConfirm(entry, data, {
          answer: (text) => ctx.answerCallbackQuery(text ? { text } : undefined).then(() => {}),
          renderWarning: (text) => {
            const kb = new InlineKeyboard().text('⚠️ Yes, do it', 'devops:exec2').text('✖️ Cancel', 'devops:cancel');
            return this.bot.api.editMessageText(chatId, entry.messageId, text, { reply_markup: kb })
              .then(() => true).catch(() => false);
          },
          showRunning: (text) => this.bot.api.editMessageText(chatId, entry.messageId, text).then(() => {}).catch(() => {}),
          execute: () => runMutatingOp(entry.op, this.devopsDeps()).catch((e) => `Error: ${(e as Error).message}`),
          showResult: (text) => this.editMdSafe(chatId, entry.messageId, text),
          clearPending: () => this.pendingDevOps.delete(chatId),
        });
        return;
      }

      await ctx.answerCallbackQuery();
      const pending = this.pendingAmbiguous.get(chatId);
      // A click on an outdated question must not apply the latest text.
      if (!pending || pending.messageId !== ctx.callbackQuery.message?.message_id) {
        return void ctx.reply('This button is stale — send your request again.');
      }
      this.pendingAmbiguous.delete(chatId);
      if (data === 'intent:new') {
        await this.runTask('create', undefined, pending.text, ctx);
      } else if (data.startsWith('intent:edit:')) {
        await this.runTask('edit', data.slice('intent:edit:'.length), pending.text, ctx);
      }
    });

    // Focus shortcuts (same logic as the persistent keyboard buttons).
    this.bot.command('home', (ctx) => this.switchRoom(ctx, { kind: 'home' }));
    this.bot.command('server', (ctx) => this.switchRoom(ctx, { kind: 'devops' }));
    this.bot.command('projects', (ctx) => this.showProjectPicker(ctx));

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
          await ctx.reply('Deletion cancelled.');
        }
        return;
      }

      // A focus shortcut (keyboard button / NL "go to X") wins — instant, free.
      const slugs = this.store.listProjects().map((p) => p.slug);
      const switchTo = detectRoomSwitch(text, slugs);
      if (switchTo === 'projects') return void this.showProjectPicker(ctx);
      if (switchTo?.kind === 'project') return void this.switchRoom(ctx, switchTo);
      if (switchTo?.kind === 'home') return void this.switchRoom(ctx, switchTo);
      if (switchTo?.kind === 'devops') return void this.switchRoom(ctx, switchTo);

      return this.handleMessage(ctx, text);
    });

    this.bot.catch((err) => logger.error('telegram handler error', { error: String(err.error) }));
  }

  // --- soft-context routing ---

  /** A keyboard button / NL switch. Sets the focused project (or clears it). */
  private async switchRoom(ctx: Context, room: Room): Promise<void> {
    const chatId = ctx.chat!.id;
    if (room.kind === 'project') {
      setFocus(this.store, chatId, room.slug);
      await ctx.reply(
        `📦 Focused on *${room.slug}*. Change it ("add a dark theme"), ask about it ("how is this built?"), or just say what's new.`,
        { parse_mode: 'Markdown', reply_markup: roomKeyboard() },
      );
      return;
    }
    clearFocus(this.store, chatId);
    const hint = room.kind === 'devops'
      ? 'Ask about the server in plain language: "show load", "clean up disk", "restart <project>", "update the server".'
      : 'Tell me what to build or change, ask about the server, or open a project — all in plain language.';
    await ctx.reply(hint, { reply_markup: roomKeyboard() });
  }

  private async showProjectPicker(ctx: Context): Promise<void> {
    const projects = this.store.listProjects();
    if (!projects.length) {
      await ctx.reply('No projects yet. Describe one and I will build it.', { reply_markup: roomKeyboard() });
      return;
    }
    const kb = new InlineKeyboard();
    for (const p of projects) kb.text(`📦 ${p.slug}`, `room:project:${p.slug}`).row();
    await ctx.reply('Pick a project to focus on:', { reply_markup: kb });
  }

  /**
   * Unified content-based routing (soft context). A message is classified by
   * what it SAYS, not which room you're "in":
   *  - deterministic fast-path (no LLM): clear create / focused edit;
   *  - LLM tail (one call) only for the ambiguous/operational/question remainder.
   * Confirmation policy for ops is re-derived from OP_META, never the model.
   */
  private async handleMessage(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat!.id;
    if (!text) {
      await ctx.reply('Tell me what to build or change — or ask about a project or the server.');
      return;
    }
    const slugs = this.store.listProjects().map((p) => p.slug);
    const focused = getFocus(this.store, chatId) ?? this.store.kvGet(`last_active:${chatId}`);

    // No-LLM fast-path. Only HIGH-confidence, SAFE shortcuts here — anything
    // brittle goes to the LLM router (which gates ops behind a confirm), because
    // the false-negative cost is an auto-deployed wrong action:
    //  - create: a brand-new project, harmless to fast-path;
    //  - edit: only a real edit (not operational, not a question, not
    //    create-phrased like "make me a shop"), targeting the focused/mentioned
    //    project. Operational/question/create-phrased messages fall through.
    if (!looksOperational(text) && !looksLikeQuestion(text)) {
      const intent = detectIntent(text, slugs, focused);
      if (intent.kind === 'create') return void this.runTask('create', undefined, intent.description, ctx);
      if (intent.kind === 'edit' && !looksLikeCreate(text)) {
        return void this.runTask('edit', intent.slug, intent.instruction, ctx);
      }
      // ambiguous or create-phrased → fall through to the LLM tail
    }

    if (!this.structuredLlm) return this.fallbackNoLlm(ctx, text, focused);

    const thinking = await ctx.reply('💭 …');
    const route = await routeMessage(this.structuredLlm, text, slugs, focused);
    await this.dispatchRoute(ctx, route, text, focused, thinking.message_id);
  }

  private async dispatchRoute(
    ctx: Context, route: Route, text: string, focused: string | null, thinkingId: number,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    switch (route.kind) {
      case 'create':
        await this.deleteMessage(chatId, thinkingId);
        return void this.runTask('create', undefined, route.description, ctx);
      case 'edit':
        await this.deleteMessage(chatId, thinkingId);
        return void this.runTask('edit', route.slug, route.instruction, ctx);
      case 'question': {
        await this.bot.api.editMessageText(chatId, thinkingId, '🤔 Looking into it…').catch(() => {});
        const res = await this.orchestrator.askProject(route.slug, route.question);
        return void this.editMdSafe(chatId, thinkingId, res.answer || 'No answer.');
      }
      case 'devops': {
        const op = route.op;
        const need = missingSlugPrompt(op);
        if (need) return void this.bot.api.editMessageText(chatId, thinkingId, need).catch(() => {});
        if (!op.mutating) {
          const result = await runReadOp(op, this.devopsDeps()).catch((e) => `Error: ${(e as Error).message}`);
          return void this.editMdSafe(chatId, thinkingId, result);
        }
        const kb = new InlineKeyboard().text('✅ Execute', 'devops:exec').text('✖️ Cancel', 'devops:cancel');
        await this.bot.api.editMessageText(chatId, thinkingId, `${op.humanSummary}?`, { reply_markup: kb }).catch(() => {});
        this.pendingDevOps.set(chatId, { messageId: thinkingId, op, confirmed: false });
        return;
      }
      case 'none': {
        // Couldn't classify: bias the clarification by what the text looked like.
        if (looksOperational(text)) {
          await this.bot.api.editMessageText(
            chatId, thinkingId,
            "I didn't catch a server action. Try: show load · containers · logs <project> · doctor <project> · " +
            'restart <project> · redeploy <project> · rollback <project> · restart proxy · clean disk · update botsman · update host.',
          ).catch(() => {});
          return;
        }
        const kb = new InlineKeyboard().text('🆕 New service', 'intent:new');
        if (focused && this.store.projectExists(focused)) kb.text(`✏️ Edit ${focused}`, `intent:edit:${focused}`);
        await this.bot.api.editMessageText(chatId, thinkingId, 'Is this a new service or a change to an existing one?', { reply_markup: kb }).catch(() => {});
        this.pendingAmbiguous.set(chatId, { messageId: thinkingId, text });
        return;
      }
    }
  }

  /** No LLM configured: deterministic best effort using detectIntent. */
  private async fallbackNoLlm(ctx: Context, text: string, focused: string | null): Promise<void> {
    const chatId = ctx.chat!.id;
    if (looksOperational(text)) {
      await ctx.reply('Server actions need an LLM, which is unavailable right now. Use /doctor <slug>, /logs <slug>, /rollback <slug> meanwhile.');
      return;
    }
    const intent = detectIntent(text, this.store.listProjects().map((p) => p.slug), focused);
    if (intent.kind === 'create') return void this.runTask('create', undefined, intent.description, ctx);
    if (intent.kind === 'edit') return void this.runTask('edit', intent.slug, intent.instruction, ctx);
    const kb = new InlineKeyboard().text('🆕 New service', 'intent:new');
    if (intent.lastSlug && this.store.projectExists(intent.lastSlug)) kb.text(`✏️ Edit ${intent.lastSlug}`, `intent:edit:${intent.lastSlug}`);
    const sent = await ctx.reply('Is this a new service or a change to an existing one?', { reply_markup: kb });
    this.pendingAmbiguous.set(chatId, { messageId: sent.message_id, text });
  }

  private async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  /** Run a long task with a live-updating status message + 30s heartbeat. */
  private async runTask(
    kind: 'create' | 'edit' | 'rollback',
    slug: string | undefined,
    instruction: string,
    ctx: Context,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    const queued = this.orchestrator.queueLength > 0 ? ' (queued behind the current task)' : '';
    // Carry the persistent room keyboard so the shortcut buttons appear from the
    // very first action, even for a user who never sent /start (post-onboarding).
    const statusMsg = await ctx.reply(`${STAGE_LABELS.accepted}${queued}`, { reply_markup: roomKeyboard() });

    let lastText = STAGE_LABELS.accepted;
    let dots = 0;
    // Once the outcome is being reported, stage/heartbeat edits must stop —
    // an in-flight "✅ Done" edit racing the rich final message would win.
    let finished = false;
    const update = async (text: string) => {
      if (finished) return;
      lastText = text;
      dots = 0;
      await this.bot.api.editMessageText(chatId, statusMsg.message_id, text).catch(() => {});
    };
    // Heartbeat: append dots so the user sees progress even in long stages (AC-F2 responsiveness).
    const heartbeat = setInterval(() => {
      if (finished) return;
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
          // 'done'/'failed' are not shown as stages: the rich outcome message
          // (link, summary, screenshot) supersedes them.
          if (stage === 'done' || stage === 'failed') return;
          void update(`${STAGE_LABELS[stage]}${detail && stage !== 'accepted' ? ` — ${detail}` : ''}`);
        },
        slug,
      );
      finished = true;
      clearInterval(heartbeat);
      await this.reportOutcome(ctx, chatId, statusMsg.message_id, outcome);
      if (outcome.slug) this.store.kvSet(`last_active:${chatId}`, outcome.slug);
    } catch (e) {
      clearInterval(heartbeat);
      finished = true;
      await this.bot.api.editMessageText(
        chatId, statusMsg.message_id, `${STAGE_LABELS.failed} — ${(e as Error).message}`,
      ).catch(() => {});
    }
  }

  private async reportOutcome(ctx: Context, chatId: number, statusMsgId: number, o: TaskOutcome): Promise<void> {
    if (!o.ok) {
      await this.bot.api.editMessageText(
        chatId, statusMsgId,
        `❌ Failed on "${o.slug}":\n\n${(o.error ?? 'unknown error').slice(0, 3000)}`,
      ).catch(() => {});
      return;
    }
    const lines = [`✅ *${o.slug}* — deployed`];
    if (o.url) lines.push(o.url);
    if (o.summary) lines.push('', o.summary.slice(0, 2000));
    if (o.warning) lines.push('', `⚠️ ${o.warning}`);
    if (o.costUsd && o.costUsd > 0) lines.push('', `💸 Tokens: ≈$${o.costUsd.toFixed(2)}`);
    lines.push('', 'What should I change?');
    // Public-URL warning comes with one-tap fixes (retry TLS / re-check).
    const fixKb = o.warning ? this.doctorKeyboard(o.slug, ['proxy', 'recheck']) : undefined;
    await this.bot.api.editMessageText(chatId, statusMsgId, lines.join('\n'), {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: fixKb,
    }).catch(async () => {
      // Markdown in agent summaries can be malformed — retry as plain text.
      await this.bot.api.editMessageText(chatId, statusMsgId, lines.join('\n'), {
        reply_markup: fixKb,
      }).catch(() => {});
    });
    if (o.screenshotPath && fs.existsSync(o.screenshotPath)) {
      await ctx.replyWithPhoto(new InputFile(o.screenshotPath)).catch((e) =>
        logger.warn('screenshot send failed', { error: String(e) }),
      );
    }
  }

  /** Run diagnostics and render the report with one-tap fix buttons. */
  private async editDoctorReport(chatId: number, messageId: number, slug: string): Promise<void> {
    const report = await runDoctor(slug, this.store, this.deployEngine).catch(() => null);
    if (!report) {
      await this.bot.api.editMessageText(chatId, messageId, `Could not diagnose ${slug}.`).catch(() => {});
      return;
    }
    const text = `🩺 ${slug}\n\n${report.lines.join('\n')}${report.healthy ? '\n\nAll good!' : ''}`;
    await this.bot.api.editMessageText(chatId, messageId, text, {
      reply_markup: this.doctorKeyboard(slug, report.fixes),
      link_preview_options: { is_disabled: true },
    }).catch(() => {});
  }

  private doctorKeyboard(slug: string, fixes: FixId[]): InlineKeyboard | undefined {
    if (!fixes.length) return undefined;
    const kb = new InlineKeyboard();
    if (fixes.includes('proxy')) kb.text('🔁 Reissue TLS (restart proxy)', `fix:proxy:${slug}`);
    if (fixes.includes('app')) kb.text('▶️ Restart service', `fix:app:${slug}`);
    if (fixes.includes('recheck')) kb.row().text('🔄 Re-check', `fix:recheck:${slug}`);
    return kb;
  }

  /** Edit a message as Markdown, falling back to plain text if it won't parse. */
  private async editMdSafe(chatId: number, messageId: number, text: string): Promise<void> {
    const body = text.slice(0, 4000);
    try {
      await this.bot.api.editMessageText(chatId, messageId, body, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await this.bot.api.editMessageText(chatId, messageId, body).catch(() => {});
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

  /** Notify the owner out-of-band (push-to-deploy results, the post-onboarding
   *  "ready" message). `withKeyboard` surfaces the persistent room shortcuts —
   *  used on the first full-mode message so the buttons appear without /start. */
  async notifyOwner(text: string, withKeyboard = false): Promise<void> {
    const opts = withKeyboard ? { reply_markup: roomKeyboard() } : {};
    for (const id of this.ownerIds) {
      await this.bot.api.sendMessage(id, text, opts).catch(() => {});
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'live': return '🟢';
    case 'failed': return '🔴';
    case 'stopped': return '⚪️';
    default: return '🟠';
  }
}
