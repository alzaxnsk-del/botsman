import http from 'node:http';
import { logger } from '../logger.js';

/**
 * Caddy Admin API client (§3): routes are managed dynamically, no restarts.
 * Each project gets one route identified by "@id botsman-<slug>"; adding the
 * route makes Caddy obtain a Let's Encrypt cert for the host automatically.
 *
 * Security (§5): in production the Admin API listens on a UNIX socket shared
 * with the daemon via a volume — it has no TCP listener at all, so deployed
 * (LLM-generated, semi-trusted) services on shared project networks cannot
 * reach it. Target "unix:/run/caddy/admin.sock" selects socket mode; an
 * http:// URL is still supported for development.
 */
export class CaddyClient {
  private socketPath: string | null;
  private baseUrl: string | null;

  constructor(target: string, private serverName = 'main') {
    if (target.startsWith('unix:')) {
      this.socketPath = target.slice('unix:'.length);
      this.baseUrl = null;
    } else {
      this.socketPath = null;
      this.baseUrl = target.replace(/\/$/, '');
    }
  }

  routeId(slug: string): string {
    return `botsman-${slug}`;
  }

  buildRoute(slug: string, host: string, upstream: string): object {
    return {
      '@id': this.routeId(slug),
      match: [{ host: [host] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: upstream }],
        },
      ],
      terminal: true,
    };
  }

  /** Create or replace the route for a project, pointing at `containerName:port`. */
  async upsertRoute(slug: string, host: string, upstream: string): Promise<void> {
    const route = this.buildRoute(slug, host, upstream);
    // Replace-if-exists keeps this idempotent across redeploys.
    const existing = await this.request(`/id/${this.routeId(slug)}`, 'GET');
    if (existing.ok) {
      await this.requestOrThrow(`/id/${this.routeId(slug)}`, 'PATCH', route);
    } else {
      await this.requestOrThrow(
        `/config/apps/http/servers/${this.serverName}/routes`,
        'POST',
        route,
      );
    }
    logger.info('caddy route upserted', { slug, host, upstream });
  }

  async removeRoute(slug: string): Promise<void> {
    const res = await this.request(`/id/${this.routeId(slug)}`, 'DELETE');
    if (!res.ok && res.status !== 404 && res.status !== 500) {
      throw new Error(`Caddy: failed to remove route for ${slug}: ${res.status} ${res.body}`);
    }
  }

  async ping(): Promise<boolean> {
    const res = await this.request('/config/', 'GET');
    return res.ok;
  }

  private async request(
    path: string,
    method: string,
    body?: object,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const payload = body ? JSON.stringify(body) : undefined;
    if (this.socketPath) {
      return new Promise((resolve) => {
        const req = http.request(
          {
            socketPath: this.socketPath!,
            path,
            method,
            // Host must match an entry in admin.origins of caddy.json.
            headers: {
              Host: 'botsman',
              'Content-Type': 'application/json',
              ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
            timeout: 10_000,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () =>
              resolve({ ok: (res.statusCode ?? 500) < 300, status: res.statusCode ?? 0, body: data }));
          },
        );
        req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
        req.on('timeout', () => req.destroy(new Error('timeout')));
        if (payload) req.write(payload);
        req.end();
      });
    }
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) {
      return { ok: false, status: 0, body: (e as Error).message };
    }
  }

  private async requestOrThrow(path: string, method: string, body?: object): Promise<void> {
    const res = await this.request(path, method, body);
    if (!res.ok) {
      throw new Error(`Caddy Admin API ${method} ${path} failed: ${res.status} ${res.body}`);
    }
  }
}
