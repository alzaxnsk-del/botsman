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
