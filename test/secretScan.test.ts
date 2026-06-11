import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanForSecrets } from '../src/deploy/secretScan.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-scan-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanForSecrets (AC-B5)', () => {
  it('finds an anthropic key in source', () => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";');
    const findings = scanForSecrets(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toContain('Anthropic');
  });

  it('finds a telegram token and password-in-url', () => {
    fs.writeFileSync(
      path.join(dir, 'config.js'),
      'const t = "123456789:AAHsomethingsomethingsomethingsome12345";\nconst db = "postgres://user:supersecret123@host/db";',
    );
    const patterns = scanForSecrets(dir).map((f) => f.pattern);
    expect(patterns).toContain('Telegram bot token');
    expect(patterns).toContain('Hardcoded password in URL');
  });

  it('covers the project memory file CLAUDE.md', () => {
    // Memory is committed to git, so the secret scan must walk it too.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# notes\nthe key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
    const findings = scanForSecrets(dir);
    expect(findings.some((f) => f.file === 'CLAUDE.md')).toBe(true);
  });

  it('ignores clean env-based code', () => {
    fs.writeFileSync(
      path.join(dir, 'app.js'),
      'const url = process.env.DATABASE_URL;\nconst key = process.env.API_KEY;',
    );
    expect(scanForSecrets(dir)).toHaveLength(0);
  });

  it('skips .env, node_modules and .git', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'blob'), 'AKIAABCDEFGHIJKLMNOP');
    expect(scanForSecrets(dir)).toHaveLength(0);
  });
});
