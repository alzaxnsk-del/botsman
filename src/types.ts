/** Shared types across Botsman components. */

/** kv key: a message to post to the owner on the next full-mode startup, so a
 *  self-restart (model/telemetry change, self-update) confirms it's back. */
export const RESTART_NOTICE_KEY = 'restart_notice';

export type ProjectStatus =
  | 'creating'
  | 'building'
  | 'deploying'
  | 'live'
  | 'failed'
  | 'stopped';

export interface ProjectMeta {
  slug: string;
  name: string;
  description: string;
  status: ProjectStatus;
  domain: string;
  internalPort: number;
  currentCommit: string | null;
  currentImage: string | null;
  prevCommit: string | null;
  prevImage: string | null;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskKind = 'create' | 'edit' | 'rollback' | 'delete' | 'redeploy';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

export interface TaskRecord {
  id: number;
  projectSlug: string;
  kind: TaskKind;
  instruction: string;
  status: TaskStatus;
  summary: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Pipeline stages reported back to the user while a task runs. */
export type Stage =
  | 'accepted'
  | 'generating'
  | 'committing'
  | 'building'
  | 'deploying'
  | 'checking'
  | 'screenshot'
  | 'done'
  | 'failed';

export type StageReporter = (stage: Stage, detail?: string) => void;

export interface BotsmanConfig {
  telegramBotToken: string;
  /** Telegram user IDs allowed to talk to the bot (the owner). */
  ownerIds: number[];
  /**
   * Coding agent auth — exactly one of the two (oauth token wins if both):
   * anthropicApiKey: pay-per-use API key (sk-ant-api…);
   * claudeCodeOauthToken: Claude subscription token from `claude setup-token`
   * (sk-ant-oat…) — usage counts against the Pro/Max subscription limits.
   */
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  /**
   * e.g. "apps.example.com" — wildcard *.apps.example.com must point at this
   * server. Optional until onboarding (in the Telegram chat) completes.
   */
  baseDomain?: string;
  /** Strictly opt-in anonymous telemetry. Default false. */
  telemetry: {
    enabled: boolean;
    endpoint?: string;
  };
  /** Claude Code invocation tuning. */
  agent?: {
    /** Docker image with the claude CLI for agent runs (default: the botsman image). */
    image?: string;
    maxTurns?: number;
    timeoutMs?: number;
    model?: string;
  };
  /** Docker / proxy endpoints; defaults fit the docker-compose layout. */
  docker?: {
    socketPath?: string;
  };
  caddyAdminUrl?: string;
  /** Where ~/.botsman lives inside the daemon (defaults to $BOTSMAN_HOME or ~/.botsman). */
  dataDir?: string;
}
