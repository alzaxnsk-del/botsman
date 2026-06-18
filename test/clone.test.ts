import { describe, it, expect } from 'vitest';
import { inferSshUser, localDevInstructions, cloneUrl } from '../src/clone.js';

describe('inferSshUser', () => {
  it('infers the SSH user from the install path', () => {
    expect(inferSshUser('/root/.botsman')).toBe('root');
    expect(inferSshUser('/root')).toBe('root');
    expect(inferSshUser('/home/alice/.botsman')).toBe('alice');
    expect(inferSshUser('/home/bob/data/.botsman')).toBe('bob');
  });

  it('falls back to a placeholder for an unrecognised path', () => {
    expect(inferSshUser('/opt/botsman')).toBe('<user>');
    expect(inferSshUser('/var/lib/botsman')).toBe('<user>');
  });
});

describe('cloneUrl', () => {
  it('builds the scp-style target, filling user from the path and trimming slashes', () => {
    expect(cloneUrl({ slug: 'todo', hostHome: '/root/.botsman/', host: '203.0.113.7' }))
      .toBe('root@203.0.113.7:/root/.botsman/repos/todo.git');
    expect(cloneUrl({ slug: 'todo', hostHome: '/opt/botsman', host: '<server>' }))
      .toBe('<user>@<server>:/opt/botsman/repos/todo.git');
  });
});

describe('localDevInstructions', () => {
  it('builds a (nearly) copy-paste clone command with the real host/user/path', () => {
    const text = localDevInstructions({
      slug: 'todo', hostHome: '/root/.botsman', host: '203.0.113.7', domain: 'todo.apps.example.com',
    });
    expect(text).toContain('git clone root@203.0.113.7:/root/.botsman/repos/todo.git');
    expect(text).toContain('cd todo && claude');
    expect(text).toContain('git push');
    expect(text).toContain('https://todo.apps.example.com/');
    // Known user → no <user> placeholder.
    expect(text).not.toContain('<user>');
  });

  it('notes the placeholder when the SSH user is unknown', () => {
    const text = localDevInstructions({
      slug: 'todo', hostHome: '/opt/botsman', host: '<server>', domain: 'todo.apps.example.com',
    });
    expect(text).toContain('<user>@<server>');
    expect(text).toContain('Replace <user> with your SSH login');
  });
});
