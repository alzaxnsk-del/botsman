import fs from 'node:fs';
import path from 'node:path';

/**
 * AC-B5: generated code must not contain hardcoded secrets. Scans tracked
 * project files for typical key patterns before commit/deploy.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Anthropic API key', re: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{40,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Hardcoded password in URL', re: /[a-z]+:\/\/[^/\s:@]+:[^/\s:@]{8,}@/ },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
const SKIP_FILES = new Set(['.env', 'package-lock.json']);

export interface SecretFinding {
  file: string;
  pattern: string;
}

export function scanForSecrets(dir: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  walk(dir, dir, findings);
  return findings;
}

function walk(root: string, dir: string, findings: SecretFinding[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, path.join(dir, entry.name), findings);
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let content: string;
    try {
      const st = fs.statSync(full);
      if (st.size > 1024 * 1024) continue; // skip binaries/large files
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const { name, re } of PATTERNS) {
      if (re.test(content)) {
        findings.push({ file: path.relative(root, full), pattern: name });
      }
    }
  }
}
