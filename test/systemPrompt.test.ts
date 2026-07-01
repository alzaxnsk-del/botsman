import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

const opts = { port: 3000, dbEnv: { PGHOST: 'db', PGUSER: 'u' } };

describe('buildSystemPrompt', () => {
  it('forbids the agent from running git (create + edit), so the orchestrator owns commits', () => {
    for (const mode of ['create', 'edit'] as const) {
      const p = buildSystemPrompt({ mode, ...opts });
      expect(p).toMatch(/Do NOT run git/i);
      expect(p).toContain('git add/commit/push');
      // The WHY must be present so the model doesn't "helpfully" commit anyway.
      expect(p).toMatch(/deploy will skip your changes/i);
    }
  });

  it('read-only ask mode never mentions running git (it cannot write anyway)', () => {
    const p = buildSystemPrompt({ mode: 'ask', ...opts });
    expect(p).toContain('read-only');
    expect(p).not.toMatch(/git add/i);
  });
});
