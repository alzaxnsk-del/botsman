import { describe, it, expect } from 'vitest';
import { VERSION, RELEASED, versionLine } from '../src/version.js';

describe('version', () => {
  it('VERSION is semver-ish and RELEASED is an ISO date', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(RELEASED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('versionLine shows the version and the date', () => {
    const line = versionLine();
    expect(line).toContain(VERSION);
    expect(line).toContain(RELEASED);
  });
});
