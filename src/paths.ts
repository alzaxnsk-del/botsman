import os from 'node:os';
import path from 'node:path';

/**
 * All Botsman state lives under one root (default ~/.botsman), overridable via
 * BOTSMAN_HOME — used by the Docker image (mounted volume) and by tests.
 */
export function botsmanHome(): string {
  return process.env.BOTSMAN_HOME ?? path.join(os.homedir(), '.botsman');
}

export const paths = {
  home: () => botsmanHome(),
  configFile: () => path.join(botsmanHome(), 'config.json'),
  dbFile: () => path.join(botsmanHome(), 'botsman.db'),
  projectsDir: () => path.join(botsmanHome(), 'projects'),
  reposDir: () => path.join(botsmanHome(), 'repos'),
  logsDir: () => path.join(botsmanHome(), 'logs'),
  screenshotsDir: () => path.join(botsmanHome(), 'screenshots'),
  projectDir: (slug: string) => path.join(botsmanHome(), 'projects', slug),
  bareRepo: (slug: string) => path.join(botsmanHome(), 'repos', `${slug}.git`),
};
