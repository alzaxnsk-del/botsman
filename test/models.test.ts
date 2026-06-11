import { describe, it, expect } from 'vitest';
import { MODEL_CHOICES, isModelId, modelLabel, DEFAULT_MODEL } from '../src/agent/models.js';

describe('model catalog', () => {
  it('offers the three tiers with the default among them', () => {
    expect(MODEL_CHOICES.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(isModelId(DEFAULT_MODEL)).toBe(true);
  });

  it('isModelId guards against bad input', () => {
    expect(isModelId('opus')).toBe(true);
    expect(isModelId('sonnet')).toBe(true);
    expect(isModelId('gpt-4')).toBe(false);
    expect(isModelId('')).toBe(false);
  });

  it('modelLabel falls back gracefully', () => {
    expect(modelLabel('opus')).toContain('Opus');
    expect(modelLabel(undefined)).toBe('default');
    expect(modelLabel('custom-id')).toBe('custom-id');
  });
});
