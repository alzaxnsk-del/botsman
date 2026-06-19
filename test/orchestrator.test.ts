import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { Orchestrator } from '../src/orchestrator.js';
import { Store } from '../src/db.js';
import { paths } from '../src/paths.js';
import type { CodingAgent, AgentRunInput } from '../src/agent/CodingAgent.js';
import type { DeployEngine, DeployResult } from '../src/deploy/engine.js';
import type { PostgresAdmin } from '../src/deploy/postgres.js';
import type { Telemetry } from '../src/telemetry.js';
import type { ProjectMeta } from '../src/types.js';

let home: string;
let store: Store;

const pgAdmin = {
  ensureProjectDb: async () => {},
  dropProjectDb: async () => {},
} as unknown as PostgresAdmin;

const telemetry = {
  onFirstDeploy: async () => {},
  onInstall: async () => {},
  onActivity: async () => {},
} as unknown as Telemetry;

function fakeAgent(write: (input: AgentRunInput) => void, summary = 'сделал'): CodingAgent {
  return {
    run: async (input) => {
      write(input);
      return { ok: true, summary, durationMs: 1 };
    },
  };
}

function fakeEngine(overrides: Partial<DeployEngine> = {}): DeployEngine & { deploys: string[] } {
  const deploys: string[] = [];
  return {
    deploys,
    deploy: async (p: ProjectMeta, commit: string): Promise<DeployResult> => {
      deploys.push(commit);
      return {
        ok: true,
        image: `botsman/${p.slug}:${commit.slice(0, 12)}`,
        containerName: `botsman-app-${p.slug}`,
        url: `https://${p.domain}/`,
        screenshotPath: null,
      };
    },
    rollback: async (p: ProjectMeta): Promise<DeployResult> => ({
      ok: true, image: p.prevImage!, url: `https://${p.domain}/`,
    }),
    remove: async () => {},
    containerLogs: async () => '',
    containerRunning: async () => true,
    cleanupImages: async () => {},
    probeInternal: async () => ({ ok: true, detail: 'HTTP 200' }),
    restartService: async () => {},
    restartProxy: async () => {},
    ...overrides,
  };
}

function makeOrch(agent: CodingAgent, engine: DeployEngine): Orchestrator {
  return new Orchestrator(
    store, agent, engine, pgAdmin, 'apps.test', 'http://127.0.0.1:8366', 'test-token', telemetry,
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-orch-'));
  process.env.BOTSMAN_HOME = home;
  store = new Store(':memory:');
});
afterEach(() => {
  delete process.env.BOTSMAN_HOME;
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Orchestrator pipeline', () => {
  it('create: agent → commit → deploy → live (happy path)', async () => {
    const agent = fakeAgent(({ projectDir }) => {
      fs.writeFileSync(path.join(projectDir, 'server.js'), 'const p = process.env.PORT;');
    });
    const engine = fakeEngine();
    const orch = makeOrch(agent, engine);
    const stages: string[] = [];

    const o = await orch.enqueue('create', 'сделай todo сервис', (s) => stages.push(s));
    expect(o.ok).toBe(true);
    expect(o.url).toMatch(/^https:\/\/.*\.apps\.test\/$/);

    const p = store.getProject(o.slug)!;
    expect(p.status).toBe('live');
    expect(p.currentCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.currentImage).toContain(`botsman/${o.slug}:`);
    expect(engine.deploys).toHaveLength(1);
    expect(stages).toContain('generating');
    expect(fs.existsSync(paths.bareRepo(o.slug))).toBe(true);
    expect(store.tasksForProject(o.slug)[0].status).toBe('done');

    // Project memory is seeded by the orchestrator (the fakeAgent never touches
    // CLAUDE.md), containing the original description.
    const memory = fs.readFileSync(path.join(paths.projectDir(o.slug), 'CLAUDE.md'), 'utf8');
    expect(memory).toContain('сделай todo сервис');
    expect(memory).toContain('Botsman project memory');
  });

  it('edit: hands the agent its most recent completed change (Layer-2 continuity)', async () => {
    const seenContext: string[][] = [];
    const agent: CodingAgent = {
      run: async (input) => {
        seenContext.push(input.context ?? []);
        fs.writeFileSync(path.join(input.projectDir, 'server.js'), `// ${input.instruction}`);
        return { ok: true, summary: `did: ${input.instruction}`, durationMs: 1 };
      },
    };
    const orch = makeOrch(agent, fakeEngine());
    const created = await orch.enqueue('create', 'сделай заметки', () => {});
    await orch.enqueue('edit', 'добавь тёмную тему', () => {}, created.slug);

    // The create run had no prior task → no continuity line.
    expect(seenContext[0].some((l) => l.includes('Most recent completed change'))).toBe(false);
    // The edit run sees the create's summary.
    expect(seenContext[1].some((l) => l.includes('Most recent completed change: did: сделай заметки'))).toBe(true);
  });

  it('create: persistent hardcoded secret blocks deploy (AC-B5)', async () => {
    const agent = fakeAgent(({ projectDir }) => {
      fs.writeFileSync(path.join(projectDir, 'app.js'), 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";');
    });
    const engine = fakeEngine();
    const orch = makeOrch(agent, engine);

    const o = await orch.enqueue('create', 'сервис с секретом', () => {});
    expect(o.ok).toBe(false);
    expect(o.error).toContain('secrets');
    expect(engine.deploys).toHaveLength(0);
    expect(store.getProject(o.slug)?.status).toBe('failed');
  });

  it('edit: failed deploy keeps the live version untouched (AC-C2)', async () => {
    let version = 1;
    const agent = fakeAgent(({ projectDir }) => {
      fs.writeFileSync(path.join(projectDir, 'server.js'), `// v${version++}`);
    });
    let failNext = false;
    const base = fakeEngine();
    const engine = fakeEngine({
      deploy: async (p: ProjectMeta, commit: string) => {
        if (failNext) return { ok: false, error: 'docker build: boom' };
        return base.deploy(p, commit, () => {});
      },
    });
    const orch = makeOrch(agent, engine);

    const created = await orch.enqueue('create', 'сделай сервис заметок', () => {});
    expect(created.ok).toBe(true);
    const before = store.getProject(created.slug)!;

    failNext = true;
    const edited = await orch.enqueue('edit', 'сломай сборку', () => {}, created.slug);
    expect(edited.ok).toBe(false);
    expect(edited.error).toContain('live version is untouched');

    const after = store.getProject(created.slug)!;
    expect(after.status).toBe('live');
    expect(after.currentImage).toBe(before.currentImage);
    expect(after.currentCommit).toBe(before.currentCommit);
  });

  it('rollback swaps current and previous version (AC-C3)', async () => {
    let version = 1;
    const agent = fakeAgent(({ projectDir }) => {
      fs.writeFileSync(path.join(projectDir, 'server.js'), `// v${version++}`);
    });
    const orch = makeOrch(agent, fakeEngine());

    const created = await orch.enqueue('create', 'сделай сервис погоды', () => {});
    const v1 = store.getProject(created.slug)!;
    await orch.enqueue('edit', 'обнови', () => {}, created.slug);
    const v2 = store.getProject(created.slug)!;
    expect(v2.prevImage).toBe(v1.currentImage);

    const rolled = await orch.enqueue('rollback', '', () => {}, created.slug);
    expect(rolled.ok).toBe(true);
    const v3 = store.getProject(created.slug)!;
    expect(v3.currentImage).toBe(v1.currentImage);
    expect(v3.prevImage).toBe(v2.currentImage);
  });

  it('delete removes project dir, bare repo and db record', async () => {
    const agent = fakeAgent(({ projectDir }) => {
      fs.writeFileSync(path.join(projectDir, 'x.js'), 'x');
    });
    const orch = makeOrch(agent, fakeEngine());
    const created = await orch.enqueue('create', 'сделай сервис списков', () => {});
    expect(created.ok).toBe(true);

    const deleted = await orch.enqueue('delete', '', () => {}, created.slug);
    expect(deleted.ok).toBe(true);
    expect(store.projectExists(created.slug)).toBe(false);
    expect(fs.existsSync(paths.projectDir(created.slug))).toBe(false);
    expect(fs.existsSync(paths.bareRepo(created.slug))).toBe(false);
  });

  it('askProject answers read-only — never commits or deploys', async () => {
    let askMode = '';
    const agent: CodingAgent = {
      run: async (input) => {
        askMode = input.mode;
        if (input.mode === 'ask') return { ok: true, summary: 'It is an Express app with one route.', durationMs: 1 };
        fs.writeFileSync(path.join(input.projectDir, 'server.js'), 'v1');
        return { ok: true, summary: 'made', durationMs: 1 };
      },
    };
    const engine = fakeEngine();
    const orch = makeOrch(agent, engine);
    const created = await orch.enqueue('create', 'сделай сервис приветствий', () => {});
    const before = store.getProject(created.slug)!;

    const ans = await orch.askProject(created.slug, 'how is this built?');
    expect(askMode).toBe('ask');
    expect(ans.ok).toBe(true);
    expect(ans.answer).toContain('Express');
    // No new deploy, commit unchanged.
    expect(engine.deploys).toHaveLength(1);
    expect(store.getProject(created.slug)!.currentCommit).toBe(before.currentCommit);
  });

  it('redeploy of the already-live commit is a no-op (git push without changes)', async () => {
    const agent = fakeAgent(({ projectDir }) => {
      fs.writeFileSync(path.join(projectDir, 'server.js'), 'v1');
    });
    const engine = fakeEngine();
    const orch = makeOrch(agent, engine);
    const created = await orch.enqueue('create', 'сделай сервис приветствий', () => {});
    expect(created.ok).toBe(true);
    expect(engine.deploys).toHaveLength(1);

    // bare == working tree (user pushed without new commits)
    const o = await orch.enqueue('redeploy', 'git push', () => {}, created.slug);
    expect(o.ok).toBe(true);
    expect(o.summary).toContain('up to date');
    expect(engine.deploys).toHaveLength(1); // no second deploy
  });

  it('serializes tasks: second waits for the first', async () => {
    const order: string[] = [];
    const agent: CodingAgent = {
      run: async (input) => {
        order.push(`start:${input.instruction}`);
        await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(path.join(input.projectDir, 'a.js'), input.instruction);
        order.push(`end:${input.instruction}`);
        return { ok: true, summary: 'ok', durationMs: 50 };
      },
    };
    const orch = makeOrch(agent, fakeEngine());
    const [a, b] = await Promise.all([
      orch.enqueue('create', 'сделай сервис один', () => {}),
      orch.enqueue('create', 'сделай сервис два', () => {}),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(order).toEqual([
      'start:сделай сервис один', 'end:сделай сервис один',
      'start:сделай сервис два', 'end:сделай сервис два',
    ]);
  });

  it('cancels a still-queued task; a running task cannot be cancelled', async () => {
    const ran: string[] = [];
    const agent: CodingAgent = {
      run: async (input) => {
        ran.push(input.instruction);
        await new Promise((r) => setTimeout(r, 50)); // keep the first task running
        fs.writeFileSync(path.join(input.projectDir, 'package.json'), '{"name":"x"}');
        fs.writeFileSync(path.join(input.projectDir, 'server.js'), 'const p = process.env.PORT;');
        return { ok: true, summary: 'ok', durationMs: 50 };
      },
    };
    const orch = makeOrch(agent, fakeEngine());

    let cancelFirst: (() => boolean) | null = null;
    let cancelSecond: (() => boolean) | null = null;
    // The first task starts draining synchronously, so it's already running;
    // the second sits in the queue behind it.
    const first = orch.enqueue('create', 'one', () => {}, undefined, (c) => { cancelFirst = c; });
    const second = orch.enqueue('create', 'two', () => {}, undefined, (c) => { cancelSecond = c; });

    expect(cancelFirst!()).toBe(false); // already running → no-op
    expect(cancelSecond!()).toBe(true); // still queued → pulled out

    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.cancelled).toBe(true);
    expect(ran).toEqual(['one']); // the cancelled task never ran the agent
  });

  it('create fails clearly when the agent produces no application files', async () => {
    // The agent "ran" (ok) but wrote nothing — only the seeded .gitignore/CLAUDE.md
    // remain, which is what slipped past the old "no files" guard.
    const agent = fakeAgent(() => { /* writes nothing */ }, 'thought about it');
    const engine = fakeEngine();
    const orch = makeOrch(agent, engine);

    const o = await orch.enqueue('create', 'сделай мне что-нибудь', () => {});
    expect(o.ok).toBe(false);
    expect(o.error).toContain('without creating any application files');
    expect(engine.deploys).toHaveLength(0);
    expect(store.getProject(o.slug)?.status).toBe('failed');
  });

  it('resumeCreate rebuilds an interrupted create from the original request', async () => {
    let seenInstruction = '';
    const agent: CodingAgent = {
      run: async (input) => {
        seenInstruction = input.instruction;
        fs.writeFileSync(path.join(input.projectDir, 'package.json'), '{"name":"x"}');
        fs.writeFileSync(path.join(input.projectDir, 'server.js'), 'const p = process.env.PORT;');
        return { ok: true, summary: 'rebuilt', durationMs: 1 };
      },
    };
    const engine = fakeEngine();
    const orch = makeOrch(agent, engine);

    // The half-made project an interrupted create leaves behind: the row exists
    // (status failed) and holds the ORIGINAL description.
    store.createProject({
      slug: 'hello-world', name: 'hello-world',
      description: 'сделай страничку hello world в стиле тинейджера', status: 'failed',
      domain: 'hello-world.apps.test', internalPort: 3000,
      currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
      dbName: 'app_hello_world', dbUser: 'u_hello_world', dbPassword: 'pw',
    });

    const o = await orch.enqueue('resume', '', () => {}, 'hello-world');
    expect(o.ok).toBe(true);
    expect(o.slug).toBe('hello-world');
    // The agent saw the ORIGINAL request, not an empty/substituted instruction.
    expect(seenInstruction).toContain('hello world в стиле тинейджера');
    expect(store.getProject('hello-world')!.status).toBe('live');
    expect(engine.deploys).toHaveLength(1);
  });

  it('reconcileOnStartup fails interrupted tasks and surfaces resumable creates', async () => {
    const orch = makeOrch(fakeAgent(() => {}), fakeEngine());
    // A create caught mid-flight: project row exists, its task is still queued.
    store.createProject({
      slug: 'hello-world', name: 'hello-world', description: 'teen hello world',
      status: 'creating', domain: 'hello-world.apps.test', internalPort: 3000,
      currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
      dbName: 'app', dbUser: 'u', dbPassword: 'p',
    });
    store.createTask('hello-world', 'create', 'teen hello world');

    const docker = { listContainers: async () => [] } as unknown as Dockerode;
    const { notes, resumable } = await orch.reconcileOnStartup(docker);

    expect(notes.some((n) => n.includes('tasks interrupted by the restart: 1'))).toBe(true);
    expect(resumable).toEqual([{ slug: 'hello-world', instruction: 'teen hello world' }]);
    expect(store.tasksForProject('hello-world')[0].status).toBe('failed');
    expect(store.getProject('hello-world')!.status).toBe('failed'); // no image → failed
  });
});
