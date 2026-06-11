/** Tiny console look&feel helpers for the setup wizard — no dependencies. */

const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) =>
  enabled ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  accent: wrap('38;5;208'), // Claude-ish orange
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  red: wrap('31'),
};

export const say = (s = ''): void => void process.stdout.write(s + '\n');

export function banner(subtitle: string): void {
  say();
  say(`  ${c.accent('◆')} ${c.bold('Botsman')}`);
  say(`    ${c.dim(subtitle)}`);
  say();
}

export function stepHeader(n: number, total: number, title: string): void {
  say();
  say(`  ${c.accent(`Step ${n} of ${total}`)} · ${c.bold(title)}`);
}

export const ok = (s: string): void => say(`    ${c.green('✓')} ${s}`);
export const bad = (s: string): void => say(`    ${c.red('✗')} ${s}`);
export const hint = (s: string): void => say(`    ${c.dim(s)}`);
export const divider = (): void => say(`  ${c.dim('─'.repeat(46))}`);

export const PROMPT = `    ${c.accent('❯')} `;
