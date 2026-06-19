import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramGateway } from '../src/gateway/telegram.js';
import { Store } from '../src/db.js';
import { getFocus, setServerRoom, inServerRoom } from '../src/gateway/rooms.js';
import type { ProjectMeta } from '../src/types.js';

/**
 * First gateway-level tests. There's no real Telegram here: we build the gateway
 * with stub deps + a real in-memory Store, swap its bot.api for a recorder, and
 * drive the (private) methods with a fake Context that captures replies.
 */

interface Reply { text: string; replyMarkup?: unknown }

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.BOTSMAN_HOME;
});

function sampleProject(slug: string): Omit<ProjectMeta, 'createdAt' | 'updatedAt'> {
  return {
    slug, name: slug, description: 'x', status: 'live',
    domain: `${slug}.apps.test`, internalPort: 3000,
    currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
    dbName: `app_${slug}`, dbUser: `u_${slug}`, dbPassword: 'pw',
  };
}

type Enqueue = (kind: string, instruction: string, report: (s: string, d?: string) => void, slug?: string) => Promise<unknown>;

function harness(opts: { enqueue?: Enqueue } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-gw-'));
  process.env.BOTSMAN_HOME = home;
  const store = new Store(':memory:');

  const orchestrator = {
    queueLength: 0,
    enqueue: opts.enqueue ?? (async () => ({ ok: true, slug: 'x' })),
    askProject: async () => ({ ok: true, answer: 'ok' }),
  };
  const deployEngine = { containerRunning: async () => true };
  const telemetry = { onActivity: async () => {}, onInstall: async () => {}, onFirstDeploy: async () => {} };

  const g = new TelegramGateway(
    '123456:fake-token', [1],
    orchestrator as never, store, deployEngine as never, telemetry as never,
    {} as never, {} as never, '/opt/botsman',
  );

  // Swap the real bot.api for a recorder so nothing hits the network.
  let nextId = 1000;
  const api = {
    sendMessage: async (_id: number, text: string, o?: { reply_markup?: unknown }) => {
      api.sent.push({ text, replyMarkup: o?.reply_markup });
      return { message_id: nextId++ };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    sent: [] as Reply[],
  };
  (g as unknown as { bot: { api: unknown } }).bot.api = api;

  cleanups.push(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { g: g as unknown as GatewayInternals, store, api };
}

// The private surface we exercise.
interface GatewayInternals {
  createOrAsk(ctx: unknown, description: string, slugs: string[], thinkingId: number | null): Promise<void>;
  applyIntentChoice(ctx: unknown, chatId: number, data: string, fromMessageId: number | undefined): Promise<void>;
  runTask(kind: string, slug: string | undefined, instruction: string, ctx: unknown): Promise<void>;
  handleMessage(ctx: unknown, text: string): Promise<void>;
  dispatchRoute(ctx: unknown, route: unknown, text: string, focused: string | null, thinkingId: number): Promise<void>;
  fallbackNoLlm(ctx: unknown, text: string, focused: string | null, inServer: boolean): Promise<void>;
  pendingAmbiguous: Map<number, { messageId: number; text: string }>;
}

function makeCtx(chatId: number, replies: Reply[], cb?: { data?: string; messageId?: number }) {
  let nextId = 500;
  return {
    chat: { id: chatId },
    from: { id: 1 },
    reply: async (text: string, o?: { reply_markup?: unknown }) => {
      replies.push({ text, replyMarkup: o?.reply_markup });
      return { message_id: nextId++ };
    },
    answerCallbackQuery: async () => {},
    replyWithPhoto: async () => {},
    callbackQuery: cb?.data ? { data: cb.data, message: { message_id: cb.messageId } } : undefined,
  } as unknown;
}

function callbackData(markup: unknown): string[] {
  const rows = (markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> }).inline_keyboard ?? [];
  return rows.flat().map((b) => b.callback_data ?? '');
}

describe('createOrAsk', () => {
  it('builds immediately when there are no projects (no confirm)', async () => {
    const { g } = harness();
    const calls: unknown[][] = [];
    g.runTask = async (...args: unknown[]) => { calls.push(args); };
    const replies: Reply[] = [];

    await g.createOrAsk(makeCtx(1, replies), 'make a calc', [], null);

    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(['create', undefined, 'make a calc']);
    expect(replies).toHaveLength(0); // no confirm message
  });

  it('confirms with a New + per-project Edit keyboard once projects exist', async () => {
    const { g } = harness();
    let ran = 0;
    g.runTask = async () => { ran++; };
    const replies: Reply[] = [];

    await g.createOrAsk(makeCtx(1, replies), 'make a calc', ['todo'], null);

    expect(ran).toBe(0); // did NOT build
    expect(replies).toHaveLength(1);
    expect(callbackData(replies[0].replyMarkup)).toEqual(['intent:new', 'intent:edit:todo']);
    expect(g.pendingAmbiguous.get(1)).toEqual({ messageId: expect.any(Number), text: 'make a calc' });
  });
});

describe('applyIntentChoice (stale-guard)', () => {
  it('rejects a tap whose message no longer matches the pending question', async () => {
    const { g } = harness();
    let ran = 0;
    g.runTask = async () => { ran++; };
    g.pendingAmbiguous.set(1, { messageId: 10, text: 'make a calc' });
    const replies: Reply[] = [];

    await g.applyIntentChoice(makeCtx(1, replies, { data: 'intent:new', messageId: 11 }), 1, 'intent:new', 11);

    expect(ran).toBe(0);
    expect(replies[0].text).toContain('stale');
    expect(g.pendingAmbiguous.has(1)).toBe(true); // untouched
  });

  it('runs a create on 🆕 New project and clears the pending entry', async () => {
    const { g } = harness();
    const calls: unknown[][] = [];
    g.runTask = async (...args: unknown[]) => { calls.push(args); };
    g.pendingAmbiguous.set(1, { messageId: 10, text: 'make a calc' });

    await g.applyIntentChoice(makeCtx(1, []), 1, 'intent:new', 10);

    expect(calls[0].slice(0, 3)).toEqual(['create', undefined, 'make a calc']);
    expect(g.pendingAmbiguous.has(1)).toBe(false);
  });

  it('runs an edit of the chosen project on ✏️ <slug>', async () => {
    const { g } = harness();
    const calls: unknown[][] = [];
    g.runTask = async (...args: unknown[]) => { calls.push(args); };
    g.pendingAmbiguous.set(1, { messageId: 10, text: 'add dark mode' });

    await g.applyIntentChoice(makeCtx(1, []), 1, 'intent:edit:todo', 10);

    expect(calls[0].slice(0, 3)).toEqual(['edit', 'todo', 'add dark mode']);
  });
});

describe('auto-connect after a build', () => {
  it('connects to the new project and leaves the server room (focus/server are exclusive)', async () => {
    const { g, store } = harness({
      enqueue: async (_k, _i, report) => { report('accepted', 'foo'); return { ok: true, slug: 'foo', url: 'https://foo.apps.test/' }; },
    });
    store.createProject(sampleProject('foo'));
    setServerRoom(store, 1); // simulate building from inside the Server room

    await g.runTask('create', undefined, 'make foo', makeCtx(1, []));

    expect(getFocus(store, 1)).toBe('foo');
    expect(inServerRoom(store, 1)).toBe(false);
  });

  it('does not connect when the build fails', async () => {
    const { g, store } = harness({
      enqueue: async () => ({ ok: false, slug: 'foo', error: 'boom' }),
    });
    store.createProject(sampleProject('foo'));

    await g.runTask('create', undefined, 'make foo', makeCtx(1, []));

    expect(getFocus(store, 1)).toBeNull();
  });
});

describe('all create entry points funnel through createOrAsk', () => {
  it('handleMessage fast-path → createOrAsk once', async () => {
    const { g, store } = harness();
    store.createProject(sampleProject('todo'));
    const calls: unknown[][] = [];
    g.createOrAsk = async (...args: unknown[]) => { calls.push(args); };

    await g.handleMessage(makeCtx(1, []), 'сделай сервис заметок');

    expect(calls).toHaveLength(1);
  });

  it("dispatchRoute case 'create' → createOrAsk once", async () => {
    const { g, store } = harness();
    store.createProject(sampleProject('todo'));
    const calls: unknown[][] = [];
    g.createOrAsk = async (...args: unknown[]) => { calls.push(args); };

    await g.dispatchRoute(makeCtx(1, []), { kind: 'create', description: 'сделай магазин' }, 'сделай магазин', null, 99);

    expect(calls).toHaveLength(1);
  });

  it('fallbackNoLlm (no LLM) → createOrAsk once', async () => {
    const { g, store } = harness();
    store.createProject(sampleProject('todo'));
    const calls: unknown[][] = [];
    g.createOrAsk = async (...args: unknown[]) => { calls.push(args); };

    await g.fallbackNoLlm(makeCtx(1, []), 'сделай сервис заметок', null, false);

    expect(calls).toHaveLength(1);
  });
});
