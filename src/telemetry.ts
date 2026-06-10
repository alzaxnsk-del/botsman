import crypto from 'node:crypto';
import { logger } from './logger.js';
import type { Store } from './db.js';
import type { BotsmanConfig } from './types.js';

/**
 * Anonymous opt-in telemetry (§4 EPIC F). Strictly OFF by default; enabled
 * only if the user said yes during setup (config.telemetry.enabled=true).
 * Sends only lifecycle facts — never code, prompts or project content:
 *   install, first_deploy, return_after_7d.
 *
 * Honesty note: there is NO default collection endpoint. Without an explicit
 * telemetry.endpoint in the config, events are only recorded locally (logs +
 * kv markers) — nothing leaves the server, and the hypothesis metrics can be
 * read from `~/.botsman/botsman.db` (kv keys installed_at / first_deploy /
 * last_activity).
 */
export class Telemetry {
  constructor(private store: Store, private config: BotsmanConfig) {}

  private installId(): string {
    let id = this.store.kvGet('install_id');
    if (!id) {
      id = crypto.randomUUID();
      this.store.kvSet('install_id', id);
    }
    return id;
  }

  private async send(event: string): Promise<void> {
    if (!this.config.telemetry.enabled) return;
    const endpoint = this.config.telemetry.endpoint;
    if (!endpoint) {
      logger.info('telemetry event (no endpoint configured, recorded locally only)', { event });
      return;
    }
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, install_id: this.installId(), ts: new Date().toISOString() }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      logger.debug('telemetry send failed (ignored)', { error: (e as Error).message });
    }
  }

  async onInstall(): Promise<void> {
    if (this.store.kvGet('telemetry_install_sent')) return;
    await this.send('install');
    this.store.kvSet('telemetry_install_sent', '1');
    this.store.kvSet('installed_at', new Date().toISOString());
  }

  async onFirstDeploy(): Promise<void> {
    if (this.store.kvGet('telemetry_first_deploy_sent')) return;
    await this.send('first_deploy');
    this.store.kvSet('telemetry_first_deploy_sent', '1');
  }

  /** Called on any user activity; fires return_after_7d once if ≥7 days since install. */
  async onActivity(): Promise<void> {
    this.store.kvSet('last_activity', new Date().toISOString());
    if (this.store.kvGet('telemetry_return_sent')) return;
    const installedAt = this.store.kvGet('installed_at');
    if (!installedAt) return;
    const days = (Date.now() - Date.parse(installedAt)) / 86_400_000;
    if (days >= 7) {
      await this.send('return_after_7d');
      this.store.kvSet('telemetry_return_sent', '1');
    }
  }
}
