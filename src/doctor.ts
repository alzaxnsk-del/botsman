import dns from 'node:dns/promises';
import type { Store } from './db.js';
import type { DeployEngine } from './deploy/engine.js';

/**
 * In-chat diagnostics (/doctor): the owner should not need a console for
 * typical failures. Each check explains itself and maps to a one-tap fix
 * where one exists (restart proxy to retry TLS issuance, restart the app).
 */

/** Cloudflare IPv4 ranges — a proxied (orange cloud) record resolves here instead of the origin. */
const CF_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

const CF_RANGES: Array<[number, number]> = CF_CIDRS.map((cidr) => {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const start = (ipToInt(ip) & mask) >>> 0;
  return [start, (start | (~mask >>> 0)) >>> 0];
});

export function isCloudflareIp(ip: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
  const n = ipToInt(ip);
  return CF_RANGES.some(([start, end]) => n >= start && n <= end);
}

export function classifyPublicError(message: string): 'tls' | 'unreachable' | 'other' {
  if (/certificate|\bcert\b|ssl|tls|handshake|alert/i.test(message)) return 'tls';
  if (/refused|timed?\s*out|timeout|ENOTFOUND|EHOSTUNREACH|ECONNRESET|network|fetch failed/i.test(message)) {
    return 'unreachable';
  }
  return 'other';
}

let cachedPublicIp: string | null | undefined;
/** This server's public IPv4 (cached); null when undetectable. */
export async function serverPublicIp(): Promise<string | null> {
  if (cachedPublicIp !== undefined) return cachedPublicIp;
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5_000) });
    const ip = (await res.text()).trim();
    cachedPublicIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    cachedPublicIp = null;
  }
  return cachedPublicIp;
}

/** TLS-readiness classification of a host's resolved A-records. */
export type DnsStatus = 'ok' | 'no-dns' | 'cloudflare' | 'wrong-ip';

/**
 * Classify resolved IPs for TLS-readiness (pure, so it's unit-tested without
 * real DNS): does the host resolve at all, is it behind a Cloudflare proxy
 * (orange cloud — breaks Let's Encrypt issuance), and does it point at THIS
 * server? Shared by /doctor, onboarding's domain step and the change-domain flow.
 */
export function classifyDnsIps(ips: string[], serverIp: string | null): DnsStatus {
  if (!ips.length) return 'no-dns';
  if (ips.some(isCloudflareIp)) return 'cloudflare';
  if (serverIp && !ips.includes(serverIp)) return 'wrong-ip';
  return 'ok';
}

export interface HostDnsProbe {
  status: DnsStatus;
  /** Resolved A-records (empty when the host doesn't resolve). */
  ips: string[];
  /** This server's public IP, or null when undetectable. */
  serverIp: string | null;
}

/** Resolve `host` and classify it for TLS-readiness (the IO wrapper around
 *  classifyDnsIps). Never throws — an unresolvable host comes back as 'no-dns'. */
export async function probeHostDns(host: string): Promise<HostDnsProbe> {
  let ips: string[] = [];
  try {
    ips = await dns.resolve4(host);
  } catch { /* no-dns */ }
  const serverIp = await serverPublicIp().catch(() => null);
  return { status: classifyDnsIps(ips, serverIp), ips, serverIp };
}

export type FixId = 'proxy' | 'app' | 'recheck';

export interface DoctorReport {
  lines: string[];
  fixes: FixId[];
  healthy: boolean;
}

export async function runDoctor(
  slug: string,
  store: Store,
  engine: DeployEngine,
): Promise<DoctorReport | null> {
  const project = store.getProject(slug);
  if (!project) return null;
  const lines: string[] = [];
  const fixes = new Set<FixId>();
  let healthy = true;

  const running = await engine.containerRunning(slug).catch(() => false);
  if (running) {
    lines.push('✅ Service container is running');
    const internal = await engine.probeInternal(slug);
    if (internal.ok) {
      lines.push('✅ Service answers inside the network (HTTP 200)');
    } else {
      lines.push(`❌ Service does not answer internally: ${internal.detail}. Check /logs ${slug}.`);
      fixes.add('app');
      healthy = false;
    }
  } else {
    lines.push('❌ Service container is NOT running');
    fixes.add('app');
    healthy = false;
  }

  const baseDomain = project.domain.startsWith(`${slug}.`)
    ? project.domain.slice(slug.length + 1)
    : project.domain;
  let ips: string[] = [];
  try {
    ips = await dns.resolve4(project.domain);
  } catch { /* handled below */ }
  if (!ips.length) {
    lines.push(`❌ DNS: ${project.domain} does not resolve. Create a wildcard A-record *.${baseDomain} → this server's IP at your DNS provider.`);
    healthy = false;
  } else if (ips.some(isCloudflareIp)) {
    lines.push(`⚠️ DNS: ${project.domain} → ${ips[0]} — that's a Cloudflare proxy address. Switch the record to "DNS only" (grey cloud), then tap "Reissue TLS".`);
    fixes.add('proxy');
    healthy = false;
  } else {
    const myIp = await serverPublicIp();
    if (myIp && !ips.includes(myIp)) {
      lines.push(`⚠️ DNS: ${project.domain} → ${ips.join(', ')}, but this server's public IP is ${myIp}. Fix the record.`);
      healthy = false;
    } else {
      lines.push(`✅ DNS: ${project.domain} → ${ips[0]}`);
    }
  }

  try {
    const res = await fetch(`https://${project.domain}/`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 200) {
      lines.push('✅ Public HTTPS answers 200');
    } else {
      lines.push(`⚠️ Public HTTPS answers ${res.status} (expected 200)`);
      healthy = false;
    }
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    const msg = String(err.cause?.message ?? err.message);
    const kind = classifyPublicError(msg);
    if (kind === 'tls') {
      lines.push(`❌ HTTPS: TLS/certificate problem (${short(msg)}). Usually the certificate is not issued yet — tap "Reissue TLS".`);
      fixes.add('proxy');
    } else if (kind === 'unreachable') {
      lines.push(`❌ HTTPS: unreachable (${short(msg)}). Check that ports 80/443 are open and DNS points here.`);
    } else {
      lines.push(`❌ HTTPS: ${short(msg)}`);
    }
    healthy = false;
  }

  if (!healthy) fixes.add('recheck');
  return { lines, fixes: [...fixes], healthy };
}

function short(s: string): string {
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}
