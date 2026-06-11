import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/db.js';
import { getFocus, setFocus, clearFocus, detectRoomSwitch } from '../src/gateway/rooms.js';
import type { ProjectMeta } from '../src/types.js';

function sampleProject(slug: string): Omit<ProjectMeta, 'createdAt' | 'updatedAt'> {
  return {
    slug, name: slug, description: '', status: 'live',
    domain: `${slug}.apps.test`, internalPort: 3000,
    currentCommit: null, currentImage: null, prevCommit: null, prevImage: null,
    dbName: `app_${slug}`, dbUser: `u_${slug}`, dbPassword: 'pw',
  };
}

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});

describe('focus state', () => {
  it('defaults to no focus', () => {
    expect(getFocus(store, 1)).toBeNull();
  });

  it('round-trips a focused project', () => {
    store.createProject(sampleProject('todo'));
    setFocus(store, 1, 'todo');
    expect(getFocus(store, 1)).toBe('todo');
    clearFocus(store, 1);
    expect(getFocus(store, 1)).toBeNull();
  });

  it('self-heals focus on a deleted project', () => {
    store.createProject(sampleProject('todo'));
    setFocus(store, 1, 'todo');
    store.deleteProject('todo');
    expect(getFocus(store, 1)).toBeNull();
  });

  it('keeps focus separate per chat', () => {
    store.createProject(sampleProject('todo'));
    setFocus(store, 1, 'todo');
    expect(getFocus(store, 2)).toBeNull();
  });
});

describe('detectRoomSwitch', () => {
  it('detects the three keyboard buttons', () => {
    expect(detectRoomSwitch('🏠 Home', [])).toEqual({ kind: 'home' });
    expect(detectRoomSwitch('🛠 Server', [])).toEqual({ kind: 'devops' });
    expect(detectRoomSwitch('📦 Projects', [])).toBe('projects');
  });

  it('detects slash commands and NL synonyms', () => {
    expect(detectRoomSwitch('/server', [])).toEqual({ kind: 'devops' });
    expect(detectRoomSwitch('сервер', [])).toEqual({ kind: 'devops' });
    expect(detectRoomSwitch('домой', [])).toEqual({ kind: 'home' });
    expect(detectRoomSwitch('проекты', [])).toBe('projects');
  });

  it('switches into a project only with a switch verb', () => {
    expect(detectRoomSwitch('go to todo-list', ['todo-list'])).toEqual({ kind: 'project', slug: 'todo-list' });
    expect(detectRoomSwitch('перейди в todo-list', ['todo-list'])).toEqual({ kind: 'project', slug: 'todo-list' });
    // No verb → not a switch (it's an edit instruction that mentions the slug).
    expect(detectRoomSwitch('add dark theme to todo-list', ['todo-list'])).toBeNull();
  });

  it('returns null for ordinary messages', () => {
    expect(detectRoomSwitch('make a TODO service', [])).toBeNull();
  });
});
