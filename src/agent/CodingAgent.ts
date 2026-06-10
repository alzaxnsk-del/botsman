/**
 * Abstraction over the coding agent (§3): a single implementation today
 * (ClaudeCodeAgent), but the interface keeps the orchestrator agnostic.
 */

export interface AgentRunInput {
  /** Absolute path to the project working directory. The agent must not touch anything outside it. */
  projectDir: string;
  /** The user's instruction, verbatim. */
  instruction: string;
  mode: 'create' | 'edit';
  /** Extra context lines (stack contract, port, db env vars, etc.). */
  context?: string[];
}

export interface AgentRunResult {
  ok: boolean;
  /** Short human-readable summary of what was done (shown to the user in Telegram). */
  summary: string;
  /** Why it failed, when ok=false (timeout, iteration cap, agent error). */
  error?: string;
  /** API spend for this run, when the agent reports it (shown to the user). */
  costUsd?: number;
  /** Wall-clock duration. */
  durationMs: number;
}

export interface CodingAgent {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
