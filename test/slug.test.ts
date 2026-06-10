import { describe, it, expect } from 'vitest';
import { slugFromDescription, uniqueSlug, isValidSlug, transliterate } from '../src/slug.js';

describe('slugFromDescription', () => {
  it('builds kebab-case from russian description', () => {
    const slug = slugFromDescription(
      'Сделай сервис: форма, куда вставляешь ссылку на товар, раз в час проверяет цену',
    );
    expect(isValidSlug(slug)).toBe(true);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('builds slug from english description', () => {
    const slug = slugFromDescription('make a TODO service with task list');
    expect(slug).toBe('todo-task-list');
  });

  it('drops stop words', () => {
    expect(slugFromDescription('сделай сервис погода')).toBe('pogoda');
  });

  it('falls back to "service" for empty input', () => {
    expect(slugFromDescription('сделай')).toBe('service');
    expect(slugFromDescription('!!!')).toBe('service');
  });

  it('never exceeds 40 chars', () => {
    const slug = slugFromDescription('very '.repeat(30) + 'longwordhere and more words here');
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe('transliterate', () => {
  it('handles russian letters', () => {
    expect(transliterate('Привет')).toBe('privet');
    expect(transliterate('щука')).toBe('schuka');
  });
});

describe('uniqueSlug', () => {
  it('returns base when free', () => {
    expect(uniqueSlug('todo', () => false)).toBe('todo');
  });

  it('suffixes -2, -3 on collision', () => {
    const taken = new Set(['todo', 'todo-2']);
    expect(uniqueSlug('todo', (s) => taken.has(s))).toBe('todo-3');
  });
});

describe('isValidSlug', () => {
  it('accepts kebab-case', () => {
    expect(isValidSlug('price-watcher')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
  });
  it('rejects invalid', () => {
    expect(isValidSlug('-bad')).toBe(false);
    expect(isValidSlug('Bad')).toBe(false);
    expect(isValidSlug('a b')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });
});
