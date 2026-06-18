/**
 * "Develop this project on your computer with Claude Code" guide. Botsman runs
 * ON the server, so we fill in as much of the clone command as we reliably can:
 * the host path of the bare repo, the server's public IP (passed in by the
 * caller), and the SSH user inferred from the install path. Only a non-standard
 * SSH login can't be known — we note that. Pure (no IO) so it's unit-tested and
 * shared by both the 💻 Claude Code flow and the /status command.
 */

/** Infer the SSH user from the host path of ~/.botsman (BOTSMAN_HOST_DIR):
 *  /root/.botsman → root, /home/alice/.botsman → alice, else a placeholder. */
export function inferSshUser(hostHome: string): string {
  if (/^\/root(\/|$)/.test(hostHome)) return 'root';
  const m = hostHome.match(/^\/home\/([^/]+)/);
  return m ? m[1] : '<user>';
}

export interface CloneInfo {
  slug: string;
  /** Host path of ~/.botsman (BOTSMAN_HOST_DIR), where repos/<slug>.git lives. */
  hostHome: string;
  /** Server SSH host — the detected public IP, or '<server>' when undetectable. */
  host: string;
  /** The project's public domain, for the "goes live at" line. */
  domain: string;
}

/** The `user@host:path` scp-style clone target for a project's bare repo. */
export function cloneUrl(opts: { slug: string; hostHome: string; host: string }): string {
  const user = inferSshUser(opts.hostHome);
  const repoPath = `${opts.hostHome.replace(/\/+$/, '')}/repos/${opts.slug}.git`;
  return `${user}@${opts.host}:${repoPath}`;
}

/** The local-dev guide for one project, as a single Telegram message. */
export function localDevInstructions(info: CloneInfo): string {
  const url = cloneUrl(info);
  // Keep the inferred username OUT of the prose (only inside the code fence) so
  // an underscore in a Linux username can't trip Markdown parsing.
  const userNote = inferSshUser(info.hostHome) === '<user>'
    ? '\nReplace <user> with your SSH login on the server.'
    : '\n(Using your detected install user — change it if your SSH login differs.)';
  return [
    `💻 Develop ${info.slug} on your computer with Claude Code:`,
    '',
    '```',
    `git clone ${url}`,
    `cd ${info.slug} && claude`,
    '# make changes, then:',
    'git push   # auto-deploys',
    '```',
    `Your changes go live at https://${info.domain}/ after each push.${userNote}`,
  ].join('\n');
}
