import http from 'node:http';
import { logger } from './logger.js';
import type { Orchestrator } from './orchestrator.js';

export const CONTROL_PORT = 8366;

/**
 * Control API: used by git post-receive hooks (push-to-deploy, AC-E1) and as
 * a daemon healthcheck. Published on the host as 127.0.0.1 only, but the
 * daemon is attached to project networks (for smoke-checks), so deployed
 * services could reach this port too — hence every mutating endpoint requires
 * the shared token (§5). The token lives in ~/.botsman/control.token and is
 * baked into the hooks; service containers have no access to either.
 */
export function startControlServer(
  orchestrator: Orchestrator,
  token: string,
  onPushDeployed: (slug: string, ok: boolean, message: string) => void,
  port = CONTROL_PORT,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const pushMatch = url.match(/^\/hooks\/push\/([a-z0-9-]{1,40})$/);
    if (req.method === 'POST' && pushMatch) {
      if (req.headers['x-botsman-token'] !== token) {
        logger.warn('control api: rejected request with bad token', { url });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
        return;
      }
      const slug = pushMatch[1];
      logger.info('push-to-deploy hook received', { slug });
      // Respond immediately; the deploy runs async and the owner is notified in Telegram.
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queued: slug }));
      void orchestrator
        .enqueue('redeploy', 'git push', () => {}, slug)
        .then((o) => onPushDeployed(slug, o.ok, o.ok ? `✅ ${slug}: задеплоил из git push.\n${o.url ?? ''}` : `❌ ${slug}: деплой из git push не удался:\n${o.error}`));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, '0.0.0.0'); // host mapping restricts public exposure to 127.0.0.1
  logger.info('control server listening', { port });
  return server;
}
