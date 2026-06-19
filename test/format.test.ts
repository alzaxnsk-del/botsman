import { describe, it, expect } from 'vitest';
import { failureMessage, withElapsed, FAIL_DETAIL_MAX } from '../src/gateway/format.js';

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
