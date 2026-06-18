import { describe, it, expect } from 'vitest';
import { homeStatusLines, homeKeyboard, degradedNoneMessage } from '../src/gateway/home.js';
import { opLiteral } from '../src/gateway/devops.js';

describe('homeStatusLines', () => {
  it('reachable router + projects with a container down', () => {
    const text = homeStatusLines({
      projects: { live: 2, down: 1, total: 3 },
      llm: { reachable: true },
      llmConfigured: true,
      preflightWarnings: 0,
    }).join('\n');
    expect(text).toContain('2 live');
    expect(text).toContain('1 container down');
    expect(text).toContain('AI router: reachable');
  });

  it('unreachable router shows the error + remediation, and warning count', () => {
    const text = homeStatusLines({
      projects: { live: 0, down: 0, total: 0 },
      llm: { reachable: false, lastError: 'HTTP 429' },
      llmConfigured: true,
      preflightWarnings: 2,
    }).join('\n');
    expect(text).toContain('No projects yet');
    expect(text).toContain('unreachable');
    expect(text).toContain('HTTP 429');
    expect(text).toContain('Setup'); // remediation hint
    expect(text).toContain('2 startup warnings');
  });

  it('not-configured router points at Setup', () => {
    const text = homeStatusLines({
      projects: { live: 1, down: 0, total: 1 },
      llm: null,
      llmConfigured: false,
      preflightWarnings: 0,
    }).join('\n');
    expect(text).toContain('not configured');
  });
});

describe('homeKeyboard', () => {
  it('has exactly the five home:* command buttons', () => {
    const buttons = homeKeyboard().inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(buttons).toEqual(['home:metrics', 'home:projects', 'home:update', 'home:setup', 'home:clone']);
  });
});

describe('degradedNoneMessage', () => {
  it('returns the AI-down message only when the router is unreachable', () => {
    expect(degradedNoneMessage({ reachable: false })).toContain("couldn't reach the AI router");
    expect(degradedNoneMessage({ reachable: true })).toBeNull();
    expect(degradedNoneMessage(null)).toBeNull();
  });
});

describe('opLiteral', () => {
  it('self_update is a host-level mutating op with no slug (drives the double-confirm)', () => {
    expect(opLiteral('self_update')).toEqual({
      op: 'self_update',
      slug: undefined,
      mutating: true,
      hostLevel: true,
      humanSummary: expect.stringContaining('Update Botsman'),
    });
  });

  it('keeps the slug for slug-bearing ops, drops it for slugless ones', () => {
    expect(opLiteral('service_logs', 'todo').slug).toBe('todo');
    expect(opLiteral('host_metrics', 'todo').slug).toBeUndefined();
  });
});
