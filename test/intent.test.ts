import { describe, it, expect } from 'vitest';
import { detectIntent, looksLikeCreate } from '../src/intent.js';

describe('looksLikeCreate', () => {
  it('flags create-phrased messages (kept out of the edit fast-path)', () => {
    expect(looksLikeCreate('make me a shop')).toBe(true);
    expect(looksLikeCreate('build a snake game')).toBe(true);
    expect(looksLikeCreate('сделай магазин')).toBe(true);
    expect(looksLikeCreate('нужен лендинг')).toBe(true);
  });
  it('does not flag plain edits', () => {
    expect(looksLikeCreate('add a dark theme')).toBe(false);
    expect(looksLikeCreate('добавь кнопку')).toBe(false);
  });
});

describe('detectIntent', () => {
  it('treats slug mention as edit', () => {
    const i = detectIntent('добавь тёмную тему в price-watcher', ['price-watcher', 'todo'], null);
    expect(i).toEqual({ kind: 'edit', slug: 'price-watcher', instruction: 'добавь тёмную тему в price-watcher' });
  });

  it('prefers the longest matching slug', () => {
    const i = detectIntent('поправь todo-list', ['todo', 'todo-list'], null);
    expect(i.kind).toBe('edit');
    expect((i as { slug: string }).slug).toBe('todo-list');
  });

  it('does not match slug as substring of another word', () => {
    const i = detectIntent('сделай сервис для todoshka обработки', ['todo'], null);
    expect(i.kind).not.toBe('edit');
  });

  it('creates when no projects exist', () => {
    const i = detectIntent('что-нибудь непонятное', [], null);
    expect(i.kind).toBe('create');
  });

  it('creates on explicit creation phrasing even with last-project context', () => {
    expect(detectIntent('сделай сервис для заметок', ['todo'], 'todo').kind).toBe('create');
    expect(detectIntent('make a new app for notes', ['todo'], 'todo').kind).toBe('create');
    expect(detectIntent('новый сервис: каталог книг', ['todo'], 'todo').kind).toBe('create');
  });

  it('spec §1 dialogue: follow-up after a deploy edits the last project without asking', () => {
    const i = detectIntent('сделай тёмную тему и добавь страницу со списком товаров', ['price-watcher'], 'price-watcher');
    expect(i).toEqual({
      kind: 'edit',
      slug: 'price-watcher',
      instruction: 'сделай тёмную тему и добавь страницу со списком товаров',
    });
  });

  it('asks only when projects exist but there is no context', () => {
    expect(detectIntent('добавь тёмную тему', ['todo'], null)).toEqual({ kind: 'ambiguous', lastSlug: null });
  });

  it('ignores last-active pointing to a deleted project', () => {
    expect(detectIntent('поправь шапку', ['todo'], 'gone')).toEqual({ kind: 'ambiguous', lastSlug: null });
  });
});
