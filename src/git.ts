import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const execFileP = promisify(execFile);

export const AGENT_COMMIT_PREFIX = 'botsman:';
// safe.directory=*: the root daemon must operate on repos whose files the
// unprivileged agent (uid 1000) created — git would refuse "dubious ownership".
const GIT_AUTHOR = [
  '-c', 'user.name=botsman',
  '-c', 'user.email=botsman@localhost',
  '-c', 'safe.directory=*',
];

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
# The daemon's own bare-repo syncs set BOTSMAN_INTERNAL_PUSH — without this
# guard every agent deploy would echo a phantom push-to-deploy of itself.
[ -n "$BOTSMAN_INTERNAL_PUSH" ] && exit 0
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
  // BOTSMAN_INTERNAL_PUSH: the post-receive hook must NOT treat our own sync
  // as a user push (it would echo a redeploy of the commit just deployed).
  await execFileP('git', [...GIT_AUTHOR, 'push', '--force', bare, 'main'], {
    cwd: dir,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, BOTSMAN_INTERNAL_PUSH: '1' },
  });
}

/**
 * Pull pushed changes from the bare repo into the working tree (post-receive flow).
 *
 * A blind `reset --hard FETCH_HEAD` is data-loss when the WORKING TREE is ahead
 * of bare — e.g. an agent committed its own work that was never syncToBare'd
 * (the silent-no-deploy bug leaves exactly this state). Resetting there would
 * throw those commits away and re-serve stale code. So: if bare is an ancestor
 * of HEAD (tree ahead), advance bare and KEEP the tree; otherwise take bare's
 * HEAD as before (the normal push-to-deploy case, and the rare diverged case).
 */
export async function syncFromBare(slug: string): Promise<string | null> {
  const dir = paths.projectDir(slug);
  const bare = paths.bareRepo(slug);
  await git(dir, 'fetch', bare, 'main');
  const head = await git(dir, 'rev-parse', 'HEAD').catch(() => null);
  const fetched = await git(dir, 'rev-parse', 'FETCH_HEAD');
  if (head === fetched) return head;
  if (head) {
    try {
      // bare (FETCH_HEAD) is an ancestor of HEAD → the tree has commits bare
      // lacks. Don't reset backwards; push forward so bare matches the tree.
      await git(dir, 'merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD');
      await syncToBare(slug);
      return head;
    } catch {
      // Not an ancestor → bare is ahead (normal push) or histories diverged.
    }
  }
  await git(dir, 'reset', '--hard', 'FETCH_HEAD');
  return headCommit(slug);
}
