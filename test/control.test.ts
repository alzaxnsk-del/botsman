import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type http from 'node:http';
import { startControlServer } from '../src/control.js';
import type { Orchestrator } from '../src/orchestrator.js';

const PORT = 18366;
const TOKEN = 'test-secret-token';
const enqueued: string[] = [];

const orchestrator = {
  enqueue: async (_kind: string, _instr: string, _report: unknown, slug?: string) => {
    enqueued.push(slug ?? '?');
    return { ok: true, slug: slug ?? '?' };
  },
  queueLength: 0,
} as unknown as Orchestrator;

let server: http.Server;

beforeAll(() => {
  server = startControlServer(orchestrator, TOKEN, () => {}, PORT);
});
afterAll(() => {
  server.close();
});

describe('control API (push-to-deploy, §5 token auth)', () => {
  it('health is open', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects push without token (deployed services must not trigger deploys)', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/hooks/push/todo`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects push with wrong token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/hooks/push/todo`, {
      method: 'POST',
      headers: { 'X-Botsman-Token': 'wrong' },
    });
    expect(res.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it('accepts push with the correct token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/hooks/push/todo`, {
      method: 'POST',
      headers: { 'X-Botsman-Token': TOKEN },
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(enqueued).toEqual(['todo']);
  });

  it('404s unknown paths and invalid slugs', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/hooks/push/BAD_SLUG!`, { method: 'POST', headers: { 'X-Botsman-Token': TOKEN } })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${PORT}/nope`)).status).toBe(404);
  });
});
