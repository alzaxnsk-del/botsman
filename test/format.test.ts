import { describe, it, expect } from 'vitest';
import { failureMessage, withElapsed, FAIL_DETAIL_MAX, detectLang, formatDeployCheck, type DeployCheckFacts } from '../src/gateway/format.js';

describe('failureMessage', () => {
  it('leads with a plain-language line, names the slug, and points at recovery', () => {
    const m = failureMessage({ slug: 'todo', error: 'boom' });
    expect(m).toContain("Couldn't finish todo.");
    expect(m).toContain('boom');
    expect(m).toContain('🔁 Retry');
    expect(m).not.toContain('```'); // plain text, never Markdown
  });

  it('keeps the TAIL of a long error (the real failure is usually at the end) and bounds length', () => {
    const long = 'head-noise '.repeat(500) + 'REAL_ERROR_AT_END';
    const m = failureMessage({ slug: 'shop', error: long });
    expect(m).toContain('REAL_ERROR_AT_END');
    expect(m).toContain('…'); // truncation marker
    expect(m.length).toBeLessThan(FAIL_DETAIL_MAX + 200);
  });

  it('falls back gracefully with no slug / no error', () => {
    const m = failureMessage({});
    expect(m).toContain("Couldn't finish.");
    expect(m).toContain('unknown error');
  });
});

describe('withElapsed', () => {
  it('adds nothing under a minute (no noise)', () => {
    expect(withElapsed('🤖 Generating code', 1000, 1000 + 59_000)).toBe('🤖 Generating code');
  });

  it('appends whole minutes once past a minute', () => {
    expect(withElapsed('🔨 Building the image', 0, 125_000)).toBe('🔨 Building the image · 2m');
  });
});

describe('detectLang', () => {
  it('detects Russian by Cyrillic majority', () => {
    expect(detectLang('Тёмный лендинг с формой waitlist на Postgres')).toBe('ru');
  });
  it('detects English (and defaults to it when empty/ambiguous)', () => {
    expect(detectLang('A dark terminal landing page with a waitlist form')).toBe('en');
    expect(detectLang('')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
    expect(detectLang('https://snip.example.dev')).toBe('en'); // no letters of either → en
  });
});

describe('formatDeployCheck', () => {
  const base: DeployCheckFacts = {
    slug: 'botsman-landing',
    url: 'https://botsman-landing.botsman.dev/',
    cloneCmd: 'root@1.2.3.4:/root/.botsman/repos/botsman-landing.git',
    summary: 'Тёмный «терминальный» лендинг: hero с демо-чатом, блок фич и форма waitlist.',
    costUsd: 0.94,
    elapsedMs: 192_000,
    hasScreenshot: true,
  };

  it('renders a value-first localized check (RU)', () => {
    const m = formatDeployCheck(base, 'ru');
    expect(m).toContain('✅ *botsman-landing* — задеплоен');
    expect(m).toContain('🔗 https://botsman-landing.botsman.dev/');
    expect(m).toContain('Что это:');
    expect(m).toContain('Чек деплоя');
    expect(m).toContain('git clone root@1.2.3.4:/root/.botsman/repos/botsman-landing.git');
    expect(m).toContain('node:22-alpine, non-root');
    expect(m).toContain('GET / = 200');
    expect(m).toContain('Postgres');
    expect(m).toContain('≈$0.94');
    expect(m).toContain('~3 мин'); // 192s → ~3 min
    expect(m).toContain('Что поменять?');
    expect(m).toContain('HTTPS');
    expect(m).toContain('выдан автоматически');
  });

  it('renders the English variant', () => {
    const m = formatDeployCheck({ ...base, summary: 'A dark landing page.' }, 'en');
    expect(m).toContain('— deployed');
    expect(m).toContain('Deploy check');
    expect(m).toContain('Repository created');
    expect(m).toContain('issued automatically');
    expect(m).toContain('What should I change?');
  });

  it('shows HTTPS as pending and surfaces the warning when the public URL is not answering', () => {
    const m = formatDeployCheck({ ...base, publicWarning: 'cert still issuing' }, 'en');
    expect(m).toContain('issuing — not answering yet');
    expect(m).toContain('⚠️ cert still issuing');
    expect(m).not.toContain('issued automatically');
  });

  it('omits optional rows cleanly (no clone cmd, no cost, sub-minute build, no screenshot)', () => {
    const m = formatDeployCheck({ slug: 'x', url: 'https://x.test/', elapsedMs: 40_000 }, 'en');
    expect(m).not.toContain('Repository created'); // no clone cmd → repo row omitted
    expect(m).not.toContain('💸');
    expect(m).not.toContain('⏱'); // under a minute → no time row
    expect(m).not.toContain('Screenshot below');
    expect(m).toContain('Deploy check'); // the constant rows still render
  });
});
