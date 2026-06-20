import { describe, it, expect } from 'vitest';
import { appendTurn, formatTranscript, recordExchange, conversationContext, clearConversation, type Turn } from '../src/gateway/convo.js';
import { Store } from '../src/db.js';

describe('conversation memory', () => {
  it('appends turns and keeps only the last 8 (rolling window)', () => {
    let turns: Turn[] = [];
    for (let i = 0; i < 12; i++) turns = appendTurn(turns, i % 2 ? 'bot' : 'user', `msg ${i}`);
    expect(turns).toHaveLength(8);
    expect(turns[0].text).toBe('msg 4'); // 0..3 dropped
    expect(turns[7].text).toBe('msg 11');
  });

  it('truncates an over-long turn (a log/file dump) with an ellipsis', () => {
    const big = 'x'.repeat(5000);
    const [t] = appendTurn([], 'bot', big);
    expect(t.text.length).toBeLessThan(1300);
    expect(t.text.endsWith('…')).toBe(true);
  });

  it('ignores empty/whitespace turns', () => {
    expect(appendTurn([], 'user', '   ')).toHaveLength(0);
  });

  it('formats oldest-first with role labels', () => {
    const turns: Turn[] = [
      { role: 'user', text: 'show the docker config' },
      { role: 'bot', text: 'FROM node:22-alpine ...' },
      { role: 'user', text: 'explain what this does' },
    ];
    const out = formatTranscript(turns);
    expect(out).toBe(
      'User: show the docker config\n' +
      'Botsman: FROM node:22-alpine ...\n' +
      'User: explain what this does',
    );
  });
});

describe('conversation memory (store-backed)', () => {
  it('records a user→bot exchange as a clean pair and renders it as context', () => {
    const store = new Store(':memory:');
    recordExchange(store, 1, 'show the docker config', 'FROM node:22-alpine');
    const ctx = conversationContext(store, 1);
    expect(ctx).toContain('User: show the docker config');
    expect(ctx).toContain('Botsman: FROM node:22-alpine');
    clearConversation(store, 1);
    expect(conversationContext(store, 1)).toBeNull();
    store.close();
  });

  it('drops turns older than the dialogue window (stale dialogue is not "current")', () => {
    const store = new Store(':memory:');
    store.kvSet('convo:2', JSON.stringify([{ role: 'user', text: 'old', ts: Date.now() - 2 * 60 * 60 * 1000 }]));
    expect(conversationContext(store, 2)).toBeNull();
    store.close();
  });
});
