/**
 * Project-domain validation (the "change a project's domain" feature). Scope:
 * a project's public host is always a SINGLE subdomain label under the base
 * (`<label>.<base>`), because the wildcard `*.<base>` DNS record only covers one
 * level — `a.b.<base>` would have neither DNS nor a matching TLS cert. Pure:
 * DNS and Caddy-route checks happen in the caller (doctor.ts / engine.ts).
 */

/** Drop the first DNS label: "todo.apps.example.com" → "apps.example.com". A
 *  project host is `<label>.<base>` by construction (slugs/labels never contain
 *  a dot), so the base is everything after the first dot. */
export function baseOf(host: string): string {
  const i = host.indexOf('.');
  return i === -1 ? host : host.slice(i + 1);
}

// A single DNS label: letters, digits and hyphens; no leading/trailing hyphen.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type DomainResult =
  | { ok: true; host: string }
  | { ok: false; reason: string };

/**
 * Validate + normalize a requested domain for a project against its base and
 * the other projects' domains. Accepts a bare label ("landing") or a full host
 * ("landing.botsman.dev", with or without scheme/trailing slash). Rejects
 * external domains and multi-level subdomains (out of scope: subdomains only).
 *
 * @param takenBy returns the slug already serving `host` (excluding self), or null.
 */
export function resolveProjectDomain(
  input: string,
  baseDomain: string,
  currentHost: string,
  takenBy: (host: string) => string | null,
): DomainResult {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.+$/, '');
  if (!s) return { ok: false, reason: 'no domain given.' };

  const base = baseDomain.trim().toLowerCase();
  if (s === base) {
    return { ok: false, reason: `\`${base}\` is the base domain itself — pick a subdomain like \`landing.${base}\`.` };
  }

  let label: string;
  if (s.endsWith(`.${base}`)) {
    label = s.slice(0, s.length - base.length - 1);
  } else if (!s.includes('.')) {
    label = s; // bare label → <label>.<base>
  } else {
    return {
      ok: false,
      reason: `it must be a subdomain of \`${base}\` (e.g. \`landing.${base}\`). Bringing your own external domain isn't supported yet.`,
    };
  }

  if (label.includes('.')) {
    return {
      ok: false,
      reason: `only one level under \`${base}\` is supported — the wildcard \`*.${base}\` doesn't cover \`${label}.${base}\`.`,
    };
  }
  if (!LABEL_RE.test(label)) {
    return {
      ok: false,
      reason: `\`${label}\` isn't a valid subdomain (use letters, digits and hyphens; no leading or trailing hyphen).`,
    };
  }

  const host = `${label}.${base}`;
  if (host === currentHost.trim().toLowerCase()) {
    return { ok: false, reason: `that's already its address (\`${host}\`).` };
  }
  const owner = takenBy(host);
  if (owner) {
    return { ok: false, reason: `\`${host}\` is already used by the project \`${owner}\`.` };
  }
  return { ok: true, host };
}
