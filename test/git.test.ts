import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initProjectRepo, commitAll, headCommit, checkoutCommit,
  ensureBareRepo, syncToBare, syncFromBare, syncFromBareIfAhead, AGENT_COMMIT_PREFIX,
} from '../src/git.js';
import { paths } from '../src/paths.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-git-'));
  process.env.BOTSMAN_HOME = home;
});
afterEach(() => {
  delete process.env.BOTSMAN_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('project git lifecycle (EPIC C)', () => {
  it('init creates repo with .gitignore covering .env', async () => {
    const dir = await initProjectRepo('todo');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');
  });

  it('agent commits are prefixed, manual ones are not', async () => {
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)');
    const c1 = await commitAll('todo', 'сделай todo сервис');
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir }).toString().trim();
    expect(subject.startsWith(AGENT_COMMIT_PREFIX)).toBe(true);
  });

  it('commitAll returns null when nothing changed', async () => {
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'x');
    await commitAll('todo', 'first');
    expect(await commitAll('todo', 'noop')).toBeNull();
  });

  it('checkoutCommit restores state and drops untracked leftovers', async () => {
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'v1');
    const c1 = (await commitAll('todo', 'v1'))!;
    fs.writeFileSync(path.join(dir, 'a.js'), 'v2');
    fs.writeFileSync(path.join(dir, 'junk.tmp'), 'leftover');
    await commitAll('todo', 'v2');
    await checkoutCommit('todo', c1);
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(dir, 'junk.tmp'))).toBe(false);
    expect(await headCommit('todo')).toBe(c1);
  });

  it('bare repo round-trip: agent → bare → clone → push → working tree (AC-E1)', async () => {
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'v1');
    await commitAll('todo', 'v1');
    const bare = await ensureBareRepo('todo', 'http://127.0.0.1:8366', 'sekret');
    await syncToBare('todo');

    // post-receive hook installed, executable, owner-only, carries the token
    const hook = path.join(bare, 'hooks', 'post-receive');
    expect(fs.statSync(hook).mode & 0o111).toBeTruthy();
    expect(fs.statSync(hook).mode & 0o077).toBe(0); // not readable by group/other
    const hookBody = fs.readFileSync(hook, 'utf8');
    expect(hookBody).toContain('/hooks/push/todo');
    expect(hookBody).toContain('X-Botsman-Token: sekret');
    // the daemon's own syncs must not echo a phantom push-to-deploy
    expect(hookBody).toContain('BOTSMAN_INTERNAL_PUSH');

    // user clones, commits, pushes
    const clone = path.join(home, 'clone');
    execFileSync('git', ['clone', '-q', bare, clone]);
    fs.writeFileSync(path.join(clone, 'manual.js'), 'manual change');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
    execFileSync('git', ['add', '-A'], { cwd: clone, env });
    execFileSync('git', ['commit', '-qm', 'manual: add file'], { cwd: clone, env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone, env });

    // daemon syncs working tree from bare
    const head = await syncFromBare('todo');
    expect(fs.existsSync(path.join(paths.projectDir('todo'), 'manual.js'))).toBe(true);
    const subjects = execFileSync('git', ['log', '--format=%s'], { cwd: dir }).toString();
    expect(subjects).toContain('manual: add file');
    expect(subjects).toContain('botsman: v1');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('syncFromBare keeps working-tree commits that bare lacks (no data loss on redeploy)', async () => {
    // The silent-no-deploy state: an agent committed its work but it was never
    // syncToBare'd, so the WORKING TREE is ahead of bare. A blind reset --hard
    // would discard that commit and re-serve stale code; syncFromBare must not.
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'v1');
    await commitAll('todo', 'v1');
    await ensureBareRepo('todo', 'http://127.0.0.1:8366', 'tok');
    await syncToBare('todo'); // bare == v1

    const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
    fs.writeFileSync(path.join(dir, 'footer.js'), 'built with botsman');
    execFileSync('git', ['add', '-A'], { cwd: dir, env });
    execFileSync('git', ['commit', '-qm', 'agent: footer'], { cwd: dir, env });
    const ahead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    const head = await syncFromBare('todo');

    // The footer commit survives — HEAD is unchanged, not reset back to bare.
    expect(head).toBe(ahead);
    expect(await headCommit('todo')).toBe(ahead);
    expect(fs.existsSync(path.join(dir, 'footer.js'))).toBe(true);
    // ...and bare was fast-forwarded to match, so a fresh clone sees the footer.
    const clone = path.join(home, 'clone-ahead');
    execFileSync('git', ['clone', '-q', paths.bareRepo('todo'), clone]);
    expect(fs.existsSync(path.join(clone, 'footer.js'))).toBe(true);
  });

  it('syncFromBare still pulls bare forward on a normal push (bare ahead)', async () => {
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'v1');
    await commitAll('todo', 'v1');
    const bare = await ensureBareRepo('todo', 'http://127.0.0.1:8366', 'tok');
    await syncToBare('todo');

    // User pushes a commit the working tree hasn't seen (bare ahead).
    const clone = path.join(home, 'clone-push');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
    execFileSync('git', ['clone', '-q', bare, clone]);
    fs.writeFileSync(path.join(clone, 'pushed.js'), 'user work');
    execFileSync('git', ['add', '-A'], { cwd: clone, env });
    execFileSync('git', ['commit', '-qm', 'manual: user work'], { cwd: clone, env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone, env });

    await syncFromBare('todo');
    expect(fs.existsSync(path.join(dir, 'pushed.js'))).toBe(true);
  });

  it('syncFromBareIfAhead fast-forwards user pushes before an agent task', async () => {
    const dir = await initProjectRepo('todo');
    fs.writeFileSync(path.join(dir, 'a.js'), 'v1');
    await commitAll('todo', 'v1');
    const bare = await ensureBareRepo('todo', 'http://127.0.0.1:8366', 'tok');
    await syncToBare('todo');

    expect(await syncFromBareIfAhead('todo')).toBe('none');

    // user pushes a commit the daemon hasn't seen
    const clone = path.join(home, 'clone-ff');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
    execFileSync('git', ['clone', '-q', bare, clone]);
    fs.writeFileSync(path.join(clone, 'pushed.js'), 'user work');
    execFileSync('git', ['add', '-A'], { cwd: clone, env });
    execFileSync('git', ['commit', '-qm', 'manual: user work'], { cwd: clone, env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone, env });

    expect(await syncFromBareIfAhead('todo')).toBe('fast-forwarded');
    expect(fs.existsSync(path.join(dir, 'pushed.js'))).toBe(true);
  });
});
