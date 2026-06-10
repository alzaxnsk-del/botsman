import { describe, it, expect } from 'vitest';
import { CaddyClient } from '../src/deploy/caddy.js';
import { parseClaudeJson } from '../src/agent/ClaudeCodeAgent.js';
import { demuxDockerLogs } from '../src/deploy/engine.js';
import { dbNamesForSlug, dbEnvFor, generatePassword } from '../src/deploy/postgres.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

describe('CaddyClient.buildRoute', () => {
  it('builds a terminal reverse_proxy route with @id', () => {
    const c = new CaddyClient('http://localhost:2019');
    const route = c.buildRoute('todo', 'todo.apps.example.com', 'botsman-app-todo-abc:3000') as {
      '@id': string;
      match: Array<{ host: string[] }>;
      handle: Array<{ handler: string; upstreams: Array<{ dial: string }> }>;
      terminal: boolean;
    };
    expect(route['@id']).toBe('botsman-todo');
    expect(route.match[0].host).toEqual(['todo.apps.example.com']);
    expect(route.handle[0].handler).toBe('reverse_proxy');
    expect(route.handle[0].upstreams[0].dial).toBe('botsman-app-todo-abc:3000');
    expect(route.terminal).toBe(true);
  });
});

describe('parseClaudeJson', () => {
  it('parses a clean result object', () => {
    const r = parseClaudeJson('{"type":"result","subtype":"success","is_error":false,"result":"done"}');
    expect(r?.result).toBe('done');
    expect(r?.is_error).toBe(false);
  });

  it('tolerates noise around the JSON', () => {
    const r = parseClaudeJson('warning: something\n{"type":"result","result":"ok"}\n');
    expect(r?.result).toBe('ok');
  });

  it('passes through total_cost_usd for user-facing spend reporting', () => {
    const r = parseClaudeJson('{"type":"result","result":"ok","total_cost_usd":0.42}');
    expect(r?.total_cost_usd).toBe(0.42);
  });

  it('returns null for garbage', () => {
    expect(parseClaudeJson('')).toBeNull();
    expect(parseClaudeJson('not json at all')).toBeNull();
  });
});

describe('demuxDockerLogs', () => {
  it('strips 8-byte multiplex headers', () => {
    const payload = Buffer.from('hello\n');
    const frame = Buffer.concat([
      Buffer.from([1, 0, 0, 0, 0, 0, 0, payload.length]),
      payload,
    ]);
    expect(demuxDockerLogs(frame)).toBe('hello\n');
  });

  it('passes through plain text (tty containers)', () => {
    expect(demuxDockerLogs(Buffer.from('plain text'))).toBe('plain text');
  });
});

describe('postgres helpers', () => {
  it('derives safe db identifiers from slug', () => {
    expect(dbNamesForSlug('price-watcher')).toEqual({ dbName: 'app_price_watcher', dbUser: 'u_price_watcher' });
  });

  it('builds DATABASE_URL env', () => {
    const env = dbEnvFor({ dbName: 'app_x', dbUser: 'u_x', dbPassword: 'pw' });
    expect(env.DATABASE_URL).toBe('postgres://u_x:pw@botsman-postgres:5432/app_x');
    expect(env.PGDATABASE).toBe('app_x');
  });

  it('generates distinct passwords', () => {
    expect(generatePassword()).not.toBe(generatePassword());
    expect(generatePassword().length).toBeGreaterThanOrEqual(20);
  });
});

describe('system prompt (EPIC D contract)', () => {
  it('pins the deploy contract', () => {
    const p = buildSystemPrompt({ mode: 'create', port: 3000, dbEnv: { DATABASE_URL: 'x', PGHOST: 'y' } });
    expect(p).toContain('process.env.PORT');
    expect(p).toContain('Dockerfile');
    expect(p).toContain('NO hardcoded secrets');
    expect(p).toContain('MODE: CREATE');
    expect(p).toContain('DATABASE_URL');
  });

  it('switches to edit mode', () => {
    const p = buildSystemPrompt({ mode: 'edit', port: 3000, dbEnv: {} });
    expect(p).toContain('MODE: EDIT');
    expect(p).toContain('minimal diff');
  });
});
