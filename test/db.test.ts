import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/db.js';
import type { ProjectMeta } from '../src/types.js';

function sampleProject(slug = 'todo'): Omit<ProjectMeta, 'createdAt' | 'updatedAt'> {
  return {
    slug, name: slug, description: 'todo service', status: 'creating',
    domain: `${slug}.apps.example.com`, internalPort: 3000,
    currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
    dbName: `app_${slug}`, dbUser: `u_${slug}`, dbPassword: 'pw',
  };
}

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});

describe('Store projects', () => {
  it('creates, reads, lists', () => {
    store.createProject(sampleProject());
    expect(store.projectExists('todo')).toBe(true);
    expect(store.getProject('todo')?.status).toBe('creating');
    expect(store.listProjects()).toHaveLength(1);
  });

  it('updates status and image bookkeeping for rollback', () => {
    store.createProject(sampleProject());
    store.updateProject('todo', {
      status: 'live', currentCommit: 'abc', currentImage: 'botsman/todo:abc',
    });
    store.updateProject('todo', {
      prevCommit: 'abc', prevImage: 'botsman/todo:abc',
      currentCommit: 'def', currentImage: 'botsman/todo:def',
    });
    const p = store.getProject('todo')!;
    expect(p.prevImage).toBe('botsman/todo:abc');
    expect(p.currentImage).toBe('botsman/todo:def');
  });

  it('deletes project with its tasks', () => {
    store.createProject(sampleProject());
    store.createTask('todo', 'create', 'make it');
    store.deleteProject('todo');
    expect(store.projectExists('todo')).toBe(false);
    expect(store.tasksForProject('todo')).toHaveLength(0);
  });
});

describe('Store tasks & kv', () => {
  it('tracks task lifecycle', () => {
    store.createProject(sampleProject());
    const t = store.createTask('todo', 'edit', 'dark theme');
    store.finishTask(t.id, 'done', 'added dark theme');
    const tasks = store.tasksForProject('todo');
    expect(tasks[0].status).toBe('done');
    expect(tasks[0].summary).toBe('added dark theme');
  });

  it('kv get/set/overwrite', () => {
    expect(store.kvGet('x')).toBeNull();
    store.kvSet('x', '1');
    store.kvSet('x', '2');
    expect(store.kvGet('x')).toBe('2');
  });

  it('failInterruptedTasks marks queued/running tasks as failed and returns them (restart reconciliation)', () => {
    store.createProject(sampleProject());
    store.createTask('todo', 'create', 'first');
    const t2 = store.createTask('todo', 'edit', 'second');
    store.finishTask(t2.id, 'done', 'ok');
    const failed = store.failInterruptedTasks();
    expect(failed).toHaveLength(1);
    // The returned rows carry the original instruction so the create can be resumed.
    expect(failed[0].instruction).toBe('first');
    expect(failed[0].kind).toBe('create');
    const tasks = store.tasksForProject('todo');
    expect(tasks.find((t) => t.instruction === 'first')?.status).toBe('failed');
    expect(tasks.find((t) => t.instruction === 'second')?.status).toBe('done');
    expect(store.failInterruptedTasks()).toHaveLength(0);
  });
});
