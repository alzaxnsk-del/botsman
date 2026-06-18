import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/db.js';
import {
  getFocus, setFocus, clearFocus, detectRoomSwitch, detectProjectAction, projectKeyboard,
  detectServerAction, serverKeyboard, inServerRoom, setServerRoom, clearServerRoom,
} from '../src/gateway/rooms.js';
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

describe('detectProjectAction', () => {
  it('detects the project-keyboard buttons', () => {
    expect(detectProjectAction('🚪 Exit')).toBe('exit');
    expect(detectProjectAction('🔍 Review')).toBe('review');
    expect(detectProjectAction('📋 Logs')).toBe('logs');
    expect(detectProjectAction('↩️ Rollback')).toBe('rollback');
    expect(detectProjectAction('💻 Claude Code')).toBe('code');
  });

  it('accepts bare-word and Russian synonyms', () => {
    expect(detectProjectAction('выйти')).toBe('exit');
    expect(detectProjectAction('ревью')).toBe('review');
    expect(detectProjectAction('логи')).toBe('logs');
    expect(detectProjectAction('откат')).toBe('rollback');
  });

  it('does NOT hijack a multi-word edit that merely mentions a keyword', () => {
    expect(detectProjectAction('review the login flow and fix the bug')).toBeNull();
    expect(detectProjectAction('add a logs page')).toBeNull();
    expect(detectProjectAction('rollback the header color change')).toBeNull();
    expect(detectProjectAction('make it dark')).toBeNull();
  });
});

describe('projectKeyboard', () => {
  it('has exactly the five project-action buttons', () => {
    const labels = projectKeyboard().keyboard.flat().map((b) => (b as { text: string }).text);
    expect(labels).toEqual(['🚪 Exit', '🔍 Review', '💻 Claude Code', '📋 Logs', '↩️ Rollback']);
  });
});

describe('detectServerAction', () => {
  it('detects the server-keyboard buttons', () => {
    expect(detectServerAction('📊 Load')).toBe('load');
    expect(detectServerAction('🐳 Containers')).toBe('containers');
    expect(detectServerAction('🧹 Clean disk')).toBe('clean-disk');
    expect(detectServerAction('🔁 Restart proxy')).toBe('restart-proxy');
    expect(detectServerAction('⬆️ Update')).toBe('update');
  });

  it('accepts bare-word / Russian synonyms but not multi-word instructions', () => {
    expect(detectServerAction('нагрузка')).toBe('load');
    expect(detectServerAction('обновить')).toBe('update');
    expect(detectServerAction('update the readme please')).toBeNull();
    expect(detectServerAction('clean up the homepage')).toBeNull();
  });
});

describe('serverKeyboard', () => {
  it('has exactly the six server-action buttons', () => {
    const labels = serverKeyboard().keyboard.flat().map((b) => (b as { text: string }).text);
    expect(labels).toEqual(['🚪 Exit', '📊 Load', '🐳 Containers', '🧹 Clean disk', '🔁 Restart proxy', '⬆️ Update']);
  });
});

describe('server room state', () => {
  it('round-trips the sticky server/admin context', () => {
    expect(inServerRoom(store, 1)).toBe(false);
    setServerRoom(store, 1);
    expect(inServerRoom(store, 1)).toBe(true);
    clearServerRoom(store, 1);
    expect(inServerRoom(store, 1)).toBe(false);
  });

  it('keeps the server context separate per chat', () => {
    setServerRoom(store, 1);
    expect(inServerRoom(store, 2)).toBe(false);
  });
});
