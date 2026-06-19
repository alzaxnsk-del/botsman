import { Bot, InlineKeyboard, type Context } from 'grammy';
import { InputFile } from 'grammy';
import type Dockerode from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { paths } from '../paths.js';
import { detectIntent, looksLikeCreate, looksLikeDelete, findSimilarProject } from '../intent.js';
import { isValidSlug } from '../slug.js';
import { runDoctor, serverPublicIp, type FixId } from '../doctor.js';
import { updateConfigFile } from '../config.js';
import { MODEL_CHOICES, isModelId, modelLabel } from '../agent/models.js';
import {
  getFocus, setFocus, clearFocus, roomKeyboard, projectKeyboard, serverKeyboard, detectRoomSwitch,
  detectProjectAction, detectServerAction, inServerRoom, setServerRoom, clearServerRoom,
  type Room, type ServerAction,
} from './rooms.js';
import {
  routeMessage, runReadOp, runMutatingOp, looksOperational, looksLikeQuestion, missingSlugPrompt,
  runDevOpsConfirm, opLiteral,
  type DevOpsOp, type DevOpsOpId, type DevOpsDeps, type Route,
} from './devops.js';
import { homeStatusLines, homeKeyboard, degradedNoneMessage } from './home.js';
import { failureMessage, withElapsed } from './format.js';
import { localDevInstructions } from '../clone.js';
import type { StructuredLlm, LlmHealth } from '../llm.js';
import type { HostExec } from '../hostExec.js';
import { MEMORY_FILE, type Orchestrator, type TaskOutcome } from '../orchestrator.js';
import { versionLine } from '../version.js';
import type { Store } from '../db.js';
import type { Telemetry } from '../telemetry.js';
import type { DeployEngine } from '../deploy/engine.js';
import { RESTART_NOTICE_KEY, SETUP_BACKUP_KEY, PREFLIGHT_WARNINGS_KEY, type Stage } from '../types.js';

const STAGE_LABELS: Record<Stage, string> = {
  accepted: '📥 Got it, working…',
  generating: '🤖 Generating code (usually a few minutes)',
  committing: '💾 Committing changes',
  building: '🔨 Building the image',
  deploying: '🚀 Deploying',
  checking: '🔍 Checking the service responds',
  screenshot: '📸 Taking a screenshot',
  done: '✅ Done',
  failed: '❌ Failed',
};

const HEARTBEAT_MS = 25_000; // never silent longer than 30s (§4 EPIC B)

// Server-keyboard taps → the devops op they run. Read-only ops run instantly;
// the mutating ones reuse the confirm flow (Update is host-level → 2 confirms).
const SERVER_ACTION_OPS: Record<ServerAction, DevOpsOpId> = {
  load: 'host_metrics',
  containers: 'container_stats',
  'clean-disk': 'prune_docker',
  'restart-proxy': 'restart_proxy',
  update: 'self_update',
};

// The 🔍 Review one-tap: a read-only senior-engineer pass over the connected
// project. Runs via askProject ('ask' mode → read-only mount, never commits).
const REVIEW_PROMPT =
  'Act as a senior engineer reviewing THIS project (read-only — do NOT change any files). ' +
  'Briefly cover: what it does, the architecture, the most likely bugs or security issues, ' +
  'and 3–5 concrete, specific improvements. Keep it skimmable.';

/**
 * Telegram Gateway (§2): long polling, owner whitelist, commands + free text.
 */
export class TelegramGateway {
  private bot: Bot;
  /** project awaiting a tap-to-confirm /delete; messageId guards stale buttons. */
  private pendingDelete = new Map<number, { messageId: number; slug: string }>();
  /** free text awaiting "new or edit?" disambiguation, keyed by chat; messageId guards stale buttons. */
  private pendingAmbiguous = new Map<number, { messageId: number; text: string }>();
  /** DevOps op awaiting a confirm button; messageId guards stale clicks. */
  private pendingDevOps = new Map<number, { messageId: number; op: DevOpsOp; confirmed: boolean }>();
  /** A failed task offering a 🔁 Retry; messageId guards stale buttons. */
  private pendingRetry = new Map<number, { messageId: number; kind: 'create' | 'resume' | 'edit' | 'rollback'; slug?: string; instruction: string }>();
  /** Chats with a 🔍 Review agent run in flight — debounces repeated taps. */
  private reviewing = new Set<number>();

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
    private llmHealth?: LlmHealth,
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

  /** The persistent keyboard that matches the chat's CURRENT context, so the
   *  visible bar never lies about which room you're in. */
  private replyKeyboardFor(chatId: number): ReturnType<typeof roomKeyboard> {
    if (getFocus(this.store, chatId)) return projectKeyboard();
    if (inServerRoom(this.store, chatId)) return serverKeyboard();
    return roomKeyboard();
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
          'The buttons below change with where you are: 🏠 Home, inside a project, or the 🛠 Server room (each shows its own quick actions and 🚪 Exit).',
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
          '/version — the running version',
          '',
          versionLine(),
        ].join('\n'),
        { reply_markup: this.replyKeyboardFor(ctx.chat!.id) },
      ),
    );

    this.bot.command('list', async (ctx) => {
      const projects = this.store.listProjects();
      if (!projects.length) {
        await ctx.reply('No projects yet. Describe a service — and I will build it.', { reply_markup: this.replyKeyboardFor(ctx.chat!.id) });
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
      await this.sendLogs(ctx, slug);
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
      await this.promptDelete(ctx, slug);
    });

    // Re-configuration without a console: clearing a config piece and
    // restarting drops the daemon into in-chat onboarding for that piece.
    this.bot.command('setup', (ctx) => this.sendSetupMenu(ctx));

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
        // The agent reads the model per run, so the change applies to the NEXT
        // task with NO restart — a restart here used to kill an in-flight build.
        const busy = this.orchestrator.queueLength > 0
          ? ' The current task finishes on the previous model; this applies to your next request.'
          : '';
        await ctx.reply(`✓ Now using ${modelLabel(id)} — no restart needed.${busy}`);
        logger.info('model changed', { model: id });
        return;
      }

      if (data.startsWith('setup:')) {
        await ctx.answerCallbackQuery();
        const what = data.slice('setup:'.length);
        if (what === 'auth') {
          const cfg = updateConfigFile({});
          this.store.kvSet(SETUP_BACKUP_KEY, JSON.stringify({
            anthropicApiKey: cfg.anthropicApiKey, claudeCodeOauthToken: cfg.claudeCodeOauthToken,
          }));
          updateConfigFile({ anthropicApiKey: undefined, claudeCodeOauthToken: undefined });
          await ctx.reply('Restarting to change the coding-agent auth — I will ask here in ~10s.\nSend /cancel there to keep your current one.');
        } else if (what === 'domain') {
          const cfg = updateConfigFile({});
          this.store.kvSet(SETUP_BACKUP_KEY, JSON.stringify({ baseDomain: cfg.baseDomain }));
          updateConfigFile({ baseDomain: undefined });
          await ctx.reply('Restarting to change the domain — I will ask here in ~10s.\nSend /cancel there to keep your current one. (Existing projects keep their addresses.)');
        } else if (what === 'telemetry') {
          const cfg = updateConfigFile({});
          const enabled = !cfg.telemetry.enabled;
          updateConfigFile({ telemetry: { ...cfg.telemetry, enabled } });
          await ctx.reply(`Telemetry will be ${enabled ? 'ON' : 'OFF'} — restarting to apply (~10s)…`);
          this.store.kvSet(RESTART_NOTICE_KEY, `✓ Back online — telemetry ${enabled ? 'ON' : 'OFF'}.`);
        } else {
          return;
        }
        logger.info('setup change requested, restarting', { what });
        this.restartWhenIdle();
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
          if (msgId) await this.bot.api.editMessageText(chatId, msgId, '🔁 Restarting the proxy and re-issuing TLS… (~15s)').catch(() => {});
          await this.deployEngine.restartProxy().catch(() => {});
          await sleep(15_000); // give Caddy time to come up and re-attempt issuance
        } else if (action === 'app') {
          if (msgId) await this.bot.api.editMessageText(chatId, msgId, '▶️ Restarting the service… (~8s)').catch(() => {});
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

      // Resume / discard a create that a restart interrupted (offered at startup).
      if (data.startsWith('resume:')) {
        await ctx.answerCallbackQuery();
        const slug = data.slice('resume:'.length);
        const msgId = ctx.callbackQuery.message?.message_id;
        if (!this.store.projectExists(slug)) {
          if (msgId) await this.bot.api.editMessageText(chatId, msgId, 'That request is no longer available.').catch(() => {});
          return;
        }
        if (msgId) await this.deleteMessage(chatId, msgId);
        return void this.runTask('resume', slug, '', ctx);
      }
      if (data.startsWith('discard:')) {
        await ctx.answerCallbackQuery({ text: 'Discarded' });
        const slug = data.slice('discard:'.length);
        const msgId = ctx.callbackQuery.message?.message_id;
        if (this.store.projectExists(slug)) {
          await this.orchestrator.enqueue('delete', '', () => {}, slug);
        }
        if (msgId) await this.bot.api.editMessageText(chatId, msgId, '🗑 Discarded the interrupted request.').catch(() => {});
        return;
      }

      // Home panel buttons — all command-driven, zero LLM calls.
      if (data.startsWith('home:')) {
        const what = data.slice('home:'.length);
        if (what === 'metrics') {
          await ctx.answerCallbackQuery({ text: 'Reading…' });
          const result = await runReadOp(opLiteral('host_metrics'), this.devopsDeps())
            .catch((e) => `Error: ${(e as Error).message}`);
          await this.replyMdSafe(ctx, result); // new message — the panel stays put
          return;
        }
        if (what === 'projects') {
          await ctx.answerCallbackQuery();
          await this.showProjectPicker(ctx);
          return;
        }
        if (what === 'setup') {
          await ctx.answerCallbackQuery();
          await this.sendSetupMenu(ctx);
          return;
        }
        if (what === 'update') {
          // Host-level op: a fresh confirm message that drops straight into the
          // existing devops:exec/exec2 double-confirm (hostLevel auto-engages it).
          await ctx.answerCallbackQuery();
          const op = opLiteral('self_update');
          const kb = new InlineKeyboard().text('✅ Execute', 'devops:exec').text('✖️ Cancel', 'devops:cancel');
          const sent = await ctx.reply(`${op.humanSummary}?`, { reply_markup: kb });
          this.pendingDevOps.set(chatId, { messageId: sent.message_id, op, confirmed: false });
          return;
        }
        if (what === 'clone') {
          await ctx.answerCallbackQuery();
          const projects = this.store.listProjects();
          if (!projects.length) {
            await ctx.reply(
              '💻 Once you have a project, you can clone it and develop it locally with Claude Code — a git push then auto-deploys. Describe a project here to create your first one.',
            );
            return;
          }
          const kb = new InlineKeyboard();
          for (const p of projects) kb.text(`💻 ${p.slug}`, `clone:${p.slug}`).row();
          await ctx.reply(
            'Develop any project on your computer with Claude Code — pick one for its exact clone command:',
            { reply_markup: kb },
          );
          return;
        }
        await ctx.answerCallbackQuery();
        return;
      }

      // "💻 <slug>" from the Home clone picker → that project's local-dev guide.
      if (data.startsWith('clone:')) {
        await ctx.answerCallbackQuery();
        const slug = data.slice('clone:'.length);
        if (!this.store.projectExists(slug)) return void ctx.reply('That project no longer exists.');
        await this.sendLocalDevInfo(ctx, slug);
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
        let stopHb: (() => void) | null = null;
        await runDevOpsConfirm(entry, data, {
          answer: (text) => ctx.answerCallbackQuery(text ? { text } : undefined).then(() => {}),
          renderWarning: (text) => {
            const kb = new InlineKeyboard().text('⚠️ Yes, do it', 'devops:exec2').text('✖️ Cancel', 'devops:cancel');
            return this.bot.api.editMessageText(chatId, entry.messageId, text, { reply_markup: kb })
              .then(() => true).catch(() => false);
          },
          // After showing "⏳ running", keep a heartbeat going: a host op (build,
          // apt) can take minutes, and silence reads as "frozen".
          showRunning: (text) => this.bot.api.editMessageText(chatId, entry.messageId, text)
            .then(() => { stopHb = this.startHeartbeat(chatId, entry.messageId, text); })
            .catch(() => {}),
          execute: () => runMutatingOp(entry.op, this.devopsDeps()).catch((e) => `Error: ${(e as Error).message}`),
          showResult: (text) => { stopHb?.(); return this.editMdSafe(chatId, entry.messageId, text); },
          clearPending: () => this.pendingDevOps.delete(chatId),
        });
        return;
      }

      // Delete confirm / cancel (tap, not type — a stray "yes"/"да" can't delete,
      // and a natural "yes, delete it" is no longer silently lost).
      if (data === 'delete:exec' || data === 'delete:cancel') {
        const entry = this.pendingDelete.get(chatId);
        if (!entry || entry.messageId !== ctx.callbackQuery.message?.message_id) {
          return void ctx.answerCallbackQuery({ text: 'This button is stale.' });
        }
        this.pendingDelete.delete(chatId);
        if (data === 'delete:cancel') {
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          await this.bot.api.editMessageText(chatId, entry.messageId, 'Deletion cancelled.').catch(() => {});
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Deleting…' });
        const wasConnected = getFocus(this.store, chatId) === entry.slug;
        await this.bot.api.editMessageText(chatId, entry.messageId, `🗑 Deleting ${entry.slug}…`).catch(() => {});
        const outcome = await this.orchestrator.enqueue('delete', '', () => {}, entry.slug);
        await this.bot.api.editMessageText(
          chatId, entry.messageId, outcome.ok ? `🗑 ${outcome.summary}` : `❌ ${outcome.error}`,
        ).catch(() => {});
        // If we just deleted the connected project, restore the global bar so the
        // keyboard matches reality (an editMessageText can't carry a reply keyboard).
        if (outcome.ok && wasConnected) {
          await ctx.reply('🚪 Back to Home — that project is gone.', { reply_markup: roomKeyboard() }).catch(() => {});
        }
        return;
      }

      // 🔁 Retry a failed task (re-runs the original request). messageId-guarded
      // like the other pending buttons so an old failure card can't re-fire.
      if (data === 'retry') {
        const entry = this.pendingRetry.get(chatId);
        if (!entry || entry.messageId !== ctx.callbackQuery.message?.message_id) {
          return void ctx.answerCallbackQuery({ text: 'This button is stale.' });
        }
        this.pendingRetry.delete(chatId);
        await ctx.answerCallbackQuery({ text: 'Retrying…' });
        return void this.runTask(entry.kind, entry.slug, entry.instruction, ctx);
      }

      // 🩺 Doctor on a failed/again-broken project (from the failure card).
      if (data.startsWith('doctor:')) {
        await ctx.answerCallbackQuery();
        const slug = data.slice('doctor:'.length);
        if (!this.store.projectExists(slug)) return void ctx.reply('That project no longer exists.');
        const msg = await ctx.reply(`🩺 Checking ${slug}…`);
        await this.editDoctorReport(chatId, msg.message_id, slug);
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
    this.bot.command('version', (ctx) => ctx.reply(versionLine()));

    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();

      // A focus shortcut (keyboard button / NL "go to X") wins — instant, free.
      const slugs = this.store.listProjects().map((p) => p.slug);
      const switchTo = detectRoomSwitch(text, slugs);
      if (switchTo === 'projects') return void this.showProjectPicker(ctx);
      if (switchTo?.kind === 'project') return void this.switchRoom(ctx, switchTo);
      if (switchTo?.kind === 'home') return void this.switchRoom(ctx, switchTo);
      if (switchTo?.kind === 'devops') return void this.switchRoom(ctx, switchTo);

      // Project-context keyboard (🚪 Exit · 🔍 Review · 📋 Logs · ↩️ Rollback) —
      // handled deterministically, no LLM, so it works even when the router is
      // down. A multi-word edit that merely mentions "review"/"logs" won't match
      // (anchored labels). Exit is handled even when focus is already gone (e.g.
      // the connected project was just deleted) so a stale 🚪 Exit still returns
      // Home and restores the global keyboard instead of becoming a bogus create.
      const action = detectProjectAction(text);
      if (action === 'exit') return void this.switchRoom(ctx, { kind: 'home' });
      const connected = getFocus(this.store, chatId);
      if (connected) {
        if (action === 'review') return void this.reviewProject(ctx, connected);
        if (action === 'logs') return void this.sendLogs(ctx, connected);
        if (action === 'code') return void this.sendLocalDevInfo(ctx, connected);
        if (action === 'rollback') {
          // Mutating → reuse the devops confirm flow (single confirm; not
          // host-level) so a stray keyboard tap can't roll back without asking.
          const op = opLiteral('rollback_service', connected);
          const kb = new InlineKeyboard().text('✅ Execute', 'devops:exec').text('✖️ Cancel', 'devops:cancel');
          const sent = await ctx.reply(`${op.humanSummary}?`, { reply_markup: kb });
          this.pendingDevOps.set(chatId, { messageId: sent.message_id, op, confirmed: false });
          return;
        }
      }

      // Server/admin room: deterministic one-taps for the server keyboard
      // (read-only run instantly; mutating ask first). Work even if the LLM is down.
      if (inServerRoom(this.store, chatId)) {
        const sa = detectServerAction(text);
        if (sa) return void this.runServerAction(ctx, sa);
      }

      return this.handleMessage(ctx, text);
    });

    // Any NON-text message (photo / voice / document / sticker / video / …):
    // acknowledge it so "just talk" never meets silence. message:text above
    // handles text and stops propagation, so this only fires for non-text.
    this.bot.on('message', async (ctx) => {
      await ctx.reply(
        "I can only read text right now — describe what you need in words. " +
        "(Photos, voice notes and files aren't supported yet.)",
      );
    });

    this.bot.catch((err) => logger.error('telegram handler error', { error: String(err.error) }));
  }

  // --- soft-context routing ---

  /** Connect to a project (explicit, sticky context) or disconnect (🏠). */
  private async switchRoom(ctx: Context, room: Room): Promise<void> {
    const chatId = ctx.chat!.id;
    if (room.kind === 'project') {
      clearServerRoom(this.store, chatId);
      setFocus(this.store, chatId, room.slug);
      await ctx.reply(
        `🔗 *Connected to ${room.slug}.*\nEverything now goes here — changes ("add a dark theme") and questions ("how is this built?"), no extra prompts.\nQuick actions are on the keyboard below: 🔍 Review · 📋 Logs · ↩️ Rollback (asks first). Tap 🚪 Exit to disconnect.`,
        { parse_mode: 'Markdown', reply_markup: projectKeyboard() },
      );
      return;
    }
    const wasProject = getFocus(this.store, chatId);
    const wasServer = inServerRoom(this.store, chatId);
    clearFocus(this.store, chatId);
    if (room.kind === 'devops') {
      // Sticky admin context: bare messages now lean toward server ops, and the
      // keyboard shows admin actions, until 🚪 Exit. Dangerous ops ask first.
      setServerRoom(this.store, chatId);
      await ctx.reply(
        '🛠 *Server — admin mode.*\nJust say what you need: "show load", "restart todo", "clean disk", "update". Or tap a button below. I ask before anything risky.\nTap 🚪 Exit to leave.',
        { parse_mode: 'Markdown', reply_markup: serverKeyboard() },
      );
      return;
    }
    // Home is a command-driven control panel (no AI), so it keeps working even
    // when the LLM router is down. ALWAYS restore the global bar here: showHome's
    // panel uses an inline keyboard, so only a message carrying roomKeyboard()
    // can reset the persistent bar — including a STALE project/server bar left
    // behind when the focused project vanished out-of-band (getFocus self-heals
    // to null, so wasProject is falsy yet the old bar is still on screen).
    clearServerRoom(this.store, chatId);
    const note = wasProject
      ? `🚪 Left ${wasProject} — back to Home.`
      : wasServer
        ? '🚪 Left the server — back to Home.'
        : '🏠 Home — main menu.';
    await ctx.reply(note, { reply_markup: roomKeyboard() });
    return void this.showHome(ctx);
  }

  /**
   * The Home control panel: a status section + command buttons, rendered with no
   * LLM calls. Status counts come from the DB + a cheap container probe; the AI
   * line reads the in-memory health snapshot; preflight warnings come from kv.
   */
  private async showHome(ctx: Context): Promise<void> {
    const projects = this.store.listProjects();
    let live = 0;
    let down = 0;
    for (const p of projects) {
      if (p.status !== 'live') continue;
      live++;
      const running = await this.deployEngine.containerRunning(p.slug).catch(() => false);
      if (!running) down++;
    }
    let preflightWarnings = 0;
    try {
      const raw = this.store.kvGet(PREFLIGHT_WARNINGS_KEY);
      if (raw) preflightWarnings = (JSON.parse(raw) as string[]).length;
    } catch { /* ignore malformed kv */ }

    const lines = homeStatusLines({
      projects: { live, down, total: projects.length },
      llm: this.llmHealth?.snapshot() ?? null,
      llmConfigured: !!this.structuredLlm,
      preflightWarnings,
    });
    await ctx.reply(lines.join('\n'), { reply_markup: homeKeyboard() });
  }

  /** The /setup menu (also reached from the Home panel's 🔧 Setup button). */
  private async sendSetupMenu(ctx: Context): Promise<void> {
    const kb = new InlineKeyboard()
      .text('🔑 Coding agent auth', 'setup:auth')
      .text('🌐 Domain', 'setup:domain')
      .row()
      .text('🧠 Model', 'setup:model')
      .text('📊 Toggle telemetry', 'setup:telemetry');
    await ctx.reply(`What do you want to change? Current model: ${modelLabel(this.currentModel())}.`, {
      reply_markup: kb,
    });
  }

  private async showProjectPicker(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    // Opening the picker navigates out of the server room — clear the sticky
    // flag so admin bias can't leak, and (since the picker message can only
    // carry its inline keyboard) restore the global bar in a short note.
    const leavingServer = inServerRoom(this.store, chatId);
    clearServerRoom(this.store, chatId);
    const projects = this.store.listProjects();
    if (!projects.length) {
      await ctx.reply('No projects yet. Describe one and I will build it.', { reply_markup: this.replyKeyboardFor(chatId) });
      return;
    }
    if (leavingServer) {
      await ctx.reply('📦 Projects', { reply_markup: roomKeyboard() });
    }
    const kb = new InlineKeyboard();
    for (const p of projects) kb.text(`🔗 ${p.slug}`, `room:project:${p.slug}`).row();
    await ctx.reply('Connect to a project — then changes and questions go straight to it:', { reply_markup: kb });
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
    const inServer = inServerRoom(this.store, chatId);
    // In the server room there is no "connected" project — don't let a stale
    // last_active masquerade as one (it would auto-target a bare op or, worse,
    // auto-apply a high-confidence edit with no confirm). Outside it, last_active
    // still biases bare follow-ups as before.
    const focused = getFocus(this.store, chatId) ?? (inServer ? null : this.store.kvGet(`last_active:${chatId}`));

    // No-LLM authoring fast-path. Only HIGH-confidence, SAFE shortcuts here —
    // anything brittle goes to the LLM router (which gates ops behind a confirm).
    // Skipped in the server room: there a bare message means a server op, not
    // "build/change an app", so we let the router (with the admin hint) decide.
    if (!inServer && !looksOperational(text) && !looksLikeQuestion(text)) {
      const intent = detectIntent(text, slugs, focused);
      if (intent.kind === 'create') return void this.createOrAsk(ctx, intent.description, slugs, null);
      if (intent.kind === 'edit' && !looksLikeCreate(text) && !looksLikeDelete(text)) {
        return void this.runTask('edit', intent.slug, intent.instruction, ctx);
      }
      // ambiguous, create- or delete-phrased → fall through to the LLM tail
    }

    if (!this.structuredLlm) return this.fallbackNoLlm(ctx, text, focused, inServer);

    const thinking = await ctx.reply('💭 …');
    const route = await routeMessage(this.structuredLlm, text, slugs, focused, inServer);
    await this.dispatchRoute(ctx, route, text, focused, thinking.message_id);
  }

  /**
   * Create a new project. The very first project is built straight away (nothing
   * to confuse it with). Once projects EXIST, always confirm — a create-phrased
   * message may really be about an existing project, and a silent build means an
   * accidental duplicate. The closest-looking existing project is offered first
   * (fuzzy/transliterated name match), then the rest, so "improve X" is one tap.
   * `thinkingId` is an existing "💭…" message to edit, or null to send fresh.
   */
  private async createOrAsk(ctx: Context, description: string, slugs: string[], thinkingId: number | null): Promise<void> {
    const chatId = ctx.chat!.id;
    if (slugs.length === 0) {
      if (thinkingId) await this.deleteMessage(chatId, thinkingId);
      return void this.runTask('create', undefined, description, ctx);
    }
    const similar = findSimilarProject(description, slugs);
    const ordered = similar ? [similar, ...slugs.filter((s) => s !== similar)] : slugs;
    const shown = ordered.slice(0, 6); // keep the keyboard sane for many projects
    const kb = new InlineKeyboard().text('🆕 New project', 'intent:new').row();
    for (const s of shown) kb.text(`✏️ ${s}`, `intent:edit:${s}`).row();
    // Plain text (no Markdown): the description is arbitrary user text.
    const desc = description.length > 80 ? description.slice(0, 79) + '…' : description;
    const more = ordered.length > shown.length ? "\n(or type a project's name to change it)" : '';
    const body =
      `You have ${slugs.length} project${slugs.length === 1 ? '' : 's'}. ` +
      `Make a NEW one for "${desc}", or improve an existing project?` +
      (similar ? `\nThis looks related to ${similar}.` : '') + more;
    if (thinkingId) {
      await this.bot.api.editMessageText(chatId, thinkingId, body, { reply_markup: kb }).catch(() => {});
      this.pendingAmbiguous.set(chatId, { messageId: thinkingId, text: description });
    } else {
      const sent = await ctx.reply(body, { reply_markup: kb });
      this.pendingAmbiguous.set(chatId, { messageId: sent.message_id, text: description });
    }
  }

  private async dispatchRoute(
    ctx: Context, route: Route, text: string, focused: string | null, thinkingId: number,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    switch (route.kind) {
      case 'create':
        return void this.createOrAsk(ctx, route.description, this.store.listProjects().map((p) => p.slug), thinkingId);
      case 'edit':
        // Low confidence + not connected → confirm rather than edit a live
        // project by guess (2026 consensus: don't guess, ask the user).
        if (route.confidence === 'low') {
          const kb = new InlineKeyboard()
            .text(`✅ Change ${route.slug}`, `intent:edit:${route.slug}`)
            .text('🆕 New project', 'intent:new');
          await this.bot.api.editMessageText(
            chatId, thinkingId,
            `I think you want to change 📦 *${route.slug}*. Right? (or is this a new project?)`,
            { parse_mode: 'Markdown', reply_markup: kb },
          ).catch(() => {});
          this.pendingAmbiguous.set(chatId, { messageId: thinkingId, text: route.instruction });
          return;
        }
        await this.deleteMessage(chatId, thinkingId);
        return void this.runTask('edit', route.slug, route.instruction, ctx);
      case 'question': {
        await this.bot.api.editMessageText(chatId, thinkingId, '🤔 Looking into it…').catch(() => {});
        const res = await this.orchestrator.askProject(route.slug, route.question);
        return void this.editMdSafe(chatId, thinkingId, res.answer || 'No answer.');
      }
      case 'delete': {
        // Natural-language delete → the same tap-to-confirm buttons as /delete,
        // editing the "💭…" bubble into the confirm card.
        const { text: body, kb } = this.deleteConfirm(route.slug);
        await this.bot.api.editMessageText(chatId, thinkingId, body, {
          parse_mode: 'Markdown', reply_markup: kb,
        }).catch(() => {});
        this.pendingDelete.set(chatId, { messageId: thinkingId, slug: route.slug });
        return;
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
        // The router gave nothing back. Distinguish a real outage (the LLM call
        // just failed synchronously inside the awaited routeMessage, so the
        // health snapshot is fresh) from a genuine "couldn't classify" — on an
        // outage, say so and point at Home rather than the misleading
        // "new or change?" prompt. Don't stash pendingAmbiguous on an outage.
        const degraded = degradedNoneMessage(this.llmHealth?.snapshot() ?? null);
        if (degraded) {
          await this.bot.api.editMessageText(chatId, thinkingId, degraded).catch(() => {});
          return;
        }
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
  private async fallbackNoLlm(ctx: Context, text: string, focused: string | null, inServer = false): Promise<void> {
    const chatId = ctx.chat!.id;
    if (inServer) {
      await ctx.reply(
        'The AI is unavailable right now, but the server buttons below still work: ' +
        '📊 Load · 🐳 Containers · 🧹 Clean disk · 🔁 Restart proxy · ⬆️ Update.',
      );
      return;
    }
    if (looksOperational(text)) {
      await ctx.reply('Server actions need an LLM, which is unavailable right now. Use /doctor <slug>, /logs <slug>, /rollback <slug> meanwhile.');
      return;
    }
    const slugs = this.store.listProjects().map((p) => p.slug);
    const intent = detectIntent(text, slugs, focused);
    // createOrAsk still confirms-or-creates correctly without the LLM (it's
    // button-driven), so a new-project request gets the same guard here.
    if (intent.kind === 'create') return void this.createOrAsk(ctx, intent.description, slugs, null);
    if (intent.kind === 'edit') return void this.runTask('edit', intent.slug, intent.instruction, ctx);
    const kb = new InlineKeyboard().text('🆕 New service', 'intent:new');
    if (intent.lastSlug && this.store.projectExists(intent.lastSlug)) kb.text(`✏️ Edit ${intent.lastSlug}`, `intent:edit:${intent.lastSlug}`);
    const sent = await ctx.reply('Is this a new service or a change to an existing one?', { reply_markup: kb });
    this.pendingAmbiguous.set(chatId, { messageId: sent.message_id, text });
  }

  private async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  /** The irreversible-delete confirm card: warning text + tap buttons. Tap, not
   *  type — so a stray "yes"/"да" can't delete and a natural "yes, delete it"
   *  isn't silently lost. Shared by /delete and the natural-language delete. */
  private deleteConfirm(slug: string): { text: string; kb: InlineKeyboard } {
    return {
      text: `⚠️ Delete project *${slug}* together with its database and code? This cannot be undone.`,
      kb: new InlineKeyboard().text('🗑 Delete', 'delete:exec').text('✖️ Cancel', 'delete:cancel'),
    };
  }

  /** Send a fresh delete-confirm card and remember it (messageId-guarded). */
  private async promptDelete(ctx: Context, slug: string): Promise<void> {
    const { text, kb } = this.deleteConfirm(slug);
    const sent = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    this.pendingDelete.set(ctx.chat!.id, { messageId: sent.message_id, slug });
  }

  /** A standalone heartbeat for a single edited status message — used by long
   *  host/devops ops (self-update build, apt upgrade, redeploy) so they don't
   *  sit silent for minutes. Returns a stop fn; elapsed shows once past a minute. */
  private startHeartbeat(chatId: number, messageId: number, base: string): () => void {
    let stopped = false;
    let dots = 0;
    const startedAt = Date.now();
    const iv = setInterval(() => {
      if (stopped) return;
      dots = (dots % 3) + 1;
      void this.bot.api
        .editMessageText(chatId, messageId, `${withElapsed(base, startedAt, Date.now())}${'.'.repeat(dots)}`)
        .catch(() => {});
    }, HEARTBEAT_MS);
    return () => { stopped = true; clearInterval(iv); };
  }

  /** 🔍 Review one-tap: a read-only senior-engineer pass over the project.
   *  Debounced per chat — askProject runs outside the task queue, so repeated
   *  taps would otherwise pile up concurrent agent containers on the VPS. */
  private async reviewProject(ctx: Context, slug: string): Promise<void> {
    const chatId = ctx.chat!.id;
    if (this.reviewing.has(chatId)) {
      await ctx.reply('🔍 A review is already running — one moment.');
      return;
    }
    this.reviewing.add(chatId);
    const thinking = await ctx.reply(`🔍 Reviewing ${slug}… (read-only, no changes)`);
    try {
      const res = await this.orchestrator.askProject(slug, REVIEW_PROMPT);
      const body = res.ok ? (res.answer || 'No findings.') : `❌ ${res.answer}`;
      await this.editMdSafe(chatId, thinking.message_id, body);
    } finally {
      this.reviewing.delete(chatId);
    }
  }

  /** 📋 Logs one-tap (and the /logs command): last container log lines. */
  private async sendLogs(ctx: Context, slug: string): Promise<void> {
    const logs = await this.deployEngine.containerLogs(slug, 50).catch((e) => `Error: ${(e as Error).message}`);
    await this.replyMdSafe(ctx, `Logs for ${slug} (last lines):\n\`\`\`\n${logs.slice(-3500) || '(empty)'}\n\`\`\``);
  }

  /** 💻 Claude Code: how to clone this project and develop it locally. Fills in
   *  the server IP + SSH user/path so the command is (almost) copy-paste. */
  private async sendLocalDevInfo(ctx: Context, slug: string): Promise<void> {
    const p = this.store.getProject(slug);
    if (!p) return void ctx.reply(`Project ${slug} not found.`);
    // Fall back to the standard install path (NOT paths.home(), which is the
    // container's /data) so the command points at the host, not inside Docker.
    const hostHome = process.env.BOTSMAN_HOST_DIR ?? '~/.botsman';
    const host = (await serverPublicIp()) ?? '<server>';
    await this.replyMdSafe(ctx, localDevInstructions({ slug, hostHome, host, domain: p.domain }));
  }

  /** A server-keyboard tap → its devops op. Read-only runs instantly; mutating
   *  drops into the existing confirm flow (host-level Update → double confirm). */
  private async runServerAction(ctx: Context, action: ServerAction): Promise<void> {
    const chatId = ctx.chat!.id;
    const op = opLiteral(SERVER_ACTION_OPS[action]);
    if (!op.mutating) {
      const thinking = await ctx.reply(`⏳ ${op.humanSummary}…`);
      const result = await runReadOp(op, this.devopsDeps()).catch((e) => `Error: ${(e as Error).message}`);
      await this.editMdSafe(chatId, thinking.message_id, result);
      return;
    }
    const kb = new InlineKeyboard().text('✅ Execute', 'devops:exec').text('✖️ Cancel', 'devops:cancel');
    const sent = await ctx.reply(`${op.humanSummary}?`, { reply_markup: kb });
    this.pendingDevOps.set(chatId, { messageId: sent.message_id, op, confirmed: false });
  }

  /**
   * Restart the daemon — but never on top of a running task. A model/setup
   * change that hard-exits mid-build is exactly what dropped an in-flight
   * create before; here we let the "restarting…" reply flush, then wait
   * (bounded) for the orchestrator queue to drain before exiting.
   */
  private restartWhenIdle(): void {
    void (async () => {
      await sleep(1500); // flush the "restarting…" reply (matches the old delay)
      if (this.orchestrator.queueLength > 0) {
        await this.notifyOwner('⏳ Waiting for the running task to finish before restarting…').catch(() => {});
        const deadline = Date.now() + 15 * 60_000; // never wait forever
        while (this.orchestrator.queueLength > 0 && Date.now() < deadline) {
          await sleep(2_000);
        }
      }
      process.exit(0);
    })();
  }

  /**
   * After a restart, offer to resume any create that was interrupted mid-build.
   * Resuming rebuilds from the project's ORIGINAL request, so the intent isn't
   * lost (and isn't replaced by whatever the user typed next).
   */
  async offerResume(creates: Array<{ slug: string; instruction: string }>): Promise<void> {
    for (const c of creates) {
      const kb = new InlineKeyboard()
        .text('▶️ Resume', `resume:${c.slug}`)
        .text('🗑 Discard', `discard:${c.slug}`);
      const text =
        '⏸️ This request was interrupted by a restart and never finished:\n\n' +
        `"${c.instruction.slice(0, 500)}"\n\n` +
        "Resume it (I'll rebuild from your original request), or discard?";
      for (const id of this.ownerIds) {
        await this.bot.api.sendMessage(id, text, { reply_markup: kb }).catch(() => {});
      }
    }
  }

  /** Run a long task with a live-updating status message + 30s heartbeat. */
  private async runTask(
    kind: 'create' | 'resume' | 'edit' | 'rollback',
    slug: string | undefined,
    instruction: string,
    ctx: Context,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    const queued = this.orchestrator.queueLength > 0 ? ' (queued behind the current task)' : '';
    // IMPORTANT: no reply_markup here. This message is edited live through the
    // task stages, and Telegram cannot editMessageText a message that carries a
    // ReplyKeyboardMarkup — attaching the room keyboard here froze the status at
    // "Got it, working…". The keyboard is surfaced by /start, /list, the ready
    // message and room switches instead.
    const statusMsg = await ctx.reply(`${STAGE_LABELS.accepted}${queued}`);

    let lastText = STAGE_LABELS.accepted;
    let dots = 0;
    let stageStartedAt = Date.now();
    // Once the outcome is being reported, stage/heartbeat edits must stop —
    // an in-flight "✅ Done" edit racing the rich final message would win.
    let finished = false;
    const update = async (text: string) => {
      if (finished) return;
      lastText = text;
      dots = 0;
      stageStartedAt = Date.now(); // elapsed is per-stage, so it can't drift/lie
      await this.bot.api.editMessageText(chatId, statusMsg.message_id, text).catch(() => {});
    };
    // Heartbeat: show elapsed time on the active stage + a cycling dot, so the
    // multi-minute stages (generating, building) read as progress, not a freeze.
    const tick = (): void => {
      if (finished) return;
      dots = (dots % 3) + 1;
      const text = `${withElapsed(lastText, stageStartedAt, Date.now())}${'.'.repeat(dots)}`;
      void this.bot.api.editMessageText(chatId, statusMsg.message_id, text).catch(() => {});
    };
    // A one-shot early nudge so the first sign of life isn't a full 25s away.
    const earlyNudge = setTimeout(tick, 9_000);
    const heartbeat = setInterval(tick, HEARTBEAT_MS);
    const stopTicks = (): void => { clearTimeout(earlyNudge); clearInterval(heartbeat); };

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
      stopTicks();
      await this.reportOutcome(ctx, chatId, statusMsg.message_id, outcome, { kind, slug, instruction });
      if (outcome.slug) this.store.kvSet(`last_active:${chatId}`, outcome.slug);
      // A fresh build → connect to it, so the next message goes straight to the
      // new project and the persistent bar becomes its actions (the outcome
      // message is an editMessageText and can't carry a reply keyboard, so this
      // connect note is what swaps the bar).
      if (outcome.ok && outcome.slug && (kind === 'create' || kind === 'resume')) {
        // Connecting and being in the Server room are mutually exclusive
        // (switchRoom coordinates both) — clear the server flag too, or the bar
        // would show the project while routing stayed biased to admin ops.
        clearServerRoom(this.store, chatId);
        setFocus(this.store, chatId, outcome.slug);
        await ctx.reply(
          `🔗 Connected to ${outcome.slug} — changes ("add a dark theme") and questions go straight to it now. Tap 🚪 Exit to disconnect.`,
          { reply_markup: projectKeyboard() },
        ).catch(() => {});
      }
    } catch (e) {
      stopTicks();
      finished = true;
      await this.reportOutcome(
        ctx, chatId, statusMsg.message_id,
        { ok: false, slug: slug ?? '', error: (e as Error).message },
        { kind, slug, instruction },
      );
    }
  }

  private async reportOutcome(
    ctx: Context, chatId: number, statusMsgId: number, o: TaskOutcome,
    retry?: { kind: 'create' | 'resume' | 'edit' | 'rollback'; slug?: string; instruction: string },
  ): Promise<void> {
    if (!o.ok) {
      // Not a dead end: offer 🔁 Retry (re-runs the request) and 🩺 Doctor when
      // the project actually exists, with a plain-language lead over trimmed logs.
      const kb = new InlineKeyboard();
      if (retry) {
        kb.text('🔁 Retry', 'retry');
        this.pendingRetry.set(chatId, { messageId: statusMsgId, ...retry });
      }
      if (o.slug && this.store.projectExists(o.slug)) kb.text('🩺 Doctor', `doctor:${o.slug}`);
      await this.bot.api.editMessageText(chatId, statusMsgId, failureMessage(o), {
        reply_markup: kb.inline_keyboard.flat().length ? kb : undefined,
      }).catch(() => {});
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
    for (const id of this.ownerIds) {
      // Pick per recipient: a focus set before a restart persists in kv, so the
      // "back online" notice must not clobber a connected user's project keyboard.
      const opts = withKeyboard ? { reply_markup: this.replyKeyboardFor(id) } : {};
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
