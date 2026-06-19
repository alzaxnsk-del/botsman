import { Bot, InlineKeyboard, type Context } from 'grammy';
import dns from 'node:dns/promises';
import { logger } from '../logger.js';
import { updateConfigFile, missingSetup, isValidDomain } from '../config.js';
import { checkAnthropicKey, checkClaudeOauthToken } from '../preflight.js';
import { isCloudflareIp, serverPublicIp } from '../doctor.js';
import { MODEL_CHOICES, isModelId, modelLabel } from '../agent/models.js';
import type { Store } from '../db.js';
import { RESTART_NOTICE_KEY, SETUP_BACKUP_KEY, type BotsmanConfig } from '../types.js';

export const READY_NOTIFY_KEY = 'notify_ready';

type Expecting = 'oauth' | 'apikey' | 'domain' | null;

/**
 * In-chat onboarding (and re-configuration): the console only establishes the
 * trust channel (bot token + owner ID); agent auth, domain and telemetry are
 * collected in the Telegram chat, with live validation and one-tap buttons.
 *
 * Each completed step is persisted to config.json immediately — the config
 * file is the wizard state, so a daemon restart resumes at the first missing
 * field. When nothing is missing, the daemon restarts itself into full mode
 * (docker restart policy brings it back).
 */
export class OnboardingBot {
  private bot: Bot;
  private expecting: Expecting = null;
  /** Domain that failed the DNS probe, awaiting "re-check" or "use anyway". */
  private pendingDomain: string | null = null;
  private telemetryAsked = false;
  /** A button-only step is on screen (model / telemetry) — so typed text doesn't
   *  silently skip the choice. Cleared once the matching button is tapped. */
  private awaiting: 'model' | 'telemetry' | null = null;

  constructor(
    private token: string,
    private ownerIds: number[],
    private store: Store,
  ) {
    this.bot = new Bot(token);
    this.wire();
  }

  private config(): BotsmanConfig {
    // Re-read on every step: the file is the single source of truth.
    return updateConfigFile({});
  }

  private wire(): void {
    this.bot.use(async (ctx, next) => {
      if (!ctx.from || !this.ownerIds.includes(ctx.from.id)) {
        logger.warn('rejected non-owner message (onboarding)', { from: ctx.from?.id });
        if (ctx.message) await ctx.reply('This is a private bot. Only its owner can use it.');
        return;
      }
      await next();
    });

    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        "👋 Hi! I'm your Botsman — I build and deploy web services from plain descriptions.\n\n" +
        'A couple of quick questions and we are ready to go.',
      );
      await this.advance(ctx);
    });

    // Escape hatch from a /setup-triggered re-config: restore the previous
    // value and go back to full mode. Only works when there is a backup (i.e.
    // a genuine first-run onboarding can't be cancelled — it's required).
    this.bot.command('cancel', (ctx) => this.cancelSetup(ctx));

    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      await ctx.answerCallbackQuery();
      if (data === 'setup:cancel') { await this.cancelSetup(ctx); return; }
      switch (data) {
        case 'auth:oauth':
          this.expecting = 'oauth';
          await ctx.reply(
            'On a machine where you are logged into Claude Code, run:\n\n`claude setup-token`\n\n' +
            'and paste the resulting token (sk-ant-oat…) here.\n' +
            '_I will delete your message right after saving the token._',
            { parse_mode: 'Markdown' },
          );
          break;
        case 'auth:api':
          this.expecting = 'apikey';
          await ctx.reply(
            'Paste your Anthropic API key (sk-ant-api…, from console.anthropic.com).\n' +
            '_I will delete your message right after saving the key._',
            { parse_mode: 'Markdown' },
          );
          break;
        case 'dns:recheck':
          if (this.pendingDomain) await this.tryDomain(ctx, this.pendingDomain);
          break;
        case 'dns:force':
          if (this.pendingDomain) {
            const forced = this.pendingDomain;
            updateConfigFile({ baseDomain: forced });
            this.pendingDomain = null;
            await ctx.reply(
              `Saved \`${forced}\`. ⚠️ Until \`*.${forced}\` resolves to this server, project links and HTTPS will fail. ` +
              'Once the wildcard DNS record is live, re-verify any time with /setup → 🌐 Domain.',
              { parse_mode: 'Markdown' },
            );
            await this.advance(ctx);
          }
          break;
        case 'telemetry:yes':
        case 'telemetry:no': {
          this.awaiting = null;
          const enabled = data === 'telemetry:yes';
          const prev = this.config();
          updateConfigFile({ telemetry: { ...prev.telemetry, enabled } });
          await ctx.reply(enabled ? '✓ Telemetry enabled — thank you!' : '✓ Telemetry stays off.');
          await this.finalize(ctx);
          break;
        }
        default:
          if (data.startsWith('model:')) {
            const id = data.slice('model:'.length);
            if (!isModelId(id)) break;
            this.awaiting = null;
            const prev = this.config();
            updateConfigFile({ agent: { ...prev.agent, model: id } });
            await ctx.reply(`✓ ${modelLabel(id)} will write your code.`);
            await this.advance(ctx);
          }
          break;
      }
    });

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (/^(\/cancel|отмена|cancel)$/i.test(text)) return this.cancelSetup(ctx);
      switch (this.expecting) {
        case 'oauth': return this.handleOauthToken(ctx, text);
        case 'apikey': return this.handleApiKey(ctx, text);
        case 'domain': return this.tryDomain(ctx, text.toLowerCase());
        default:
          // A button-only step is showing — typing "opus" / "yes" would skip it
          // silently. Nudge to tap instead of advancing past the choice.
          if (this.awaiting === 'model') return void ctx.reply('Tap one of the model buttons above to choose.');
          if (this.awaiting === 'telemetry') return void ctx.reply('Tap "Yes, allow" or "No, keep off" above.');
          return this.advance(ctx);
      }
    });

    // Non-text during onboarding (e.g. a screenshot instead of a pasted token):
    // acknowledge instead of silently ignoring it.
    this.bot.on('message', async (ctx) => {
      await ctx.reply('Please send it as text — paste the token/key or type the answer.');
    });

    this.bot.catch((err) => logger.error('onboarding handler error', { error: String(err.error) }));
  }

  /** Add a "✖️ Cancel (keep current)" button when this is a /setup re-config
   *  (a backup exists), so the user is never trapped. Returns whether it added. */
  private addCancel(kb: InlineKeyboard): boolean {
    if (this.store.kvGet(SETUP_BACKUP_KEY)) {
      kb.row().text('✖️ Cancel (keep current)', 'setup:cancel');
      return true;
    }
    return false;
  }

  /** Restore the value a /setup change cleared and go back to full mode. */
  private async cancelSetup(ctx: Context): Promise<void> {
    const raw = this.store.kvGet(SETUP_BACKUP_KEY);
    if (!raw) {
      await ctx.reply('Nothing to cancel — this setup is required to start. Please finish it.');
      return;
    }
    try { updateConfigFile(JSON.parse(raw) as Record<string, unknown>); } catch { /* keep going */ }
    this.store.kvSet(SETUP_BACKUP_KEY, '');
    this.store.kvSet(RESTART_NOTICE_KEY, '✓ Cancelled — kept your previous settings.');
    await ctx.reply('Cancelled — restoring your previous settings…');
    logger.info('setup re-config cancelled, restoring backup');
    setTimeout(() => process.exit(0), 1500);
  }

  /** Ask for the first missing piece; finish when nothing is missing. */
  private async advance(ctx: Context): Promise<void> {
    const missing = missingSetup(this.config());
    if (missing.includes('auth')) {
      this.expecting = null;
      const kb = new InlineKeyboard()
        .text('🔑 Claude subscription', 'auth:oauth')
        .text('💳 Anthropic API key', 'auth:api');
      this.addCancel(kb);
      await ctx.reply(
        '*Step 1 of 4 · Coding agent*\n\n' +
        'How should I power code generation?\n\n' +
        '🔑 *Claude subscription* (Pro/Max) — no extra API bills; uses your plan limits, ' +
        'which heavy building can burn through fast, especially on Opus.\n' +
        '💳 *Anthropic API key* — pay-per-use.\n\n' +
        '_You can switch this anytime with /setup._',
        { parse_mode: 'Markdown', reply_markup: kb },
      );
      return;
    }
    if (missing.includes('domain')) {
      this.expecting = 'domain';
      const ip = await serverPublicIp();
      const kb = new InlineKeyboard();
      const hasCancel = this.addCancel(kb);
      await ctx.reply(
        '*Step 3 of 4 · Domain*\n\n' +
        'Send me the base domain for your services, e.g. `example.com`.\n' +
        'Every project gets its own subdomain: `todo.example.com`.\n\n' +
        'First create a wildcard A-record at your DNS provider:\n' +
        `\`\`\`\ntype  A\nhost  *\nvalue ${ip ?? '<this server\'s IP>'}\n\`\`\`\n` +
        '(If the domain is shared, use a sub-base like `apps.example.com` with host `*.apps` instead.)\n' +
        '⚠️ On Cloudflare the record must be *DNS only* (grey cloud), not Proxied.' +
        (hasCancel ? '\n\nSend /cancel or tap below to keep your current domain.' : ''),
        { parse_mode: 'Markdown', reply_markup: hasCancel ? kb : undefined },
      );
      return;
    }
    if (!this.telemetryAsked) {
      this.telemetryAsked = true;
      this.expecting = null;
      this.awaiting = 'telemetry';
      const kb = new InlineKeyboard().text('Yes, allow', 'telemetry:yes').text('No, keep off', 'telemetry:no');
      await ctx.reply(
        '*Step 4 of 4 · Anonymous telemetry*\n\n' +
        'May I send three anonymous lifecycle pings — installed / first deploy / returned after a week? ' +
        'Never code, prompts or project content. Off by default.',
        { parse_mode: 'Markdown', reply_markup: kb },
      );
      return;
    }
    await this.finalize(ctx);
  }

  private async handleOauthToken(ctx: Context, raw: string): Promise<void> {
    const token = raw.replace(/\s+/g, '');
    const deleted = await this.deleteUserMessage(ctx);
    if (!/^sk-ant-oat/.test(token)) {
      await ctx.reply('That does not look like a `claude setup-token` value (must start with sk-ant-oat). Try again.', { parse_mode: 'Markdown' });
      return;
    }
    const probeMsg = await ctx.reply('Checking the token (runs a tiny Claude Code request, ~15s)…');
    const probe = await checkClaudeOauthToken(token);
    if (!probe.ok) {
      await this.edit(ctx, probeMsg.message_id, `✗ The token does not work (${probe.error}). Generate a fresh one with \`claude setup-token\` and paste it again.`);
      return;
    }
    updateConfigFile({ claudeCodeOauthToken: token, anthropicApiKey: undefined });
    this.store.kvSet(SETUP_BACKUP_KEY, '');
    this.expecting = null;
    await this.edit(ctx, probeMsg.message_id, `✓ Token works — usage counts against your subscription limits.${this.deletedNote(deleted)}`);
    await this.askModel(ctx);
  }

  private async handleApiKey(ctx: Context, raw: string): Promise<void> {
    const key = raw.replace(/\s+/g, '');
    const deleted = await this.deleteUserMessage(ctx);
    const probeMsg = await ctx.reply('Checking the key…');
    const probe = await checkAnthropicKey(key);
    if (!probe.ok) {
      await this.edit(ctx, probeMsg.message_id, `✗ ${probe.error}. Paste a working key.`);
      return;
    }
    updateConfigFile({ anthropicApiKey: key, claudeCodeOauthToken: undefined });
    this.store.kvSet(SETUP_BACKUP_KEY, '');
    this.expecting = null;
    await this.edit(ctx, probeMsg.message_id, `✓ Key works.${this.deletedNote(deleted)}`);
    await this.askModel(ctx);
  }

  /** Part of the "coding agent" step: pick the model that writes the code. */
  private async askModel(ctx: Context): Promise<void> {
    this.expecting = null;
    this.awaiting = 'model';
    const kb = new InlineKeyboard();
    for (const m of MODEL_CHOICES) kb.text(m.label, `model:${m.id}`).row();
    await ctx.reply(
      '*Step 2 of 4 · Model*\n\n' +
      'Which model should write your code?\n\n' +
      MODEL_CHOICES.map((m) => `${m.label} — ${m.blurb}`).join('\n') +
      '\n\n_Recommended: 🏆 Opus for the best results. Change it anytime with /setup._',
      { parse_mode: 'Markdown', reply_markup: kb },
    );
  }

  private async tryDomain(ctx: Context, domain: string): Promise<void> {
    if (!isValidDomain(domain)) {
      await ctx.reply('That does not look like a domain. Send something like `example.com`.', { parse_mode: 'Markdown' });
      return;
    }
    const probe = `botsman-dns-probe.${domain}`;
    let ips: string[] = [];
    try {
      ips = await dns.resolve4(probe);
    } catch { /* handled below */ }

    if (!ips.length) {
      this.pendingDomain = domain;
      const kb = new InlineKeyboard().text('🔄 Re-check', 'dns:recheck').text('Use it anyway', 'dns:force');
      await ctx.reply(
        `✗ \`${probe}\` does not resolve yet.\n\nCreate the wildcard record (see above) and tap Re-check — propagation can take a few minutes.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
      return;
    }
    if (ips.some(isCloudflareIp)) {
      this.pendingDomain = domain;
      const kb = new InlineKeyboard().text('🔄 Re-check', 'dns:recheck').text('Use it anyway', 'dns:force');
      await ctx.reply(
        `⚠️ \`*.${domain}\` resolves to a *Cloudflare proxy* address (${ips[0]}).\n\n` +
        'Switch the record to *DNS only* (grey cloud) in Cloudflare, then tap Re-check — ' +
        'the proxy breaks TLS certificate issuance.',
        { parse_mode: 'Markdown', reply_markup: kb },
      );
      return;
    }
    const myIp = await serverPublicIp();
    if (myIp && !ips.includes(myIp)) {
      this.pendingDomain = domain;
      const kb = new InlineKeyboard().text('🔄 Re-check', 'dns:recheck').text('Use it anyway', 'dns:force');
      await ctx.reply(
        `⚠️ \`*.${domain}\` resolves to ${ips.join(', ')}, but this server's IP is \`${myIp}\`. Fix the record and tap Re-check.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
      return;
    }
    updateConfigFile({ baseDomain: domain });
    this.store.kvSet(SETUP_BACKUP_KEY, '');
    this.pendingDomain = null;
    this.expecting = null;
    await ctx.reply(`✓ \`*.${domain}\` points at this server.`, { parse_mode: 'Markdown' });
    await this.advance(ctx);
  }

  private async finalize(ctx: Context): Promise<void> {
    this.store.kvSet(READY_NOTIFY_KEY, '1');
    await ctx.reply('✓ All set! Restarting with your settings — give me ~10 seconds…');
    logger.info('onboarding complete, restarting daemon');
    setTimeout(() => process.exit(0), 1500); // restart policy brings us back in full mode
  }

  /** Delete the user's secret-bearing message. Returns whether it actually went
   *  away, so we never claim "deleted" when it's still sitting in chat history. */
  private async deleteUserMessage(ctx: Context): Promise<boolean> {
    try {
      await ctx.deleteMessage();
      return true;
    } catch {
      await ctx.reply('⚠️ I could not delete your message — please delete it yourself; it contains a secret.').catch(() => {});
      return false;
    }
  }

  /** Honest trailing note for the success message based on whether we deleted it. */
  private deletedNote(deleted: boolean): string {
    return deleted ? ' Your message with it has been deleted.' : '';
  }

  private async edit(ctx: Context, messageId: number, text: string): Promise<void> {
    await this.bot.api.editMessageText(ctx.chat!.id, messageId, text).catch(() => {});
  }

  async start(): Promise<void> {
    void this.bot.start({
      onStart: (me) => logger.info('onboarding bot started', { username: me.username }),
    });
    // Nudge the owner proactively — they may not know they should /start.
    for (const id of this.ownerIds) {
      await this.bot.api.sendMessage(
        id,
        "👋 Botsman is installed! A couple of questions and we're ready — send /start or just reply here.",
      ).catch(() => { /* user hasn't opened the chat yet — /start will do */ });
    }
  }
}
