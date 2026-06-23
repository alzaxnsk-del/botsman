import { describe, it, expect } from 'vitest';
import { resolveProjectDomain, baseOf } from '../src/domain.js';

const BASE = 'botsman.dev';
const CURRENT = 'botsman-landing.botsman.dev';
const noneTaken = (): string | null => null;

describe('baseOf', () => {
  it('drops the first DNS label', () => {
    expect(baseOf('botsman-landing.botsman.dev')).toBe('botsman.dev');
    expect(baseOf('todo.apps.example.com')).toBe('apps.example.com');
  });
  it('returns the input when there is no dot', () => {
    expect(baseOf('localhost')).toBe('localhost');
  });
});

describe('resolveProjectDomain', () => {
  it('accepts a bare label and forms <label>.<base> (the reported case)', () => {
    expect(resolveProjectDomain('landing', BASE, CURRENT, noneTaken)).toEqual({
      ok: true, host: 'landing.botsman.dev',
    });
  });

  it('accepts a full host under the base', () => {
    expect(resolveProjectDomain('landing.botsman.dev', BASE, CURRENT, noneTaken)).toEqual({
      ok: true, host: 'landing.botsman.dev',
    });
  });

  it('strips scheme, trailing slash/path and trailing dots, and lowercases', () => {
    expect(resolveProjectDomain('HTTPS://Landing.Botsman.Dev/foo', BASE, CURRENT, noneTaken)).toEqual({
      ok: true, host: 'landing.botsman.dev',
    });
    expect(resolveProjectDomain('landing.', BASE, CURRENT, noneTaken)).toEqual({
      ok: true, host: 'landing.botsman.dev',
    });
  });

  it('rejects an external domain not under the base', () => {
    const r = resolveProjectDomain('example.com', BASE, CURRENT, noneTaken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/subdomain of `botsman.dev`/);
  });

  it('rejects a multi-level subdomain (wildcard covers one level only)', () => {
    const r = resolveProjectDomain('app.landing.botsman.dev', BASE, CURRENT, noneTaken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one level/);
  });

  it('rejects an invalid label', () => {
    expect(resolveProjectDomain('-bad', BASE, CURRENT, noneTaken).ok).toBe(false);
    expect(resolveProjectDomain('bad-', BASE, CURRENT, noneTaken).ok).toBe(false);
    expect(resolveProjectDomain('inv@lid', BASE, CURRENT, noneTaken).ok).toBe(false);
  });

  it('rejects the base domain itself', () => {
    const r = resolveProjectDomain('botsman.dev', BASE, CURRENT, noneTaken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/base domain itself/);
  });

  it('rejects the no-op (already its current address)', () => {
    const r = resolveProjectDomain('botsman-landing', BASE, CURRENT, noneTaken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already its address/);
  });

  it('rejects a host already used by another project', () => {
    const r = resolveProjectDomain('landing', BASE, CURRENT, (h) => (h === 'landing.botsman.dev' ? 'other-proj' : null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already used by the project `other-proj`/);
  });

  it('works for a multi-level base like apps.example.com', () => {
    expect(resolveProjectDomain('shop', 'apps.example.com', 'todo.apps.example.com', noneTaken)).toEqual({
      ok: true, host: 'shop.apps.example.com',
    });
  });
});
