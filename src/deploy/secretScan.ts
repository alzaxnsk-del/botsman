import fs from 'node:fs';
import path from 'node:path';

/**
 * AC-B5: generated code must not contain hardcoded secrets. Scans tracked
 * project files for typical key patterns before commit/deploy.
 *
 * Tuned to avoid false positives that would block legitimate deploys:
 *  - template files (.env.example, *.sample, *.template, *.dist) are skipped —
 *    they hold placeholder values BY DESIGN (the system prompt asks the agent
 *    to keep a .env.example);
 *  - the "password in URL" check ignores obvious placeholder credentials
 *    (password / postgres / your_password / localhost …) so example connection
 *    strings in code or the README don't trip it.
 */
const SIMPLE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Anthropic API key', re: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{40,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

// proto://user:password@host  — captures the password for placeholder filtering.
const URL_CRED_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s:@]{6,})@[^/\s:@/]+/gi;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
const SKIP_FILES = new Set(['.env', 'package-lock.json']);
// Template files hold placeholders by convention.
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;
// Binary assets (e.g. an attached reference image) — scanning their bytes as
// UTF-8 is meaningless and risks a spurious match; skip by extension.
const BINARY_SUFFIX = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|ico|pdf|zip|gz|tgz|tar|woff2?|ttf|otf|eot|mp4|mov|webm|mp3|wav|ogg)$/i;

/**
 * Obvious non-secret placeholders that must NOT be treated as a real password.
 * Only the PASSWORD is judged — a real password is a real secret regardless of
 * the host. Common example values (password / postgres / your_password / …) and
 * any value containing a placeholder token (your, example, changeme, <…>, {{…}})
 * are ignored.
 */
function isPlaceholderPassword(pass: string): boolean {
  const p = pass.toLowerCase();
  const placeholderExact =
    /^(password|passwd|pass|postgres|mysql|mongodb|redis|root|admin|secret|changeme|change_me|example\w*|placeholder|dbpass\w*|mypassword|mysecret|test\w*|user|username|demo|12345678|password123)$/;
  const placeholderToken = /(your|example|changeme|placeholder|xxx+|\*\*\*|<|>|\{\{|\}\}|\.\.\.)/;
  return placeholderExact.test(p) || placeholderToken.test(p);
}

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
    if (!entry.isFile() || SKIP_FILES.has(entry.name) || TEMPLATE_SUFFIX.test(entry.name) || BINARY_SUFFIX.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let content: string;
    try {
      const st = fs.statSync(full);
      if (st.size > 1024 * 1024) continue; // skip binaries/large files
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, full);
    for (const { name, re } of SIMPLE_PATTERNS) {
      if (re.test(content)) findings.push({ file: rel, pattern: name });
    }
    if (hasRealUrlPassword(content)) {
      findings.push({ file: rel, pattern: 'Hardcoded password in URL' });
    }
  }
}

/** True only if a URL credential is present AND its password isn't a placeholder. */
export function hasRealUrlPassword(content: string): boolean {
  URL_CRED_RE.lastIndex = 0;
  for (let m = URL_CRED_RE.exec(content); m; m = URL_CRED_RE.exec(content)) {
    if (!isPlaceholderPassword(m[1])) return true;
  }
  return false;
}
