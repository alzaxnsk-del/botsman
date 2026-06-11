import { describe, it, expect } from 'vitest';
import { routeDevOps, routeProjectMessage, OP_META, summarize } from '../src/gateway/devops.js';
import type { StructuredLlm } from '../src/llm.js';

/** A StructuredLlm stub that always returns the given object (after validation). */
function stubLlm(reply: unknown): StructuredLlm {
  return (async (opts) => opts.validate(reply)) as StructuredLlm;
}
const nullLlm: StructuredLlm = (async () => null) as StructuredLlm;

describe('routeDevOps', () => {
  it('maps a valid op and re-derives mutating/hostLevel from the catalog', async () => {
    const op = await routeDevOps(stubLlm({ op: 'restart_service', slug: 'todo' }), 'restart todo', ['todo']);
    expect(op).toEqual({
      op: 'restart_service', slug: 'todo', mutating: true, hostLevel: false,
      humanSummary: summarize('restart_service', 'todo'),
    });
  });

  it('marks host_update as a host-level mutation regardless of model output', async () => {
    const op = await routeDevOps(stubLlm({ op: 'host_update', slug: 'ignored' }), 'apt upgrade', []);
    expect(op?.mutating).toBe(true);
    expect(op?.hostLevel).toBe(true);
    expect(op?.slug).toBeUndefined(); // host_update needs no slug
  });

  it('drops a slug that is not a real project', async () => {
    const op = await routeDevOps(stubLlm({ op: 'service_logs', slug: 'ghost' }), 'logs', ['todo']);
    expect(op?.slug).toBeUndefined();
  });

  it('returns null for an unknown / "none" op (caller shows the menu)', async () => {
    expect(await routeDevOps(stubLlm({ op: 'none' }), 'hi', [])).toBeNull();
    expect(await routeDevOps(stubLlm({ op: 'rm_rf_slash' }), 'delete everything', [])).toBeNull();
  });

  it('returns null when the LLM fails', async () => {
    expect(await routeDevOps(nullLlm, 'restart todo', ['todo'])).toBeNull();
  });

  it('every op id has catalog metadata', () => {
    for (const id of Object.keys(OP_META)) {
      expect(summarize(id as never)).toBeTruthy();
    }
  });
});

describe('routeProjectMessage', () => {
  it('routes a question', async () => {
    const r = await routeProjectMessage(stubLlm({ kind: 'question' }), 'how does auth work?');
    expect(r).toEqual({ kind: 'question', question: 'how does auth work?' });
  });

  it('routes an edit', async () => {
    const r = await routeProjectMessage(stubLlm({ kind: 'edit' }), 'add a dark theme');
    expect(r).toEqual({ kind: 'edit', instruction: 'add a dark theme' });
  });

  it('falls back to edit on LLM failure (preserves the core flow)', async () => {
    const r = await routeProjectMessage(nullLlm, 'add a dark theme');
    expect(r).toEqual({ kind: 'edit', instruction: 'add a dark theme' });
  });

  it('falls back to edit when no LLM is configured', async () => {
    const r = await routeProjectMessage(undefined, 'whatever');
    expect(r.kind).toBe('edit');
  });
});
