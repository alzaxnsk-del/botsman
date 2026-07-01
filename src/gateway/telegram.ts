import { Bot, InlineKeyboard, type Context } from 'grammy';
import { InputFile } from 'grammy';
import type Dockerode from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { paths } from '../paths.js';
import { detectIntent, looksLikeCreate, looksLikeDelete, looksLikeDomainChange, parseDomainTarget, findSimilarProject } from '../intent.js';
import { isValidSlug } from '../slug.js';
import { runDoctor, serverPublicIp, probeHostDns, type FixId, type HostDnsProbe } from '../doctor.js';
import { resolveProjectDomain, baseOf } from '../domain.js';
import { updateConfigFile, mergeSetupBackup, updateCheckEnabled } from '../config.js';
import { resolveVersionUrl } from '../update.js';
import { MODEL_CHOICES, isModelId, modelLabel } from '../agent/models.js';
import {
  getFocus, setFocus, clearFocus, roomKeyboard, projectKeyboard, serverKeyboard, detectRoomSwitch,
  detectProjectAction, detectServerAction, inServerRoom, setServerRoom, clearServerRoom,
  type Room, type ServerAction,
} from './rooms.js';
import { conversationContext, recordExchange, clearConversation } from './convo.js';
import {
  routeMessage, runReadOp, runMutatingOp, looksOperational, looksLikeQuestion, missingSlugPrompt,
  runDevOpsConfirm, opLiteral, noneFallback,
  type DevOpsOp, type DevOpsOpId, type DevOpsDeps, type Route,
} from './devops.js';
import { homeStatusLines, homeKeyboard, degradedNoneMessage } from './home.js';
import { failureMessage, withElapsed, formatDeployCheck, detectLang, type DeployCheckFacts } from './format.js';
import { localDevInstructions, cloneUrl } from '../clone.js';
import type { StructuredLlm, LlmHealth } from '../llm.js';
import type { HostExec } from '../hostExec.js';
import { MEMORY_FILE, type Orchestrator, type TaskOutcome, type TaskAttachment } from '../orchestrator.js';
import {
  isImage, extractDocText, buildDocInstruction, buildImageInstruction, imageFileName,
  MAX_DOC_BYTES, MAX_IMAGE_BYTES,
  docAcceptedMsg, docTooBigMsg, docBinaryMsg, imageAcceptedMsg, imageTooBigMsg,
  someImagesTooBigMsg, downloadFailedMsg, otherUnsupportedMsg,
} from './ingest.js';
import {
  resolveTranscriptionSettings, transcribeAudio, audioFileName, MAX_AUDIO_BYTES,
  voiceTranscribingMsg, voiceHeardMsg, voiceEmptyMsg, voiceFailedMsg, voiceTooBigMsg, voiceNotConfiguredMsg,
} from './transcribe.js';
import { versionLine, VERSION } from '../version.js';
import type { Store } from '../db.js';
import type { Telemetry } from '../telemetry.js';
import type { DeployEngine, DomainChangeResult } from '../deploy/engine.js';
import { RESTART_NOTICE_KEY, SETUP_BACKUP_KEY, PREFLIGHT_WARNINGS_KEY, type Stage } from '../types.js';

const STAGE_LABELS: Record<Stage, string> = {
  accepted: '📥 Got it, working…',
  generating: '🤖 Generating code (usually a few minutes)',
  committing: '💾 Committing changes',
  building: '🔨 Building the image',
  deploying: '🚀 Deploying',
  checking: '🌐 Checking the service responds',
  screenshot: '📸 Taking a screenshot',
  done: '✅ Done',
  failed: '❌ Failed',
};

const HEARTBEAT_MS = 25_000; // never silent longer than 30s (§4 EPIC B)

// A Telegram album (several photos in one send) arrives as separate updates
// sharing a media_group_id, with no "that's all" signal. Buffer them and fire
// shortly after the last one lands. Telegram caps an album at 10 items.
const ALBUM_DEBOUNCE_MS = 1_200;
const MAX_ALBUM_IMAGES = 10;

/** One image of an album, queued for download once the album is complete. */
interface AlbumImage {
  fileId: string;
  size: number;
  name: string;
  mime?: string;
}

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
  /** free text awaiting "new or edit?" disambiguation, keyed by chat; messageId guards stale buttons.
   *  Carries optional attachments so an image disambiguation still delivers the files. */
  private pendingAmbiguous = new Map<number, { messageId: number; text: string; attachments?: TaskAttachment[] }>();
  /** DevOps op awaiting a confirm button; messageId guards stale clicks. */
  private pendingDevOps = new Map<number, { messageId: number; op: DevOpsOp; confirmed: boolean }>();
  /** A domain change awaiting its ✅ confirm; messageId guards stale clicks. */
  private pendingDomainChange = new Map<number, { messageId: number; slug: string; host: string }>();
  /** A failed task offering a 🔁 Retry; messageId guards stale buttons. Keeps the
   *  attachments so a retried image build re-delivers the reference files. */
  private pendingRetry = new Map<number, { messageId: number; kind: 'create' | 'resume' | 'edit' | 'rollback'; slug?: string; instruction: string; attachments?: TaskAttachment[] }>();
  /** Cancel fns for still-queued tasks, keyed by their status message id (🚫 Cancel). */
  private pendingTaskCancel = new Map<number, () => boolean>();
  /** Photos buffered by media_group_id while an album is still arriving (Telegram
   *  sends each photo of an album as its own update). A short debounce gathers
   *  them, then ALL of them go to one task as reference images. */
  private pendingAlbums = new Map<string, {
    ctx: Context;
    images: AlbumImage[];
    caption?: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** media_group ids already dispatched (timestamped, briefly kept). Guards the
   *  rare case where an album's photos straddle two long-poll batches: a straggler
   *  arriving after the debounce fired must NOT spawn a second task. */
  private flushedAlbums = new Map<string, number>();
  /** Chats currently pasting a Whisper API key via /setup → 🎤 Voice. The next
   *  text message is captured as the key (and then deleted). */
  private expectingVoiceKey = new Set<number>();
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
      updateUrl: resolveVersionUrl(),
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
          '• "change todo\'s domain to landing" → moves it to another subdomain of your base (asks first)',
          '• "show the load" / "restart todo" / "update the server" → server ops (with confirmation)',
          '',
          'The buttons below change with where you are: 🏠 Home, inside a project, or the 🛠 Server room (each shows its own quick actions and 🚪 Exit).',
          '',
          'Need a command? Tap the “/” menu — /list, /logs, /doctor, /rollback, /setup… (most take a <slug>).',
          '',
          versionLine(),
        ].join('\n'),
        { reply_markup: this.replyKeyboardFor(ctx.chat!.id) },
      ),
    );

    this.bot.command('list', async (ctx) => {
      const projects = this.store.listProjects();
      if (!projects.length) {
        await ctx.reply('No projects yet. Describe one and I will build it.', { reply_markup: this.replyKeyboardFor(ctx.chat!.id) });
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
      // A small legend so the status dots aren't a guessing game.
      lines.push('🟢 live · 🟡 container down · 🔴 failed · ⚪️ stopped\nTap a project below to connect.');
      // Tappable: each project connects to it (same 🔗 affordance as the picker).
      const kb = new InlineKeyboard();
      for (const p of projects) kb.text(`🔗 ${p.slug}`, `room:project:${p.slug}`).row();
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
      const trunc = content.length > 3500 ? '…(earlier lines trimmed)\n' : '';
      await this.replyMdSafe(ctx, `Memory for ${slug} (CLAUDE.md):\n\`\`\`\n${trunc}${content.slice(-3500) || '(empty)'}\n\`\`\``);
    });

    this.bot.command('rollback', async (ctx) => {
      const slug = this.argSlug(ctx);
      if (!slug) return void ctx.reply('Usage: /rollback <slug>');
      if (!this.store.projectExists(slug)) return void ctx.reply(`Project ${slug} not found.`);
      // Mutating + irreversible-ish → confirm first, exactly like the ↩️ keyboard
      // tap (was: rolled back immediately on the command).
      await this.promptMutatingOp(ctx, opLiteral('rollback_service', slug));
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

      // Voice (STT): paste a Whisper key to switch it on, or turn it off. No
      // restart — the voice handler reads the key live from config on each note.
      if (data === 'setup:voice') {
        await ctx.answerCallbackQuery();
        const on = !!this.transcriptionSettings();
        const kb = new InlineKeyboard();
        if (on) kb.text('🔕 Turn off voice', 'setup:voiceoff');
        this.expectingVoiceKey.add(chatId);
        await ctx.reply(
          (on
            ? '🎤 Voice is on. Paste a new key to replace it, or turn it off below.\n\n'
            : '🎤 Turn on voice transcription.\n\n') +
            'Get a FREE key at console.groq.com (it starts with `gsk_`), then paste it here. ' +
            'OpenAI keys (`sk-…`) work too.\n' +
            '_I will delete your message right after saving the key._',
          { parse_mode: 'Markdown', reply_markup: kb.inline_keyboard.flat().length ? kb : undefined },
        );
        return;
      }
      if (data === 'setup:voiceoff') {
        await ctx.answerCallbackQuery({ text: 'Voice off' });
        this.expectingVoiceKey.delete(chatId);
        try { updateConfigFile({ transcription: undefined }); } catch { /* ignore */ }
        await ctx.reply('🔕 Voice transcription turned off. Re-enable any time with /setup → 🎤 Voice.');
        logger.info('voice transcription disabled');
        return;
      }

      // Toggle the daily update-check alert. No restart — the checker reads the
      // flag live each tick, so it takes effect immediately.
      if (data === 'setup:autoupdate') {
        await ctx.answerCallbackQuery();
        const cfg = updateConfigFile({});
        const enabled = !updateCheckEnabled(cfg);
        updateConfigFile({ updateCheck: { ...cfg.updateCheck, enabled } });
        await ctx.reply(
          enabled
            ? "🔔 Update alerts ON — I'll check daily and only ping you when things are quiet (no task running, chat idle)."
            : '🔕 Update alerts OFF — I won\'t check for new versions. You can still update anytime via 🛠 Server → ⬆️ Update.',
        );
        logger.info('update-check toggled', { enabled });
        return;
      }

      // Auto-update offer buttons: "Update now" drops into the standard host-level
      // self-update confirm; "Later" just dismisses (the checker's snooze window
      // was already set when the offer was sent, so it won't re-ask for ~24h).
      if (data === 'update:now') {
        await ctx.answerCallbackQuery();
        const op = opLiteral('self_update');
        const kb = new InlineKeyboard().text('✅ Execute', 'devops:exec').text('✖️ Cancel', 'devops:cancel');
        const sent = await ctx.reply(`${op.humanSummary}?`, { reply_markup: kb });
        this.pendingDevOps.set(chatId, { messageId: sent.message_id, op, confirmed: false });
        return;
      }
      if (data === 'update:later') {
        await ctx.answerCallbackQuery({ text: 'OK — later' });
        const mid = ctx.callbackQuery.message?.message_id;
        if (mid) await this.bot.api.editMessageText(chatId, mid, "🕒 OK — I'll remind you at a good moment.").catch(() => {});
        return;
      }

      if (data.startsWith('setup:')) {
        await ctx.answerCallbackQuery();
        const what = data.slice('setup:'.length);
        // Honest timing: a running build delays the restart (restartWhenIdle waits
        // for the queue), so don't promise "~10s" when something is in flight.
        const when = this.orchestrator.queueLength > 0
          ? 'right after the current task finishes'
          : 'in about 10 seconds';
        if (what === 'auth') {
          const cfg = updateConfigFile({});
          // Merge (first-capture-wins) so tapping auth AND domain before the
          // restart backs up BOTH — never a single-slot clobber that loses one.
          this.store.kvSet(SETUP_BACKUP_KEY, mergeSetupBackup(this.store.kvGet(SETUP_BACKUP_KEY), {
            anthropicApiKey: cfg.anthropicApiKey, claudeCodeOauthToken: cfg.claudeCodeOauthToken,
          }));
          updateConfigFile({ anthropicApiKey: undefined, claudeCodeOauthToken: undefined });
          await ctx.reply(`Restarting to change the coding-agent auth — I'll ask you here ${when}. Once I'm back, send /cancel to keep your current one.`);
        } else if (what === 'domain') {
          const cfg = updateConfigFile({});
          this.store.kvSet(SETUP_BACKUP_KEY, mergeSetupBackup(this.store.kvGet(SETUP_BACKUP_KEY), { baseDomain: cfg.baseDomain }));
          updateConfigFile({ baseDomain: undefined });
          await ctx.reply(`Restarting to change the domain — I'll ask you here ${when}. Once I'm back, send /cancel to keep your current one. (Existing projects keep their addresses.)`);
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

      // Domain change confirm / cancel (tap-to-confirm, messageId-guarded so a
      // stale card can't fire). Switches the live Caddy route and persists the
      // new domain only AFTER the route switch succeeds.
      if (data === 'domain:exec' || data === 'domain:cancel') {
        const entry = this.pendingDomainChange.get(chatId);
        if (!entry || entry.messageId !== ctx.callbackQuery.message?.message_id) {
          return void ctx.answerCallbackQuery({ text: 'This button is stale.' });
        }
        this.pendingDomainChange.delete(chatId);
        if (data === 'domain:cancel') {
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          await this.bot.api.editMessageText(chatId, entry.messageId, 'Domain change cancelled.').catch(() => {});
          return;
        }
        const project = this.store.getProject(entry.slug);
        if (!project) {
          await ctx.answerCallbackQuery({ text: 'Project no longer exists.' });
          await this.bot.api.editMessageText(chatId, entry.messageId, `Project ${entry.slug} no longer exists.`).catch(() => {});
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Switching…' });
        const base = `🌐 Pointing ${entry.slug} at ${entry.host} and issuing TLS…`;
        await this.bot.api.editMessageText(chatId, entry.messageId, base).catch(() => {});
        const stopHb = this.startHeartbeat(chatId, entry.messageId, base);
        const r: DomainChangeResult = await this.deployEngine
          .changeDomain(project, entry.host)
          .catch((e) => ({ ok: false, live: false, error: (e as Error).message }));
        stopHb();
        if (!r.ok) {
          await this.bot.api.editMessageText(
            chatId, entry.messageId,
            `❌ Couldn't change the domain: ${r.error}\n\nThe old address (${project.domain}) is untouched and still serving.`,
          ).catch(() => {});
          return;
        }
        // Route switch (or no-op) succeeded → make the new address the truth.
        this.store.updateProject(entry.slug, { domain: entry.host });
        this.store.kvSet(`last_active:${chatId}`, entry.slug);
        if (!r.live) {
          await this.editMdSafe(
            chatId, entry.messageId,
            `✓ Saved *${entry.slug}*'s address as ${entry.host}.\nThe service isn't running right now, so I couldn't switch the live route — it takes effect on the next deploy.`,
          );
          return;
        }
        const lines = [
          `✅ *${entry.slug}* — domain changed`,
          `https://${entry.host}/`,
          '',
          `The old address (${project.domain}) no longer serves this project.`,
        ];
        if (r.publicWarning) lines.push('', `⚠️ ${r.publicWarning}`);
        const fixKb = r.publicWarning ? this.doctorKeyboard(entry.slug, ['proxy', 'recheck']) : undefined;
        await this.bot.api.editMessageText(chatId, entry.messageId, lines.join('\n'), {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: fixKb,
        }).catch(async () => {
          await this.bot.api.editMessageText(chatId, entry.messageId, lines.join('\n'), { reply_markup: fixKb }).catch(() => {});
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
        if (outcome.ok) {
          // The project is gone — don't let a stale transcript or last_active
          // pointer make a follow-up resolve to a project that no longer exists.
          if (this.store.kvGet(`last_active:${chatId}`) === entry.slug) this.store.kvSet(`last_active:${chatId}`, '');
          if (wasConnected) {
            // Deleting the connected project is an effective return to Home →
            // fresh dialogue + restore the global bar (an editMessageText can't
            // carry a reply keyboard).
            clearConversation(this.store, chatId);
            await ctx.reply('🚪 Back to Home — that project is gone.', { reply_markup: roomKeyboard() }).catch(() => {});
          }
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
        return void this.runTask(entry.kind, entry.slug, entry.instruction, ctx, entry.attachments);
      }

      // 🚫 Cancel a still-queued task. Keyed by the status message's id; a no-op
      // once it's running (the orchestrator returns false → "too late").
      if (data === 'taskcancel') {
        const mid = ctx.callbackQuery.message?.message_id;
        const cancel = mid != null ? this.pendingTaskCancel.get(mid) : undefined;
        if (!cancel) return void ctx.answerCallbackQuery({ text: 'Nothing to cancel.' });
        const ok = cancel(); // resolves the task as cancelled → runTask renders it
        if (ok && mid != null) this.pendingTaskCancel.delete(mid);
        await ctx.answerCallbackQuery({ text: ok ? 'Cancelled' : 'Already running — too late to cancel.' });
        return;
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
        await this.runTask('create', undefined, pending.text, ctx, pending.attachments);
      } else if (data.startsWith('intent:edit:')) {
        await this.runTask('edit', data.slice('intent:edit:'.length), pending.text, ctx, pending.attachments);
      }
    });

    // Focus shortcuts (same logic as the persistent keyboard buttons).
    this.bot.command('home', (ctx) => this.switchRoom(ctx, { kind: 'home' }));
    this.bot.command('server', (ctx) => this.switchRoom(ctx, { kind: 'devops' }));
    this.bot.command('projects', (ctx) => this.showProjectPicker(ctx));
    this.bot.command('version', (ctx) => ctx.reply(versionLine()));

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      // A /setup → 🎤 Voice key paste in flight: capture this message as the key
      // (and delete it) instead of routing it as a build request.
      if (this.expectingVoiceKey.has(ctx.chat.id)) return void this.captureVoiceKey(ctx, text);
      return this.routeText(ctx, text);
    });

    // Attachments: a text DOCUMENT (a spec to build from) and an IMAGE (a UI
    // mockup or a bug screenshot) are real inputs, routed through the SAME
    // create/edit/question pipeline as typed text. These specific filters must be
    // registered BEFORE the generic catch-all (grammy stops at the first match).
    this.bot.on('message:document', (ctx) => this.handleDocument(ctx));
    this.bot.on('message:photo', (ctx) => this.handlePhoto(ctx));
    // Voice / audio / round video: transcribe (when a Whisper key is set) and act
    // on the transcript like typed text. Registered before the catch-all.
    this.bot.on(['message:voice', 'message:audio', 'message:video_note'], (ctx) => this.handleVoice(ctx));
    // Anything still unhandled (video / sticker / …): acknowledge it so "just
    // talk" never meets silence, and say what IS supported.
    this.bot.on('message', async (ctx) => {
      await ctx.reply(otherUnsupportedMsg);
    });

    this.bot.catch((err) => logger.error('telegram handler error', { error: String(err.error) }));
  }

  /**
   * Route a typed (or transcribed) message exactly like a chat line: focus
   * shortcuts and project/server one-taps first (deterministic, no LLM), then
   * the content router. Shared by `message:text` and the voice handler so a
   * spoken "go home" / "show load" / "add a dark theme" behaves identically.
   */
  private async routeText(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat!.id;

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
      if (action === 'domain') return void this.sendDomainInfo(ctx, connected);
      if (action === 'rollback') {
        // Mutating → confirm first so a stray keyboard tap can't roll back.
        return void this.promptMutatingOp(ctx, opLiteral('rollback_service', connected));
      }
    }

    // Server/admin room: deterministic one-taps for the server keyboard
    // (read-only run instantly; mutating ask first). Work even if the LLM is down.
    if (inServerRoom(this.store, chatId)) {
      const sa = detectServerAction(text);
      if (sa) return void this.runServerAction(ctx, sa);
    }

    return this.handleMessage(ctx, text);
  }

  // --- soft-context routing ---

  /** Connect to a project (explicit, sticky context) or disconnect (🏠). */
  private async switchRoom(ctx: Context, room: Room): Promise<void> {
    const chatId = ctx.chat!.id;
    // A real room change starts a fresh dialogue ("within the current dialogue"),
    // so memory must not leak across rooms. But a no-op re-tap of the room you're
    // already in must NOT wipe a dialogue in progress.
    const curFocus = getFocus(this.store, chatId);
    const curServer = inServerRoom(this.store, chatId);
    const sameRoom =
      (room.kind === 'project' && curFocus === room.slug) ||
      (room.kind === 'devops' && curServer) ||
      (room.kind === 'home' && !curFocus && !curServer);
    if (!sameRoom) clearConversation(this.store, chatId);
    if (room.kind === 'project') {
      clearServerRoom(this.store, chatId);
      setFocus(this.store, chatId, room.slug);
      await ctx.reply(
        `🔗 *Connected to ${room.slug}.*\nChanges ("add a dark theme") and questions ("how is this built?") now go straight here — no extra prompts. (Server ops like "restart" still ask first.)\nQuick actions below: 🔍 Review · 📋 Logs · ↩️ Rollback (asks first). Tap 🚪 Exit to disconnect.`,
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
        '🛠 *Server — admin mode.*\nJust say what you need: "show load", "restart todo", "clean disk", "update". Or tap a button below. I ask before anything risky.\n' +
          'Change a project\'s address too: "change todo\'s domain to landing" — a subdomain of your base (external domains aren\'t supported).\n' +
          'Tap 🚪 Exit to leave.',
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
    const voiceOn = !!this.transcriptionSettings();
    const updatesOn = this.updateCheckOn();
    const kb = new InlineKeyboard()
      .text('🔑 Coding agent auth', 'setup:auth')
      .text('🌐 Domain', 'setup:domain')
      .row()
      .text('🧠 Model', 'setup:model')
      .text('📊 Toggle telemetry', 'setup:telemetry')
      .row()
      .text(voiceOn ? '🎤 Voice (on)' : '🎤 Voice (off)', 'setup:voice')
      .text(updatesOn ? '🔔 Update alerts (on)' : '🔔 Update alerts (off)', 'setup:autoupdate');
    await ctx.reply(
      `What do you want to change? Current model: ${modelLabel(this.currentModel())}. ` +
        `Voice transcription is ${voiceOn ? 'on' : 'off'}; update alerts are ${updatesOn ? 'on' : 'off'}.`,
      { reply_markup: kb },
    );
  }

  /** Auto update-check state, read live from config (default ON). */
  private updateCheckOn(): boolean {
    try {
      return updateCheckEnabled(updateConfigFile({}));
    } catch {
      return true;
    }
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
    // Changing a project's DOMAIN is a route operation, not a code edit — handle
    // it deterministically (works with the LLM router down) before anything can
    // misroute it to the coding agent, which would only edit canonical-URL
    // strings in the source and falsely report the address as changed.
    if (looksLikeDomainChange(text)) return void this.handleDomainChange(ctx, text);
    const slugs = this.store.listProjects().map((p) => p.slug);
    const inServer = inServerRoom(this.store, chatId);
    // Only an EXPLICIT connection (focus) silently routes a bare follow-up to a
    // project. A stale last_active must NOT masquerade as "connected": a bare
    // "add a dark theme" days later should never silently edit a project the user
    // never reopened. Auto-connect after a build sets focus, so the normal
    // iterate loop is unaffected; last_active only seeds the "Edit <recent>"
    // suggestion buttons (see dispatchRoute 'none' / fallbackNoLlm).
    const focused = inServer ? null : getFocus(this.store, chatId);

    // Conversation memory: read the dialogue SO FAR (before this message). The
    // router and askProject get the prior turns so a follow-up ("explain what's
    // here") carries context — in a project AND in the 🛠 Server room. The turn
    // itself is recorded as a clean user→bot PAIR at each answer point (so the
    // transcript never drifts with dangling, unanswered user lines).
    const history = conversationContext(this.store, chatId);

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
    const route = await routeMessage(this.structuredLlm, text, slugs, focused, inServer, history ?? undefined);
    await this.dispatchRoute(ctx, route, text, focused, thinking.message_id, history);
  }

  /**
   * Create a new project. The very first project is built straight away (nothing
   * to confuse it with). Once projects EXIST, always confirm — a create-phrased
   * message may really be about an existing project, and a silent build means an
   * accidental duplicate. The closest-looking existing project is offered first
   * (fuzzy/transliterated name match), then the rest, so "improve X" is one tap.
   * `thinkingId` is an existing "💭…" message to edit, or null to send fresh.
   */
  private async createOrAsk(ctx: Context, description: string, slugs: string[], thinkingId: number | null, attachments?: TaskAttachment[]): Promise<void> {
    const chatId = ctx.chat!.id;
    if (slugs.length === 0) {
      if (thinkingId) await this.deleteMessage(chatId, thinkingId);
      return void this.runTask('create', undefined, description, ctx, attachments);
    }
    const similar = findSimilarProject(description, slugs);
    const ordered = similar ? [similar, ...slugs.filter((s) => s !== similar)] : slugs;
    const shown = ordered.slice(0, 6); // keep the keyboard sane for many projects
    const kb = new InlineKeyboard();
    if (similar) {
      // A near-duplicate exists → lead with "improve it" so the DEFAULT (top) tap
      // isn't an accidental clone; the New-project escape hatch sits right below.
      kb.text(`✏️ Improve ${similar}`, `intent:edit:${similar}`).row();
      kb.text('🆕 New project', 'intent:new').row();
      for (const s of shown.filter((s) => s !== similar)) kb.text(`✏️ ${s}`, `intent:edit:${s}`).row();
    } else {
      kb.text('🆕 New project', 'intent:new').row();
      for (const s of shown) kb.text(`✏️ ${s}`, `intent:edit:${s}`).row();
    }
    // Plain text (no Markdown): the description is arbitrary user text.
    const desc = description.length > 80 ? description.slice(0, 79) + '…' : description;
    const more = ordered.length > shown.length ? "\n(or type a project's name to change it)" : '';
    const body =
      `You have ${slugs.length} project${slugs.length === 1 ? '' : 's'}. ` +
      `Make a NEW one for "${desc}", or improve an existing project?` +
      (similar ? `\nThis looks related to ${similar}.` : '') + more;
    if (thinkingId) {
      await this.bot.api.editMessageText(chatId, thinkingId, body, { reply_markup: kb }).catch(() => {});
      this.pendingAmbiguous.set(chatId, { messageId: thinkingId, text: description, attachments });
    } else {
      const sent = await ctx.reply(body, { reply_markup: kb });
      this.pendingAmbiguous.set(chatId, { messageId: sent.message_id, text: description, attachments });
    }
  }

  private async dispatchRoute(
    ctx: Context, route: Route, text: string, focused: string | null, thinkingId: number, history: string | null = null,
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
        const res = await this.orchestrator.askProject(route.slug, route.question, history ?? undefined);
        // Keep the conversation's subject warm so a bare follow-up ("explain
        // what's here") attaches to this project instead of becoming an authoring
        // prompt — works even in the admin room, where focus is null.
        this.store.kvSet(`last_active:${chatId}`, route.slug);
        const answer = res.answer || 'No answer.';
        recordExchange(this.store, chatId, text, answer);
        return void this.editMdSafe(chatId, thinkingId, answer);
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
        // A devops op naming a project keeps it as the warm subject, so a
        // follow-up question ("explain what's here") attaches to it.
        if (op.slug) this.store.kvSet(`last_active:${chatId}`, op.slug);
        const need = missingSlugPrompt(op);
        if (need) return void this.bot.api.editMessageText(chatId, thinkingId, need).catch(() => {});
        if (!op.mutating) {
          const result = await runReadOp(op, this.devopsDeps()).catch((e) => `Error: ${(e as Error).message}`);
          // Record the read result (e.g. a Dockerfile/logs dump) so a follow-up
          // ("explain what's here") is answered with it in view.
          recordExchange(this.store, chatId, text, result);
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
        const recent = focused ?? this.store.kvGet(`last_active:${chatId}`);
        const haveRecent = !!recent && this.store.projectExists(recent);
        const inServer = inServerRoom(this.store, chatId);
        switch (noneFallback(text, haveRecent, inServer, !!history)) {
          case 'question': {
            // A follow-up question with no explicit target → answer it about the
            // project we were just discussing (read-only). Fixes "объясни, что
            // тут" after asking about a project, incl. in the admin room.
            await this.bot.api.editMessageText(chatId, thinkingId, '🤔 Looking into it…').catch(() => {});
            const res = await this.orchestrator.askProject(recent!, text, history ?? undefined);
            this.store.kvSet(`last_active:${chatId}`, recent!);
            const answer = res.answer || 'No answer.';
            recordExchange(this.store, chatId, text, answer);
            return void this.editMdSafe(chatId, thinkingId, answer);
          }
          case 'chat': {
            // Admin room, no project in scope, but there IS a dialogue → answer
            // the server/admin follow-up from the transcript (e.g. "show load"
            // then "is that a lot?"). General assistant, no project needed.
            await this.bot.api.editMessageText(chatId, thinkingId, '🤔 …').catch(() => {});
            const answer = await this.answerAdmin(text, history!);
            recordExchange(this.store, chatId, text, answer);
            return void this.editMdSafe(chatId, thinkingId, answer);
          }
          case 'ops':
            // Operational phrasing or the admin room with nothing to ground on:
            // clarify toward server/project ops — never "new app or edit?".
            await this.bot.api.editMessageText(
              chatId, thinkingId,
              "I didn't catch that. Try a server action — show load · containers · logs <project> · doctor <project> · " +
              'restart <project> · rollback <project> · restart proxy · clean disk · update botsman — or name a project to ask about it.',
            ).catch(() => {});
            return;
          case 'authoring': {
            const kb = new InlineKeyboard().text('🆕 New project', 'intent:new');
            if (haveRecent) kb.text(`✏️ Edit ${recent}`, `intent:edit:${recent}`);
            await this.bot.api.editMessageText(chatId, thinkingId, 'Is this a new project, or a change to an existing one?', { reply_markup: kb }).catch(() => {});
            this.pendingAmbiguous.set(chatId, { messageId: thinkingId, text });
            return;
          }
        }
        return;
      }
    }
  }

  /** General admin/server assistant: answer a server-room follow-up from the
   *  conversation transcript when no project is in scope (e.g. "show load" then
   *  "is that a lot?"). Uses the structured LLM with a JSON envelope so it works
   *  in both auth modes. Grounded ONLY in the dialogue — it doesn't run ops. */
  private async answerAdmin(question: string, history: string): Promise<string> {
    if (!this.structuredLlm) return "I can't answer that right now — the AI router is unavailable.";
    const reply = await this.structuredLlm<{ answer: string }>({
      system:
        "You are Botsman's server-admin assistant. Answer the user's question about their server or projects using ONLY the recent conversation below; be concise and practical, and never invent data you weren't shown. Reply in the user's language. Reply with ONLY a JSON object: {\"answer\":\"…\"}.",
      user: `Recent conversation (oldest first):\n${history}\n\nQuestion: ${question}`,
      validate: (raw) => {
        const a = (raw as { answer?: unknown })?.answer;
        return typeof a === 'string' && a.trim() ? { answer: a } : null;
      },
      maxTokens: 700,
    });
    return reply?.answer
      ?? "I couldn't work that out from our conversation. Try a server action, or name a project to ask about it.";
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
    const kb = new InlineKeyboard().text('🆕 New project', 'intent:new');
    const recent = focused ?? this.store.kvGet(`last_active:${chatId}`);
    if (recent && this.store.projectExists(recent)) kb.text(`✏️ Edit ${recent}`, `intent:edit:${recent}`);
    const sent = await ctx.reply('Is this a new project, or a change to an existing one?', { reply_markup: kb });
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

  /** Show the single-confirm card for a mutating devops op (✅ Execute / ✖️ Cancel)
   *  and remember it (messageId-guarded). Host-level ops escalate to a 2nd confirm
   *  inside runDevOpsConfirm. Shared by /rollback, the ↩️ keyboard tap and server
   *  actions so a mutating op is never one stray tap away from running. */
  private async promptMutatingOp(ctx: Context, op: DevOpsOp): Promise<void> {
    const kb = new InlineKeyboard().text('✅ Execute', 'devops:exec').text('✖️ Cancel', 'devops:cancel');
    const sent = await ctx.reply(`${op.humanSummary}?`, { reply_markup: kb });
    this.pendingDevOps.set(ctx.chat!.id, { messageId: sent.message_id, op, confirmed: false });
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
    const trunc = logs.length > 3500 ? '…(earlier lines trimmed)\n' : '';
    await this.replyMdSafe(ctx, `Logs for ${slug} (last lines):\n\`\`\`\n${trunc}${logs.slice(-3500) || '(empty)'}\n\`\`\``);
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

  /** 🌐 Domain one-tap: show the current address and how to change it. Tapping
   *  the keyboard button carries no target, so this is an info card, not a
   *  capture step — the user then sends "смени домен на <label>". */
  private async sendDomainInfo(ctx: Context, slug: string): Promise<void> {
    const p = this.store.getProject(slug);
    if (!p) return void ctx.reply(`Project ${slug} not found.`);
    const base = baseOf(p.domain);
    await this.replyMdSafe(
      ctx,
      `🌐 *${slug}* is served at:\nhttps://${p.domain}/\n\n` +
        `To change it, just say e.g. «смени домен на landing» or "change the domain to landing". ` +
        `It must be a subdomain of \`${base}\` (the wildcard \`*.${base}\` already points here).`,
    );
  }

  /**
   * Free-text "change a project's domain" → a tap-to-confirm card. Resolves the
   * target project (an explicitly named slug, else the connected one) and the
   * new address (the token after "на"/"to", else a bare host), validates scope
   * (subdomain of THIS project's base, valid label, not taken), probes DNS for a
   * non-blocking heads-up, then asks to confirm. Deterministic so it works with
   * the LLM router down.
   */
  private async handleDomainChange(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat!.id;
    const slugs = this.store.listProjects().map((p) => p.slug);
    if (!slugs.length) {
      await ctx.reply("No projects yet — describe one and I'll build it first.");
      return;
    }
    const focused = inServerRoom(this.store, chatId) ? null : getFocus(this.store, chatId);
    const target = parseDomainTarget(text);
    const intent = detectIntent(text, slugs, focused);
    let slug = intent.kind === 'edit' ? intent.slug : null;
    // Guard the "new label coincides with a project name" case: if the ONLY
    // resolved slug is the target token itself (e.g. «смени домен на landing»
    // while a project named "landing" exists), that's the destination — not the
    // project to change — so fall back to the connected one, else ask.
    if (slug && target && slug === target.toLowerCase()) {
      slug = focused && focused !== slug ? focused : null;
    }
    if (!slug) {
      await ctx.reply("Which project's domain do you want to change? Say e.g. «смени домен <project> на landing».");
      return;
    }
    const project = this.store.getProject(slug);
    if (!project) return void ctx.reply(`Project ${slug} not found.`);
    const base = baseOf(project.domain);
    if (!target) {
      await this.replyMdSafe(
        ctx,
        `What should *${slug}*'s new address be? It must be a subdomain of \`${base}\` — e.g. «смени домен ${slug} на landing».`,
      );
      return;
    }
    const taken = (host: string): string | null =>
      this.store.listProjects().find((p) => p.slug !== slug && p.domain.toLowerCase() === host)?.slug ?? null;
    const res = resolveProjectDomain(target, base, project.domain, taken);
    if (!res.ok) return void this.replyMdSafe(ctx, `🌐 Can't use that: ${res.reason}`);
    const host = res.host;

    // DNS is a non-blocking heads-up: a new subdomain of an already-working
    // wildcard base usually resolves immediately, but a proxied/mispointed
    // record would break TLS, so surface it before the switch.
    const probe = await probeHostDns(host).catch(() => null);
    const dnsNote = this.domainDnsNote(probe, host, base);
    const kb = new InlineKeyboard().text('✅ Change it', 'domain:exec').text('✖️ Cancel', 'domain:cancel');
    const body =
      `🌐 Change *${slug}*'s domain?\n\n` +
      `From: ${project.domain}\nTo: ${host}\n` +
      (dnsNote ? `\n${dnsNote}\n` : '') +
      `\nI'll re-point the live route (the old address then stops serving this project) and issue TLS for the new host.`;
    const sent = await ctx.reply(body, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
    this.pendingDomainChange.set(chatId, { messageId: sent.message_id, slug, host });
  }

  /** Turn a DNS probe into a one-line warning for the confirm card, or '' when
   *  the host already resolves to this server (the common case). */
  private domainDnsNote(probe: HostDnsProbe | null, host: string, base: string): string {
    if (!probe || probe.status === 'ok') return '';
    switch (probe.status) {
      case 'no-dns':
        return `⚠️ \`${host}\` doesn't resolve yet. If \`*.${base}\` is a wildcard pointing here it will once DNS propagates; otherwise add the record. I'll still switch the route.`;
      case 'cloudflare':
        return `⚠️ \`${host}\` → a Cloudflare proxy address (${probe.ips[0]}). TLS issuance fails until the record is *DNS only* (grey cloud).`;
      case 'wrong-ip':
        return `⚠️ \`${host}\` → ${probe.ips.join(', ')}, not this server (${probe.serverIp}). HTTPS won't work until DNS points here.`;
    }
  }

  /** A server-keyboard tap → its devops op. Read-only runs instantly; mutating
   *  drops into the existing confirm flow (host-level Update → double confirm). */
  private async runServerAction(ctx: Context, action: ServerAction): Promise<void> {
    const chatId = ctx.chat!.id;
    const op = opLiteral(SERVER_ACTION_OPS[action]);
    if (!op.mutating) {
      const thinking = await ctx.reply(`⏳ ${op.humanSummary}…`);
      const result = await runReadOp(op, this.devopsDeps()).catch((e) => `Error: ${(e as Error).message}`);
      // Record the tap + its result so a typed follow-up ("is that a lot?") after
      // a one-tap (📊 Load / 🐳 Containers) is answered with the output in view.
      recordExchange(this.store, chatId, op.humanSummary, result);
      await this.editMdSafe(chatId, thinking.message_id, result);
      return;
    }
    await this.promptMutatingOp(ctx, op);
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

  /** Download a Telegram file by id into a Buffer. The bot token is in the URL,
   *  so it must never be logged. */
  private async downloadTgFile(fileId: string): Promise<Buffer> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('no file_path');
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Route an attachment-derived task. The agent payload (doc body / image refs)
   *  is decided here, but the create-vs-edit TARGET is read from the CAPTION only
   *  (never the payload) — so a slug mentioned inside a 15 KB spec can't silently
   *  retarget, and the body never enters the router prompt. Connected → edit;
   *  otherwise create-or-confirm via createOrAsk (which carries the attachments). */
  private async routeAttachment(ctx: Context, caption: string | undefined, payload: string, attachments?: TaskAttachment[]): Promise<void> {
    const chatId = ctx.chat!.id;
    const focused = getFocus(this.store, chatId);
    if (focused) return void this.runTask('edit', focused, payload, ctx, attachments);
    const slugs = this.store.listProjects().map((p) => p.slug);
    const cap = (caption ?? '').trim();
    if (cap) {
      const intent = detectIntent(cap, slugs, null); // null: don't auto-target via stale last_active
      if (intent.kind === 'edit') return void this.runTask('edit', intent.slug, payload, ctx, attachments);
    }
    // create (explicit, or no caption) → confirm against existing projects when
    // any exist (mirrors the typed-text path); builds straight away if none.
    await this.createOrAsk(ctx, payload, slugs, null, attachments);
  }

  /** A document attachment: an image-as-file becomes an image; a text spec is
   *  decoded and routed like a typed request; anything else is refused. */
  private async handleDocument(ctx: Context): Promise<void> {
    this.expectingVoiceKey.delete(ctx.chat!.id); // an attachment ends any key-wait
    const doc = ctx.message?.document;
    if (!doc) return;
    const name = doc.file_name ?? 'document';
    const caption = ctx.message?.caption;
    if (isImage(name, doc.mime_type)) {
      const img: AlbumImage = { fileId: doc.file_id, size: doc.file_size ?? 0, name, mime: doc.mime_type };
      const groupId = ctx.message?.media_group_id;
      if (groupId) return void this.collectAlbumImage(ctx, groupId, img, caption);
      return void this.handleImages(ctx, [img], caption);
    }
    if ((doc.file_size ?? 0) > MAX_DOC_BYTES) return void ctx.reply(docTooBigMsg(name, doc.file_size!));
    let bytes: Buffer;
    try {
      bytes = await this.downloadTgFile(doc.file_id);
    } catch (e) {
      logger.warn('document download failed', { error: String((e as Error).message) });
      return void ctx.reply(downloadFailedMsg);
    }
    const res = extractDocText(bytes, name, doc.mime_type);
    if (!res.ok) {
      return void ctx.reply(res.reason === 'too_big' ? docTooBigMsg(name, bytes.length) : docBinaryMsg(name));
    }
    await ctx.reply(docAcceptedMsg(name, bytes.length));
    await this.routeAttachment(ctx, caption, buildDocInstruction({ caption, body: res.text, name }));
  }

  /** A compressed photo: pick the largest size and treat it as a reference image.
   *  Several photos sent at once share a media_group_id and arrive as separate
   *  updates → buffer them so the whole album reaches one task. */
  private async handlePhoto(ctx: Context): Promise<void> {
    this.expectingVoiceKey.delete(ctx.chat!.id); // an attachment ends any key-wait
    const sizes = ctx.message?.photo;
    if (!sizes?.length) return;
    const largest = sizes[sizes.length - 1]; // PhotoSize[] is ascending by resolution
    const img: AlbumImage = { fileId: largest.file_id, size: largest.file_size ?? 0, name: 'photo.jpg', mime: 'image/jpeg' };
    const groupId = ctx.message?.media_group_id;
    if (groupId) return void this.collectAlbumImage(ctx, groupId, img, ctx.message?.caption);
    await this.handleImages(ctx, [img], ctx.message?.caption);
  }

  /** Buffer one image of an in-flight album; (re)arm a short debounce so the task
   *  fires once shortly after the LAST photo lands. Telegram puts the caption on
   *  exactly one item of the album — keep the first one we see. */
  private collectAlbumImage(ctx: Context, groupId: string, img: AlbumImage, caption?: string): void {
    const now = Date.now();
    for (const [k, t] of this.flushedAlbums) if (now - t > 60_000) this.flushedAlbums.delete(k);
    // Already dispatched (a late straggler across poll batches) → drop it rather
    // than start a duplicate task. Losing one rare stray photo beats a second build.
    if (this.flushedAlbums.has(groupId)) return;
    const cap = caption?.trim() || undefined;
    const existing = this.pendingAlbums.get(groupId);
    if (existing) {
      if (existing.images.length < MAX_ALBUM_IMAGES) existing.images.push(img);
      if (cap && !existing.caption) existing.caption = cap;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flushAlbum(groupId), ALBUM_DEBOUNCE_MS);
      return;
    }
    this.pendingAlbums.set(groupId, {
      ctx,
      images: [img],
      caption: cap,
      timer: setTimeout(() => void this.flushAlbum(groupId), ALBUM_DEBOUNCE_MS),
    });
  }

  /** The debounce elapsed: hand the gathered album off as one task. */
  private async flushAlbum(groupId: string): Promise<void> {
    const album = this.pendingAlbums.get(groupId);
    if (!album) return;
    this.pendingAlbums.delete(groupId);
    this.flushedAlbums.set(groupId, Date.now()); // any straggler now gets dropped
    await this.handleImages(album.ctx, album.images, album.caption);
  }

  /** Deliver one or more reference images to the agent: download each, write them
   *  into the project dir (visible at /work) and reference them in a single
   *  instruction. Connected project → edit it; otherwise route as a create
   *  (confirmed against existing projects). Oversized/failed images are skipped
   *  rather than failing the whole batch. */
  private async handleImages(ctx: Context, images: AlbumImage[], caption?: string): Promise<void> {
    const chatId = ctx.chat!.id;
    const limited = images.slice(0, MAX_ALBUM_IMAGES);
    const multi = limited.length > 1;
    const attachments: TaskAttachment[] = [];
    // Track the two skip reasons apart: an oversized image and a failed download
    // need DIFFERENT advice (shrink it vs just resend it). Conflating them was a
    // regression — a single photo whose download hiccups would be told to shrink.
    let tooBig = 0;
    let failed = 0;
    for (const img of limited) {
      if (img.size > MAX_IMAGE_BYTES) { tooBig++; continue; }
      let bytes: Buffer;
      try {
        bytes = await this.downloadTgFile(img.fileId);
      } catch (e) {
        logger.warn('image download failed', { error: String((e as Error).message) });
        failed++;
        continue; // one bad download shouldn't sink the rest of the album
      }
      if (bytes.length > MAX_IMAGE_BYTES) { tooBig++; continue; }
      // Single image keeps the legacy "reference.png"; an album gets unique,
      // 1-based names (reference1.png, reference2.jpg, …) so they never collide.
      const name = imageFileName(img.name, img.mime, multi ? attachments.length + 1 : undefined);
      attachments.push({ name, bytes });
    }
    if (!attachments.length) {
      // Prefer the size message only when size is why nothing survived.
      return void ctx.reply(tooBig ? imageTooBigMsg : downloadFailedMsg);
    }
    if (tooBig) await ctx.reply(someImagesTooBigMsg(tooBig));
    const fileRefs = attachments.map((a) => a.name);
    const cap = caption?.trim() || undefined;
    const connected = getFocus(this.store, chatId);
    if (connected) {
      await ctx.reply(imageAcceptedMsg(connected, !!cap, attachments.length));
      return void this.runTask('edit', connected, buildImageInstruction({ caption: cap, fileRefs, mode: 'edit' }), ctx, attachments);
    }
    await this.routeAttachment(ctx, cap, buildImageInstruction({ caption: cap, fileRefs, mode: 'create' }), attachments);
  }

  /** Voice / audio / round video → text. Transcribes via the configured Whisper
   *  endpoint (when a key is set), echoes what it heard, then routes the
   *  transcript exactly like a typed message. */
  private async handleVoice(ctx: Context): Promise<void> {
    this.expectingVoiceKey.delete(ctx.chat!.id); // a voice note ends any key-wait
    const m = ctx.message;
    const voice = m?.voice;
    const audio = m?.audio;
    const note = m?.video_note;
    const file = voice ?? audio ?? note;
    if (!file) return;
    const settings = this.transcriptionSettings();
    if (!settings) return void ctx.reply(voiceNotConfiguredMsg);
    if ((file.file_size ?? 0) > MAX_AUDIO_BYTES) return void ctx.reply(voiceTooBigMsg);

    const chatId = ctx.chat!.id;
    const status = await ctx.reply(voiceTranscribingMsg);
    const finish = (text: string): Promise<unknown> =>
      this.bot.api.editMessageText(chatId, status.message_id, text).catch(() => {});
    let bytes: Buffer;
    try {
      bytes = await this.downloadTgFile(file.file_id);
    } catch (e) {
      logger.warn('voice download failed', { error: String((e as Error).message) });
      return void finish(downloadFailedMsg);
    }
    const kind = voice ? 'voice' : audio ? 'audio' : 'video_note';
    const fileName = audioFileName(kind, audio?.file_name);
    const mime = voice?.mime_type ?? audio?.mime_type;
    const result = await transcribeAudio({ bytes, fileName, mime, settings });
    if (!result.ok) {
      const msg = result.reason === 'empty' ? voiceEmptyMsg
        : result.reason === 'too_big' ? voiceTooBigMsg
        : voiceFailedMsg;
      return void finish(msg);
    }
    // Show what we heard (so a misheard word is visible), then act on it.
    await finish(voiceHeardMsg(result.text));
    await this.routeText(ctx, result.text);
  }

  /** Resolve speech-to-text settings live from config + env, or null when off.
   *  Read per message so adding a key via /setup takes effect with no restart. */
  private transcriptionSettings() {
    try {
      return resolveTranscriptionSettings(updateConfigFile({}).transcription, process.env);
    } catch {
      return null;
    }
  }

  /** Capture a pasted Whisper API key (from /setup → 🎤 Voice), save it, and
   *  delete the user's message since it carries a secret. */
  private async captureVoiceKey(ctx: Context, raw: string): Promise<void> {
    const chatId = ctx.chat!.id;
    // Whatever happens, we stop expecting a key after ONE message — so a stray
    // build request or keyboard tap can never trap the chat waiting for a key.
    this.expectingVoiceKey.delete(chatId);
    const trimmed = raw.trim();
    if (/^(\/cancel|cancel|отмена)$/i.test(trimmed)) {
      return void ctx.reply('OK — left voice settings unchanged.');
    }
    const key = trimmed.replace(/\s+/g, '');
    // Providers vary (Groq `gsk_…`, OpenAI `sk-…`, or a bare token on a custom
    // endpoint). Anything that clearly ISN'T a key — a keyboard tap, a build
    // request — is the user moving on: route it normally instead of rejecting it.
    const looksLikeKey = /^(gsk_|sk-)\S{8,}$/.test(trimmed) || (!/\s/.test(trimmed) && key.length >= 24);
    if (!looksLikeKey) return this.routeText(ctx, trimmed);
    let deleted = false;
    try { await ctx.deleteMessage(); deleted = true; } catch { /* user may need to delete it */ }
    try {
      const cfg = updateConfigFile({});
      updateConfigFile({ transcription: { ...cfg.transcription, apiKey: key } });
    } catch (e) {
      logger.warn('failed to save transcription key', { error: String((e as Error).message) });
      return void ctx.reply("I couldn't save that key — please try /setup → 🎤 Voice again.");
    }
    logger.info('voice transcription enabled');
    await ctx.reply(
      `✓ Voice transcription is on — send me a voice note and I'll act on it.${deleted ? ' Your message with the key has been deleted.' : ' ⚠️ Please delete your message with the key.'}`,
    );
  }

  /** Run a long task with a live-updating status message + 30s heartbeat. */
  private async runTask(
    kind: 'create' | 'resume' | 'edit' | 'rollback',
    slug: string | undefined,
    instruction: string,
    ctx: Context,
    attachments?: TaskAttachment[],
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    // When something is already running, this task WAITS — say so clearly and
    // offer a 🚫 Cancel (it can still be pulled from the queue). A running task
    // can't be aborted, so the button only appears while queued.
    const wasQueued = this.orchestrator.queueLength > 0;
    const queued = wasQueued
      ? '\n⏳ Queued — one task at a time; this starts right after the current one finishes.'
      : '';
    // Name the target project from the first frame, so an edit/rollback never
    // leaves the user guessing WHICH project is changing (create fills it in once
    // the slug is generated, via the 'accepted' detail below).
    const head = STAGE_LABELS.accepted + (slug ? ` · ${slug}` : '') + queued;
    // The 🚫 Cancel button is the ONE time this status message carries an inline
    // keyboard. It's dropped the instant the task starts (the live heartbeat edits
    // strip reply_markup anyway), so the two never fight. No room keyboard here:
    // editMessageText can't edit a message bearing a ReplyKeyboardMarkup.
    const cancelKb = wasQueued ? new InlineKeyboard().text('🚫 Cancel', 'taskcancel') : undefined;
    const statusMsg = await ctx.reply(head, cancelKb ? { reply_markup: cancelKb } : {});

    let lastText = head;
    let dots = 0;
    let stageStartedAt = Date.now();
    // Once the outcome is being reported, stage/heartbeat edits must stop —
    // an in-flight "✅ Done" edit racing the rich final message would win.
    let finished = false;
    let started = !wasQueued; // a task with nothing ahead is running immediately
    // Build wall-clock: measured from when work actually STARTS (not enqueue), so
    // the reported time reflects the build, not how long it waited in the queue.
    let runStartedAt = Date.now();
    let earlyNudge: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
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
    // Don't tick while merely QUEUED — a heartbeat edit would strip the 🚫 Cancel
    // button. Start it only once the task actually begins (idempotent).
    const startTicks = (): void => {
      if (heartbeat) return;
      earlyNudge = setTimeout(tick, 9_000); // first sign of life well before 25s
      heartbeat = setInterval(tick, HEARTBEAT_MS);
    };
    const stopTicks = (): void => {
      if (earlyNudge) clearTimeout(earlyNudge);
      if (heartbeat) clearInterval(heartbeat);
    };
    if (!wasQueued) startTicks();

    try {
      const outcome = await this.orchestrator.enqueue(
        kind,
        instruction,
        (stage, detail) => {
          if (stage === 'accepted' && detail) slug = detail;
          // First report = it actually started running → retire the Cancel button
          // and start the build clock from here (queue wait doesn't count).
          if (!started) {
            started = true;
            runStartedAt = Date.now();
            this.pendingTaskCancel.delete(statusMsg.message_id);
          }
          // 'done'/'failed' are not shown as stages: the rich outcome message
          // (link, summary, screenshot) supersedes them.
          if (stage === 'done' || stage === 'failed') return;
          startTicks(); // begin the heartbeat now that work is underway
          const target = slug ? ` · ${slug}` : '';
          void update(`${STAGE_LABELS[stage]}${target}${detail && stage !== 'accepted' ? ` — ${detail}` : ''}`);
        },
        slug,
        // Register the cancel fn only while queued; the button uses it by messageId.
        (cancel) => { if (wasQueued) this.pendingTaskCancel.set(statusMsg.message_id, cancel); },
        attachments,
      );
      finished = true;
      stopTicks();
      this.pendingTaskCancel.delete(statusMsg.message_id);
      await this.reportOutcome(ctx, chatId, statusMsg.message_id, outcome, { kind, slug, instruction, attachments }, Date.now() - runStartedAt);
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
        // Connecting to a freshly-built project is a fresh dialogue, like a room
        // switch — drop the pre-build transcript so it can't leak into it.
        clearConversation(this.store, chatId);
        setFocus(this.store, chatId, outcome.slug);
        await ctx.reply(
          `🔗 Connected to ${outcome.slug} — changes ("add a dark theme") and questions go straight to it now. Tap 🚪 Exit to disconnect.`,
          { reply_markup: projectKeyboard() },
        ).catch(() => {});
      }
    } catch (e) {
      stopTicks();
      finished = true;
      this.pendingTaskCancel.delete(statusMsg.message_id);
      await this.reportOutcome(
        ctx, chatId, statusMsg.message_id,
        { ok: false, slug: slug ?? '', error: (e as Error).message },
        { kind, slug, instruction, attachments },
      );
    }
  }

  private async reportOutcome(
    ctx: Context, chatId: number, statusMsgId: number, o: TaskOutcome,
    retry?: { kind: 'create' | 'resume' | 'edit' | 'rollback'; slug?: string; instruction: string; attachments?: TaskAttachment[] },
    elapsedMs?: number,
  ): Promise<void> {
    if (o.cancelled) {
      // Cancelled while queued — never ran, so no Retry/Doctor card, just a
      // clean acknowledgement (and the 🚫 button is dropped with this edit).
      await this.bot.api.editMessageText(chatId, statusMsgId, "🚫 Cancelled — didn't run.").catch(() => {});
      return;
    }
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
    const hasScreenshot = !!(o.screenshotPath && fs.existsSync(o.screenshotPath));
    // Public-URL warning comes with one-tap fixes (retry TLS / re-check).
    const fixKb = o.warning ? this.doctorKeyboard(o.slug, ['proxy', 'recheck']) : undefined;

    let body: string;
    if (retry?.kind === 'create' || retry?.kind === 'resume') {
      // A freshly built project: a value-first "deploy check" (live URL, what it
      // is, then the plumbing the user didn't have to do), localized to the
      // spec's language. The clone command is filled in like /status + 💻 Code.
      const hostHome = process.env.BOTSMAN_HOST_DIR ?? '~/.botsman';
      const host = (await serverPublicIp()) ?? '<server>';
      const facts: DeployCheckFacts = {
        slug: o.slug,
        url: o.url,
        cloneCmd: o.slug ? cloneUrl({ slug: o.slug, hostHome, host }) : undefined,
        summary: o.summary,
        costUsd: o.costUsd,
        elapsedMs,
        publicWarning: o.warning,
        hasScreenshot,
      };
      body = formatDeployCheck(facts, detectLang(o.summary || retry?.instruction));
    } else {
      // Edits/rollbacks keep the concise format — the full checklist would be
      // noise on a one-line change to a project that's already live.
      const lines = [`✅ *${o.slug}* — deployed`];
      if (o.url) lines.push(o.url);
      if (o.summary) lines.push('', o.summary.slice(0, 2000));
      if (o.warning) lines.push('', `⚠️ ${o.warning}`);
      if (o.costUsd && o.costUsd > 0) lines.push('', `💸 Tokens: ≈$${o.costUsd.toFixed(2)}`);
      lines.push('', 'What should I change?');
      body = lines.join('\n');
    }
    await this.bot.api.editMessageText(chatId, statusMsgId, body, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: fixKb,
    }).catch(async () => {
      // Markdown in agent summaries can be malformed — retry as plain text.
      await this.bot.api.editMessageText(chatId, statusMsgId, body, {
        reply_markup: fixKb,
      }).catch(() => {});
    });
    if (hasScreenshot) {
      await ctx.replyWithPhoto(new InputFile(o.screenshotPath!)).catch((e) =>
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

  /** Offer a newer version to the owner with one-tap Update / Later buttons.
   *  Called by the UpdateChecker only at a quiet moment (no task, chat idle). */
  async offerUpdate(latest: string): Promise<void> {
    const kb = new InlineKeyboard().text('⬆️ Update now', 'update:now').text('🕒 Later', 'update:later');
    const text =
      `🆕 A newer Botsman is available: *v${latest}* (you're on v${VERSION}).\n` +
      "Update now? It rebuilds and restarts — I'm back in ~30–60s, and your projects and settings are untouched.";
    for (const id of this.ownerIds) {
      await this.bot.api.sendMessage(id, text, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
    }
  }

  async start(): Promise<void> {
    // Populate Telegram's native "/" menu so commands are discoverable (and
    // tappable on mobile) without memorising them from /start.
    await this.bot.api.setMyCommands([
      { command: 'list', description: 'All projects' },
      { command: 'projects', description: 'Pick a project to connect to' },
      { command: 'status', description: 'Status + git access — /status <slug>' },
      { command: 'logs', description: 'Container logs — /logs <slug>' },
      { command: 'doctor', description: 'Diagnose problems — /doctor <slug>' },
      { command: 'rollback', description: 'Roll back to the previous version — /rollback <slug>' },
      { command: 'memory', description: "What the agent remembers — /memory <slug>" },
      { command: 'delete', description: 'Delete a project — /delete <slug>' },
      { command: 'home', description: 'Home / main menu' },
      { command: 'server', description: 'Server admin room' },
      { command: 'setup', description: 'Change agent auth, domain, model or telemetry' },
      { command: 'version', description: 'The running version' },
    ]).catch((e) => logger.warn('setMyCommands failed', { error: String(e) }));
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
