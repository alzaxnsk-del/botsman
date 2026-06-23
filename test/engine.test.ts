import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerDeployEngine } from '../src/deploy/engine.js';
import { paths } from '../src/paths.js';
import type { ProjectMeta } from '../src/types.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-eng-'));
  process.env.BOTSMAN_HOME = home;
});
afterEach(() => {
  delete process.env.BOTSMAN_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function project(slug: string): ProjectMeta {
  return {
    slug, name: slug, description: '', status: 'building',
    domain: `${slug}.apps.test`, internalPort: 3000,
    currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
    dbName: 'app', dbUser: 'u', dbPassword: 'p', createdAt: '', updatedAt: '',
  };
}

describe('DockerDeployEngine build guard', () => {
  it('fails with a clear message — not a cryptic docker COPY error — when there is no Dockerfile or package.json', async () => {
    // docker/caddy are never touched: the guard throws before the build starts.
    const engine = new DockerDeployEngine({} as never, {} as never, 'apps.test');
    const slug = 'empty-proj';
    fs.mkdirSync(paths.projectDir(slug), { recursive: true });
    // Only a seeded file, nothing buildable — the incident's failing tree.
    fs.writeFileSync(path.join(paths.projectDir(slug), 'CLAUDE.md'), '# memory');

    const res = await engine.deploy(project(slug), 'deadbeefcafe1234', () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no application source');
  });
});

describe('DockerDeployEngine.changeDomain', () => {
  it('reports live=false and never touches the proxy when nothing is running', async () => {
    let upserts = 0;
    const docker = { listContainers: async () => [] } as never;
    const caddy = { upsertRoute: async () => { upserts++; } } as never;
    const engine = new DockerDeployEngine(docker, caddy, 'apps.test');

    const res = await engine.changeDomain(project('todo'), 'shop.apps.test');
    expect(res).toEqual({ ok: true, live: false });
    expect(upserts).toBe(0); // no container → no route switch
  });

  it('re-points the live route to the running container on the new host', async () => {
    const calls: Array<{ slug: string; host: string; upstream: string }> = [];
    const docker = {
      listContainers: async () => [{ Names: ['/botsman-app-todo-abc'], Id: 'abc' }],
    } as never;
    const caddy = {
      upsertRoute: async (slug: string, host: string, upstream: string) => { calls.push({ slug, host, upstream }); },
    } as never;
    const engine = new DockerDeployEngine(docker, caddy, 'apps.test');

    // Tiny smoke window: the test host won't answer, so we get a publicWarning
    // fast instead of waiting the production 45s.
    const res = await engine.changeDomain(project('todo'), 'shop.apps.test', { timeoutMs: 30, intervalMs: 10 });
    expect(res.ok).toBe(true);
    expect(res.live).toBe(true);
    expect(res.publicWarning).toBeTruthy(); // unreachable test host
    expect(calls).toEqual([{ slug: 'todo', host: 'shop.apps.test', upstream: 'botsman-app-todo-abc:3000' }]);
  });
});
