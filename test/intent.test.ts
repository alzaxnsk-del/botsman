import { describe, it, expect } from 'vitest';
import { detectIntent, looksLikeCreate, looksLikeDelete, findSimilarProject } from '../src/intent.js';

describe('looksLikeDelete (keeps delete out of the edit fast-path)', () => {
  it('flags delete-phrased messages (EN + RU)', () => {
    expect(looksLikeDelete('удали тамагочи ревью')).toBe(true);
    expect(looksLikeDelete('удалить проект todo')).toBe(true);
    expect(looksLikeDelete('снеси этот сервис')).toBe(true);
    expect(looksLikeDelete('delete the shop project')).toBe(true);
    expect(looksLikeDelete('remove todo')).toBe(true);
  });
  it('flags the unambiguous destroy verbs (RU + EN)', () => {
    expect(looksLikeDelete('уничтожь проект todo')).toBe(true);
    expect(looksLikeDelete('destroy the shop')).toBe(true);
  });
  it('does not flag normal edits', () => {
    expect(looksLikeDelete('add a dark theme')).toBe(false);
    expect(looksLikeDelete('убери лишний отступ сверху')).toBe(false); // "убери" ≠ delete-project
    expect(looksLikeDelete('сотри фон у кнопки')).toBe(false); // "сотри" is a content edit
  });
});

describe('findSimilarProject (near-duplicate create guard)', () => {
  it('catches the reported case: «ревью тамагочи» ~ tamagotchi-web-app', () => {
    expect(findSimilarProject('сделай ревью тамагочи, плохо работает', ['tamagotchi-web-app']))
      .toBe('tamagotchi-web-app');
  });

  it('matches transliterated / partial names', () => {
    expect(findSimilarProject('почини тамагочи', ['tamagotchi-web-app'])).toBe('tamagotchi-web-app');
    expect(findSimilarProject('add to my todo', ['todo-list'])).toBe('todo-list');
    expect(findSimilarProject('price watcher v2', ['price-watcher'])).toBe('price-watcher');
  });

  it('does not match unrelated new services', () => {
    expect(findSimilarProject('сделай магазин обуви', ['tamagotchi-web-app'])).toBeNull();
    expect(findSimilarProject('make a weather dashboard', ['todo-list', 'price-watcher'])).toBeNull();
  });

  it('ignores noise tokens (web/app/service/review)', () => {
    // "review" alone must not match a "*-review" or generic token
    expect(findSimilarProject('build a service', ['todo-list'])).toBeNull();
  });
});

describe('looksLikeCreate', () => {
  it('flags create-phrased messages (kept out of the edit fast-path)', () => {
    expect(looksLikeCreate('make me a shop')).toBe(true);
    expect(looksLikeCreate('build a snake game')).toBe(true);
    expect(looksLikeCreate('сделай магазин')).toBe(true);
    expect(looksLikeCreate('нужен лендинг')).toBe(true);
  });
  it('flags the added RU synonyms / infinitives', () => {
    expect(looksLikeCreate('разработай дашборд продаж')).toBe(true);
    expect(looksLikeCreate('создать сервис заметок')).toBe(true);
    expect(looksLikeCreate("i'd like a blog")).toBe(true);
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
