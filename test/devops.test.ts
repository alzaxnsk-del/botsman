import { describe, it, expect } from 'vitest';
import {
  routeMessage, looksOperational, looksLikeQuestion, OP_META, summarize,
  runDevOpsConfirm, runMutatingOp, type ConfirmIO, type PendingDevOps, type DevOpsOp, type DevOpsDeps,
} from '../src/gateway/devops.js';
import type { StructuredLlm } from '../src/llm.js';
import { Store } from '../src/db.js';
import { RESTART_NOTICE_KEY } from '../src/types.js';

/** A StructuredLlm stub that returns the given object (after validation). */
function stubLlm(reply: unknown): StructuredLlm {
  return (async (opts) => opts.validate(reply)) as StructuredLlm;
}
const nullLlm: StructuredLlm = (async () => null) as StructuredLlm;

describe('looksOperational', () => {
  it('flags server/ops vocabulary (EN + RU)', () => {
    expect(looksOperational('restart todo')).toBe(true);
    expect(looksOperational('show the load')).toBe(true);
    expect(looksOperational('clean up disk')).toBe(true);
    expect(looksOperational('перезапусти сервис')).toBe(true);
    expect(looksOperational('обнови сервер')).toBe(true);
    expect(looksOperational('restart the proxy')).toBe(true);
  });
  it('flags the previously-missed operational verbs (must not fast-path to edit)', () => {
    // Regression: these once gated as non-operational and auto-deployed an edit.
    expect(looksOperational('stop todo')).toBe(true);
    expect(looksOperational('kill the todo container')).toBe(true);
    expect(looksOperational('pause todo')).toBe(true);
    expect(looksOperational('shut down todo')).toBe(true);
    expect(looksOperational('останови todo')).toBe(true);
  });
  it('does not flag authoring', () => {
    expect(looksOperational('add a dark theme')).toBe(false);
    expect(looksOperational('make a TODO app')).toBe(false);
    expect(looksOperational('сделай форму обратной связи')).toBe(false);
  });
});

describe('looksLikeQuestion', () => {
  it('detects questions', () => {
    expect(looksLikeQuestion('how is this built?')).toBe(true);
    expect(looksLikeQuestion('what tables exist')).toBe(true);
    expect(looksLikeQuestion('как это устроено?')).toBe(true);
    expect(looksLikeQuestion('does it use postgres')).toBe(true);
  });
  it('detects imperatively-phrased questions (regression)', () => {
    expect(looksLikeQuestion('tell me how the schema works')).toBe(true);
    expect(looksLikeQuestion('explain the auth flow')).toBe(true);
    expect(looksLikeQuestion('расскажи как устроено')).toBe(true);
  });
  it('does not flag imperatives', () => {
    expect(looksLikeQuestion('add a dark theme')).toBe(false);
    expect(looksLikeQuestion('сделай тёмную тему')).toBe(false);
  });
});

describe('routeMessage', () => {
  it('routes create', async () => {
    const r = await routeMessage(stubLlm({ kind: 'create' }), 'build me a shop', ['todo'], null);
    expect(r).toEqual({ kind: 'create', description: 'build me a shop' });
  });

  it('passes a server/admin-context hint to the model only when serverContext is set', async () => {
    let captured = '';
    const capturing: StructuredLlm = (async (opts) => {
      captured = opts.user;
      return opts.validate({ kind: 'devops', op: 'host_metrics' });
    }) as StructuredLlm;
    await routeMessage(capturing, 'show load', [], null, true);
    expect(captured).toContain('SERVER/admin context');
    captured = '';
    await routeMessage(capturing, 'show load', [], null);
    expect(captured).not.toContain('SERVER/admin context');
  });

  it('routes edit, resolving the slug from focus when unnamed', async () => {
    const r = await routeMessage(stubLlm({ kind: 'edit', slug: '' }), 'make it dark', ['todo'], 'todo');
    expect(r).toEqual({ kind: 'edit', slug: 'todo', instruction: 'make it dark' });
  });

  it('routes question', async () => {
    const r = await routeMessage(stubLlm({ kind: 'question', slug: 'todo' }), 'how does it work?', ['todo'], null);
    expect(r).toEqual({ kind: 'question', slug: 'todo', question: 'how does it work?' });
  });

  it('routes a devops op and re-derives mutating/hostLevel from the catalog', async () => {
    const r = await routeMessage(stubLlm({ kind: 'devops', op: 'restart_service', slug: 'todo' }), 'restart todo', ['todo'], null);
    expect(r).toEqual({
      kind: 'devops',
      op: { op: 'restart_service', slug: 'todo', mutating: true, hostLevel: false, humanSummary: summarize('restart_service', 'todo') },
    });
  });

  it('marks host_update host-level regardless of model output', async () => {
    const r = await routeMessage(stubLlm({ kind: 'devops', op: 'host_update' }), 'apt upgrade', [], null);
    expect(r.kind).toBe('devops');
    if (r.kind === 'devops') {
      expect(r.op.mutating).toBe(true);
      expect(r.op.hostLevel).toBe(true);
    }
  });

  it('carries low confidence so the gateway can confirm an uncertain edit', async () => {
    const r = await routeMessage(stubLlm({ kind: 'edit', slug: 'todo', confidence: 'low' }), 'review it', ['todo'], null);
    expect(r).toEqual({ kind: 'edit', slug: 'todo', instruction: 'review it', confidence: 'low' });
  });

  it('suppresses the confirm when the user is CONNECTED to that project', async () => {
    const r = await routeMessage(stubLlm({ kind: 'edit', slug: 'todo', confidence: 'low' }), 'review it', ['todo'], 'todo');
    expect(r.kind).toBe('edit');
    if (r.kind === 'edit') expect(r.confidence).toBeUndefined(); // connected = trust it
  });

  it('flags a low-confidence create for confirmation', async () => {
    const r = await routeMessage(stubLlm({ kind: 'create', confidence: 'low' }), 'tamagotchi review', ['tamagotchi-web-app'], null);
    expect(r).toEqual({ kind: 'create', description: 'tamagotchi review', confidence: 'low' });
  });

  it('routes a natural-language delete (confirmation handled by the gateway)', async () => {
    const r = await routeMessage(stubLlm({ kind: 'delete', slug: 'tamagochi-review' }), 'удали тамагочи ревью', ['tamagochi-review'], null);
    expect(r).toEqual({ kind: 'delete', slug: 'tamagochi-review' });
  });

  it('returns none for an unknown op or kind', async () => {
    expect((await routeMessage(stubLlm({ kind: 'devops', op: 'rm_rf' }), 'x', [], null)).kind).toBe('none');
    expect((await routeMessage(stubLlm({ kind: 'whatever' }), 'x', [], null)).kind).toBe('none');
  });

  it('returns none for edit/question with no resolvable slug', async () => {
    expect((await routeMessage(stubLlm({ kind: 'edit', slug: 'ghost' }), 'x', ['todo'], null)).kind).toBe('none');
  });

  it('returns none when the LLM fails (caller falls back)', async () => {
    expect((await routeMessage(nullLlm, 'restart todo', ['todo'], null)).kind).toBe('none');
  });

  it('every op id has catalog metadata and a summary', () => {
    for (const id of Object.keys(OP_META)) expect(summarize(id as never)).toBeTruthy();
  });
});

describe('runDevOpsConfirm (host-op double-confirm state machine)', () => {
  function hostOp(): DevOpsOp {
    return { op: 'host_update', humanSummary: 'Update the host', mutating: true, hostLevel: true };
  }
  function nonHostOp(): DevOpsOp {
    return { op: 'restart_service', slug: 'todo', humanSummary: 'Restart todo', mutating: true, hostLevel: false };
  }
  function fakeIO(renderResult = true) {
    const calls = { answers: [] as (string | undefined)[], executed: 0, warned: 0, cleared: 0, results: [] as string[] };
    const io: ConfirmIO = {
      answer: async (t) => { calls.answers.push(t); },
      renderWarning: async () => { calls.warned++; return renderResult; },
      showRunning: async () => {},
      execute: async () => { calls.executed++; return 'done'; },
      showResult: async (t) => { calls.results.push(t); },
      clearPending: () => { calls.cleared++; },
    };
    return { io, calls };
  }

  it('(a) exec2 on a fresh host op must NOT execute (crafted/replayed exec2)', async () => {
    const entry: PendingDevOps = { op: hostOp(), confirmed: false };
    const { io, calls } = fakeIO();
    await runDevOpsConfirm(entry, 'devops:exec2', io);
    expect(calls.executed).toBe(0);
    expect(calls.warned).toBe(0);
    expect(entry.confirmed).toBe(false);
    expect(calls.answers).toContain('Tap Execute first.');
  });

  it('(b) normal two-step host flow executes exactly once', async () => {
    const entry: PendingDevOps = { op: hostOp(), confirmed: false };
    const { io, calls } = fakeIO(true);
    await runDevOpsConfirm(entry, 'devops:exec', io);   // first tap → warning
    expect(calls.warned).toBe(1);
    expect(calls.executed).toBe(0);
    expect(entry.confirmed).toBe(true);
    await runDevOpsConfirm(entry, 'devops:exec2', io);  // second tap → run
    expect(calls.executed).toBe(1);
    expect(calls.cleared).toBe(1);
  });

  it('(c) a failed first-confirm edit does NOT collapse the double-confirm', async () => {
    const entry: PendingDevOps = { op: hostOp(), confirmed: false };
    const fail = fakeIO(false); // renderWarning returns false (edit failed)
    await runDevOpsConfirm(entry, 'devops:exec', fail.io);
    expect(entry.confirmed).toBe(false);            // not marked confirmed
    expect(fail.calls.executed).toBe(0);
    expect(fail.calls.answers).toContain('Please tap Execute again to confirm.');
    // A re-tap of the still-visible Execute re-attempts the warning, never executes.
    const ok = fakeIO(true);
    await runDevOpsConfirm(entry, 'devops:exec', ok.io);
    expect(entry.confirmed).toBe(true);
    expect(ok.calls.executed).toBe(0);              // still not executed without exec2
  });

  it('non-host mutating op keeps single-confirm (executes on first exec)', async () => {
    const entry: PendingDevOps = { op: nonHostOp(), confirmed: false };
    const { io, calls } = fakeIO();
    await runDevOpsConfirm(entry, 'devops:exec', io);
    expect(calls.warned).toBe(0);
    expect(calls.executed).toBe(1);
  });
});

type UpdResult = { ok: boolean; output: string; timedOut: boolean; exitCode: number };
function depsWithSelfUpdate(selfUpdate: () => Promise<UpdResult>): { store: Store; deps: DevOpsDeps } {
  const store = new Store(':memory:');
  const deps = {
    store,
    docker: {}, deployEngine: {}, orchestrator: {},
    hostExec: { selfUpdate },
    hostRepoDir: '/opt/botsman',
  } as unknown as DevOpsDeps;
  return { store, deps };
}

describe('runMutatingOp self_update (messaging + back-online notice)', () => {
  const op = { op: 'self_update', mutating: true, hostLevel: true, humanSummary: '' } as DevOpsOp;

  it('says "already up to date" and clears the notice when nothing is new (BOTSMAN_NOOP)', async () => {
    const { store, deps } = depsWithSelfUpdate(async () => ({ ok: true, output: 'BOTSMAN_NOOP', timedOut: false, exitCode: 0 }));
    const msg = await runMutatingOp(op, deps);
    expect(msg).toContain('up to date');
    expect(store.kvGet(RESTART_NOTICE_KEY)).toBe(''); // no restart promised
  });

  it('promises a restart and keeps the back-online notice on a real update', async () => {
    const { store, deps } = depsWithSelfUpdate(async () => ({ ok: true, output: 'built', timedOut: false, exitCode: 0 }));
    const msg = await runMutatingOp(op, deps);
    expect(msg).toContain('recreating');
    expect(store.kvGet(RESTART_NOTICE_KEY)).toContain('back online');
  });

  it('surfaces a build/git failure and clears the notice', async () => {
    const { store, deps } = depsWithSelfUpdate(async () => ({ ok: false, output: 'docker build: boom', timedOut: false, exitCode: 1 }));
    const msg = await runMutatingOp(op, deps);
    expect(msg).toContain('failed');
    expect(store.kvGet(RESTART_NOTICE_KEY)).toBe('');
  });

  it('distinguishes a timeout from a failure', async () => {
    const { store, deps } = depsWithSelfUpdate(async () => ({ ok: false, output: '', timedOut: true, exitCode: -1 }));
    const msg = await runMutatingOp(op, deps);
    expect(msg).toContain('timed out');
    expect(store.kvGet(RESTART_NOTICE_KEY)).toBe('');
  });
});
