import path from 'node:path';
import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { logger } from '../logger.js';
import { buildSystemPrompt } from './systemPrompt.js';
import type { AgentRunInput, AgentRunResult, CodingAgent } from './CodingAgent.js';

export interface ClaudeCodeAgentOptions {
  docker: Dockerode;
  /** Pay-per-use Anthropic API key (BYO-key). One of apiKey/oauthToken is required. */
  apiKey?: string;
  /** Claude subscription token from `claude setup-token` (sk-ant-oat…). */
  oauthToken?: string;
  /** Image with the claude CLI inside; defaults to the botsman image itself. */
  image?: string;
  /** HOST path of the projects dir — docker bind mounts need host paths, not daemon paths. */
  hostProjectsDir: string;
  /** Hard cap on agentic turns per task (AC-F2). */
  maxTurns?: number;
  /** Hard wall-clock cap per task in ms (AC-F2). */
  timeoutMs?: number;
  model?: string;
  /** Service internal port — used in the system prompt contract. */
  port: number;
  dbEnv: Record<string, string>;
}

export const AGENT_LABEL = 'botsman.agent';

/**
 * Runs Claude Code headless in a DEDICATED throwaway container (§5 isolation):
 * the only mount is the project directory; no docker socket, no Botsman
 * config/db, and no project networks (default bridge → internet egress only,
 * isolated from caddy/postgres/daemon). Even a fully prompt-injected agent is
 * confined to its own project files. Hard timeout + max-turns cap protect
 * against runaway loops and token burn (AC-F2).
 */
export class ClaudeCodeAgent implements CodingAgent {
  constructor(private opts: ClaudeCodeAgentOptions) {
    if (!opts.apiKey && !opts.oauthToken) {
      throw new Error('ClaudeCodeAgent needs an apiKey or an oauthToken');
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const started = Date.now();
    const maxTurns = this.opts.maxTurns ?? 60;
    // 12 min leaves room for build+deploy inside the 15-min budget (AC-B4).
    const timeoutMs = this.opts.timeoutMs ?? 12 * 60 * 1000;
    const image = this.opts.image ?? 'botsman';
    const slug = path.basename(input.projectDir);
    const hostDir = `${this.opts.hostProjectsDir.replace(/\/+$/, '')}/${slug}`;

    const systemPrompt = buildSystemPrompt({
      mode: input.mode,
      port: this.opts.port,
      dbEnv: this.opts.dbEnv,
    });
    const contextBlock = input.context?.length ? `\n\nContext:\n${input.context.join('\n')}` : '';
    const prompt = `${input.instruction}${contextBlock}`;

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
      '--append-system-prompt', systemPrompt,
      // Headless: no human to approve tool calls. Safety comes from the
      // container boundary (only /work is mounted), not interactive prompts.
      '--dangerously-skip-permissions',
    ];
    if (this.opts.model) args.push('--model', this.opts.model);

    logger.info('agent run start', { mode: input.mode, slug, image, maxTurns, timeoutMs });

    let container: Dockerode.Container | null = null;
    try {
      container = await this.opts.docker.createContainer({
        Image: image,
        // The botsman image's entrypoint is the daemon — override with the CLI.
        Entrypoint: ['claude'],
        Cmd: args,
        WorkingDir: '/work',
        User: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        Env: [
          // Subscription token wins over the API key when both are set.
          ...(this.opts.oauthToken
            ? [`CLAUDE_CODE_OAUTH_TOKEN=${this.opts.oauthToken}`]
            : [`ANTHROPIC_API_KEY=${this.opts.apiKey}`]),
          'HOME=/tmp/agent-home', // ephemeral; nothing persists between runs
          'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        ],
        Labels: { [AGENT_LABEL]: slug },
        HostConfig: {
          Binds: [`${hostDir}:/work`],
          NetworkMode: 'bridge', // NOT botsman/project networks (§5)
          Memory: 2 * 1024 * 1024 * 1024,
          NanoCpus: 1_000_000_000,
          PidsLimit: 512,
          SecurityOpt: ['no-new-privileges:true'],
          CapDrop: ['ALL'],
        },
      });

      const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const outPT = new PassThrough().on('data', (c: Buffer) => outChunks.push(c));
      const errPT = new PassThrough().on('data', (c: Buffer) => errChunks.push(c));
      this.opts.docker.modem.demuxStream(attachStream, outPT, errPT);

      await container.start();

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void container!.kill().catch(() => {});
      }, timeoutMs);
      const status = await container.wait();
      clearTimeout(timer);

      const durationMs = Date.now() - started;
      if (timedOut) {
        return {
          ok: false,
          summary: '',
          error: `Agent timed out after ${formatDuration(timeoutMs)} (hard cap). Try a simpler or more specific instruction.`,
          durationMs,
        };
      }
      return interpretAgentOutput(
        status.StatusCode,
        Buffer.concat(outChunks).toString('utf8'),
        Buffer.concat(errChunks).toString('utf8'),
        maxTurns,
        durationMs,
      );
    } catch (e) {
      return {
        ok: false,
        summary: '',
        error: `Failed to start the agent container (image ${image}): ${(e as Error).message}`,
        durationMs: Date.now() - started,
      };
    } finally {
      if (container) await container.remove({ force: true }).catch(() => {});
    }
  }
}

export function interpretAgentOutput(
  exitCode: number,
  stdout: string,
  stderr: string,
  maxTurns: number,
  durationMs: number,
): AgentRunResult {
  const parsed = parseClaudeJson(stdout);
  if (exitCode !== 0 && !parsed) {
    return {
      ok: false, summary: '',
      error: `Coding agent exited with code ${exitCode}: ${truncate(stderr || stdout, 500)}`,
      durationMs,
    };
  }
  if (parsed?.is_error || parsed?.subtype === 'error_max_turns') {
    return {
      ok: false,
      summary: parsed.result ?? '',
      error: parsed.subtype === 'error_max_turns'
        ? `Agent hit the ${maxTurns}-turn cap without finishing. Try splitting the request into smaller steps.`
        : `Agent reported an error: ${truncate(parsed.result ?? 'unknown', 500)}`,
      costUsd: parsed.total_cost_usd,
      durationMs,
    };
  }
  return {
    ok: true,
    summary: truncate(parsed?.result ?? 'Done.', 1500),
    costUsd: parsed?.total_cost_usd,
    durationMs,
  };
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
}

/** `claude -p --output-format json` prints a single JSON object on stdout. */
export function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Tolerate stray log lines before/after the JSON object.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as ClaudeJsonResult;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}
