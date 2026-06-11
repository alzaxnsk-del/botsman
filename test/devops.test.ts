import { describe, it, expect } from 'vitest';
import {
  routeMessage, looksOperational, looksLikeQuestion, OP_META, summarize,
  runDevOpsConfirm, type ConfirmIO, type PendingDevOps, type DevOpsOp,
} from '../src/gateway/devops.js';
import type { StructuredLlm } from '../src/llm.js';

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
