import { describe, it, expect } from 'vitest';
import {
  routeMessage, looksOperational, looksLikeQuestion, OP_META, summarize,
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
