#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Dockerode from 'dockerode';
import { logger } from './logger.js';
import { paths } from './paths.js';
import { configExists, loadConfig, missingSetup, ConfigError } from './config.js';
import { OnboardingBot, READY_NOTIFY_KEY } from './gateway/onboarding.js';
import { RESTART_NOTICE_KEY } from './types.js';
import { Store } from './db.js';
import { Telemetry } from './telemetry.js';
import { ClaudeCodeAgent } from './agent/ClaudeCodeAgent.js';
import { DEFAULT_MODEL } from './agent/models.js';
import { CaddyClient } from './deploy/caddy.js';
import { DockerDeployEngine, SERVICE_PORT } from './deploy/engine.js';
import { PostgresAdmin, dbEnvFor } from './deploy/postgres.js';
import { Orchestrator } from './orchestrator.js';
import { TelegramGateway } from './gateway/telegram.js';
import { startControlServer, startHealthServer, CONTROL_PORT } from './control.js';
import { preflight } from './preflight.js';
import { runSetupWizard } from './setup.js';
import { suggestSlugLLM, suggestSlugCLI } from './naming.js';
import { makeStructuredLlm } from './llm.js';
import { HostExec } from './hostExec.js';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'start';

  if (cmd === 'setup') {
    process.exit(await runSetupWizard());
  }
  if (cmd !== 'start') {
    console.error(`Unknown command: ${cmd}. Use "botsman setup" or "botsman start".`);
    process.exit(2);
  }

  if (!configExists()) {
    console.error(`Config not found (${paths.configFile()}). Run "botsman setup" first.`);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  for (const dir of [paths.projectsDir(), paths.reposDir(), paths.logsDir(), paths.screenshotsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // HOME points into the volume (runtime UID may differ from build UID).
  if (process.env.HOME && !fs.existsSync(process.env.HOME)) {
    fs.mkdirSync(process.env.HOME, { recursive: true });
  }
  logger.init();
  logger.info('botsman starting', { baseDomain: config.baseDomain ?? '(onboarding)' });

  const docker = new Dockerode({
    socketPath: config.docker?.socketPath ?? '/var/run/docker.sock',
  });

  // Console bootstrap gave us only the trust channel (bot token + owner ID)?
  // Then run the in-chat onboarding instead of the full daemon. When it
  // finishes, the process exits and the restart policy brings us back here
  // with a complete config.
  if (missingSetup(config).length > 0) {
    try {
      await docker.ping();
    } catch (e) {
      console.error(`Docker is unreachable (${(e as Error).message}). Check the socket mount.`);
      process.exit(1);
    }
    const store = new Store();
    const telemetry = new Telemetry(store, config);
    await telemetry.onInstall();
    const onboarding = new OnboardingBot(config.telegramBotToken, config.ownerIds, store);
    await onboarding.start();
    // Answer the installer's healthcheck so it reports success and points the
    // user to Telegram, instead of timing out with a scary error mid-onboarding.
    startHealthServer();
    logger.info('running in onboarding mode', { missing: missingSetup(config) });
    return; // long-polling keeps the process alive
  }
  const caddy = new CaddyClient(config.caddyAdminUrl ?? 'unix:/run/caddy/admin.sock');
  const agentImage = config.agent?.image ?? process.env.BOTSMAN_IMAGE ?? 'botsman';

  const pre = await preflight(config, docker, caddy, agentImage);
  if (pre.fatal.length) {
    console.error('Cannot start:\n  - ' + pre.fatal.join('\n  - '));
    process.exit(1);
  }

  const store = new Store();
  const telemetry = new Telemetry(store, config);
  await telemetry.onInstall();

  const pgSuperPassword = process.env.BOTSMAN_PG_PASSWORD ?? 'botsman';
  const pgAdmin = new PostgresAdmin(docker, pgSuperPassword);

  // The agent runs in throwaway containers; binds need HOST paths (§5 isolation).
  const hostProjectsDir = process.env.BOTSMAN_HOST_DIR
    ? `${process.env.BOTSMAN_HOST_DIR.replace(/\/+$/, '')}/projects`
    : paths.projectsDir();

  const agent = new ClaudeCodeAgent({
    docker,
    apiKey: config.anthropicApiKey,
    oauthToken: config.claudeCodeOauthToken,
    image: agentImage,
    hostProjectsDir,
    maxTurns: config.agent?.maxTurns,
    timeoutMs: config.agent?.timeoutMs,
    // Quality matters most for chat-to-deploy → Opus unless the owner picked otherwise.
    model: config.agent?.model ?? DEFAULT_MODEL,
    port: SERVICE_PORT,
    // Placeholder var names for the system prompt; real values are injected per-project.
    dbEnv: dbEnvFor({ dbName: 'app_<slug>', dbUser: 'u_<slug>', dbPassword: '<runtime>' }),
  });

  // Shared secret for the control API: push hooks know it, service containers don't.
  const tokenFile = path.join(paths.home(), 'control.token');
  let controlToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!controlToken) {
    controlToken = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, controlToken + '\n', { mode: 0o600 });
  }

  const deployEngine = new DockerDeployEngine(docker, caddy, config.baseDomain!);
  const controlUrl = process.env.BOTSMAN_CONTROL_URL ?? `http://127.0.0.1:${CONTROL_PORT}`;
  // LLM-based slug naming: Messages API with an API key, a one-turn claude
  // CLI call with a subscription token; heuristic fallback inside on errors.
  const apiKey = config.anthropicApiKey;
  const oauth = config.claudeCodeOauthToken;
  const suggestName = apiKey
    ? (description: string) => suggestSlugLLM(apiKey, description)
    : oauth
      ? (description: string) => suggestSlugCLI(oauth, description)
      : undefined;
  const orchestrator = new Orchestrator(
    store, agent, deployEngine, pgAdmin, config.baseDomain!, controlUrl, controlToken, telemetry,
    suggestName,
  );

  const reconcileNotes = await orchestrator.reconcileOnStartup(docker);

  // Conversational rooms: a structured LLM (DevOps + project routers) and the
  // privileged host-exec helper. structuredLlm uses the same auth as the namer.
  const structuredLlm = makeStructuredLlm({ apiKey, oauthToken: oauth });
  const hostExec = new HostExec(docker);
  const hostRepoDir = process.env.BOTSMAN_REPO_DIR ?? '/opt/botsman';

  const gateway = new TelegramGateway(
    config.telegramBotToken, config.ownerIds, orchestrator, store, deployEngine, telemetry,
    docker, hostExec, hostRepoDir, structuredLlm,
  );

  startControlServer(orchestrator, controlToken, (slug, _ok, message) => void gateway.notifyOwner(message));
  await gateway.start();

  if (pre.warnings.length) {
    await gateway.notifyOwner('⚠️ Botsman started with warnings:\n- ' + pre.warnings.join('\n- '));
  }
  if (reconcileNotes.length) {
    await gateway.notifyOwner('ℹ️ Cleaned up state after a restart:\n- ' + reconcileNotes.join('\n- '));
  }
  // First start after in-chat onboarding — tell the owner we are ready to work.
  if (store.kvGet(READY_NOTIFY_KEY)) {
    store.kvSet(READY_NOTIFY_KEY, '');
    await gateway.notifyOwner(
      '🚀 Ready! Describe your first service, for example:\n' +
      '"make a TODO service with a task list and the ability to mark tasks done"\n\n' +
      'The buttons below are shortcuts: 🏠 reset · 🛠 server · 📦 focus a project.',
      true, // surface the persistent room keyboard on the first full-mode message
    );
  }
  // Confirm we're back after any self-restart (model/telemetry change, self-update),
  // so a restart never looks like the bot died.
  const backNotice = store.kvGet(RESTART_NOTICE_KEY);
  if (backNotice) {
    store.kvSet(RESTART_NOTICE_KEY, '');
    await gateway.notifyOwner(backNotice, true);
  }
  logger.info('botsman started');

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await gateway.stop().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('Fatal:', (e as Error).stack ?? e);
  process.exit(1);
});
