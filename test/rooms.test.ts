import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/db.js';
import { getRoom, setRoom, roomLabel, detectRoomSwitch } from '../src/gateway/rooms.js';
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

describe('room state', () => {
  it('defaults to home', () => {
    expect(getRoom(store, 1)).toEqual({ kind: 'home' });
  });

  it('round-trips devops and project rooms', () => {
    setRoom(store, 1, { kind: 'devops' });
    expect(getRoom(store, 1)).toEqual({ kind: 'devops' });
    store.createProject(sampleProject('todo'));
    setRoom(store, 1, { kind: 'project', slug: 'todo' });
    expect(getRoom(store, 1)).toEqual({ kind: 'project', slug: 'todo' });
  });

  it('self-heals a project room whose slug was deleted', () => {
    store.createProject(sampleProject('todo'));
    setRoom(store, 1, { kind: 'project', slug: 'todo' });
    store.deleteProject('todo');
    expect(getRoom(store, 1)).toEqual({ kind: 'home' });
  });

  it('keeps rooms separate per chat', () => {
    setRoom(store, 1, { kind: 'devops' });
    expect(getRoom(store, 2)).toEqual({ kind: 'home' });
  });
});

describe('roomLabel', () => {
  it('labels each room', () => {
    expect(roomLabel({ kind: 'home' })).toBe('🏠 Home');
    expect(roomLabel({ kind: 'devops' })).toBe('🛠 Server');
    expect(roomLabel({ kind: 'project', slug: 'todo' })).toBe('📦 todo');
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
