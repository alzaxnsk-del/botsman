/**
 * Model choices for the coding agent. Values are Claude Code `--model` aliases
 * (map to the latest of each tier), passed through to `claude -p --model …`.
 * Quality matters most for a chat-to-deploy agent, so Opus is the default/rec.
 */
export interface ModelChoice {
  id: 'opus' | 'sonnet' | 'haiku';
  label: string;
  blurb: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
  { id: 'opus', label: '🏆 Opus', blurb: 'best code quality · slower · uses more of your plan' },
  { id: 'sonnet', label: '⚖️ Sonnet', blurb: 'balanced · good quality · faster' },
  { id: 'haiku', label: '⚡ Haiku', blurb: 'fastest & lightest · simple tasks' },
];

export const DEFAULT_MODEL = 'opus';

export function isModelId(s: string): s is ModelChoice['id'] {
  return MODEL_CHOICES.some((m) => m.id === s);
}

export function modelLabel(id?: string): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.label ?? (id ?? 'default');
}
