import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const execFileP = promisify(execFile);

export const AGENT_COMMIT_PREFIX = 'botsman:';
const GIT_AUTHOR = ['-c', 'user.name=botsman', '-c', 'user.email=botsman@localhost'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', [...GIT_AUTHOR, ...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function initProjectRepo(slug: string): Promise<string> {
  const dir = paths.projectDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  // Secrets must never land in the repo (§5).
  fs.writeFileSync(path.join(dir, '.gitignore'), ['.env', 'node_modules/', '*.log', ''].join('\n'));
  return dir;
}

/** Commit everything in the working tree as an agent commit. Returns commit hash or null if nothing changed. */
export async function commitAll(slug: string, message: string, agent = true): Promise<string | null> {
  const dir = paths.projectDir(slug);
  await git(dir, 'add', '-A');
  const status = await git(dir, 'status', '--porcelain');
  if (!status) return null;
  const prefix = agent ? `${AGENT_COMMIT_PREFIX} ` : '';
  await git(dir, 'commit', '-m', `${prefix}${message}`.slice(0, 500));
  return git(dir, 'rev-parse', 'HEAD');
}

export async function headCommit(slug: string): Promise<string | null> {
  try {
    return await git(paths.projectDir(slug), 'rev-parse', 'HEAD');
  } catch {
    return null;
  }
}

export async function checkoutCommit(slug: string, commit: string): Promise<void> {
  const dir = paths.projectDir(slug);
  await git(dir, 'reset', '--hard', commit);
  // Drop untracked leftovers (e.g. from a failed agent run); keep ignored files (.env).
  await git(dir, 'clean', '-fd');
}

export async function log(slug: string, limit = 10): Promise<string> {
  return git(paths.projectDir(slug), 'log', '--oneline', `-${limit}`);
}

// --- push-to-deploy: bare repo + post-receive hook (EPIC C / AC-E1) ---

/**
 * Creates a bare repo for `git push` from the user's machine. The post-receive
 * hook notifies the daemon's control API, which syncs the working tree and
 * redeploys. The hook carries the control token and is 0700 — other host
 * users must not read it.
 */
export async function ensureBareRepo(slug: string, controlUrl: string, token: string): Promise<string> {
  const bare = paths.bareRepo(slug);
  if (!fs.existsSync(bare)) {
    fs.mkdirSync(bare, { recursive: true });
    await git(bare, 'init', '--bare', '-b', 'main');
  }
  const hook = path.join(bare, 'hooks', 'post-receive');
  fs.writeFileSync(
    hook,
    `#!/bin/sh
# Installed by botsman: notify the daemon that ${slug} received a push.
curl -fsS -m 10 -X POST -H "X-Botsman-Token: ${token}" "${controlUrl}/hooks/push/${slug}" || \
  echo "botsman daemon unreachable at ${controlUrl}; deploy will not start" >&2
`,
  );
  fs.chmodSync(hook, 0o700);
  return bare;
}

/**
 * Pick up commits the user pushed while no deploy was running, BEFORE an agent
 * task starts — shrinks the window in which syncToBare's force-push could
 * discard manual work. Returns 'diverged' when histories conflict; the caller
 * must abort the task and tell the user.
 */
export async function syncFromBareIfAhead(slug: string): Promise<'none' | 'fast-forwarded' | 'diverged'> {
  const dir = paths.projectDir(slug);
  const bare = paths.bareRepo(slug);
  if (!fs.existsSync(bare)) return 'none';
  try {
    await git(dir, 'fetch', bare, 'main');
  } catch {
    return 'none'; // empty bare repo
  }
  const head = await git(dir, 'rev-parse', 'HEAD');
  const fetched = await git(dir, 'rev-parse', 'FETCH_HEAD');
  if (head === fetched) return 'none';
  try {
    await git(dir, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD');
    await git(dir, 'reset', '--hard', 'FETCH_HEAD');
    await git(dir, 'clean', '-fd');
    return 'fast-forwarded';
  } catch {
    try {
      await git(dir, 'merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD');
      return 'none'; // bare is behind; syncToBare will fast-forward it later
    } catch {
      return 'diverged';
    }
  }
}

/** Push the working tree's main to the bare repo so clones see agent commits. */
export async function syncToBare(slug: string): Promise<void> {
  const dir = paths.projectDir(slug);
  const bare = paths.bareRepo(slug);
  if (!fs.existsSync(bare)) return;
  await git(dir, 'push', '--force', bare, 'main');
}

/** Pull pushed changes from the bare repo into the working tree (post-receive flow). */
export async function syncFromBare(slug: string): Promise<string | null> {
  const dir = paths.projectDir(slug);
  const bare = paths.bareRepo(slug);
  await git(dir, 'fetch', bare, 'main');
  await git(dir, 'reset', '--hard', 'FETCH_HEAD');
  return headCommit(slug);
}
