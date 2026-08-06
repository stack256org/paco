/**
 * Derive a preview hostname from a chat id.
 *
 * The slug is the chat id itself, sanitized for DNS — never a hash. Chat ids
 * are nanoid-shaped and already unguessable, so hashing would buy no
 * additional secrecy while losing something real: a stable, readable slug
 * means a shared preview link keeps working across restarts (a hash seeded
 * with anything server-side would not survive them), and an operator staring
 * at Traefik's routers or a certificate list can tell which chat a hostname
 * belongs to. The id is the identity; this just makes it DNS-legal.
 */

/**
 * A lowercase, DNS-safe label derived from a chat id.
 *
 * nanoid's alphabet (`A-Za-z0-9_-`) includes uppercase and `_`, neither valid
 * in a DNS label, so this lowercases the id and replaces anything outside
 * `[a-z0-9-]` with `-`, then trims leading and trailing hyphens (a label may
 * not start or end with one).
 */
export function previewSlug(chatId: string): string {
  return chatId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * The full hostname a chat's preview is reachable at, or `null` when no
 * preview base domain is configured — there is then nowhere to route it.
 */
export function previewHostname(
  chatId: string,
  baseDomain: string | null,
): string | null {
  const trimmed = baseDomain?.trim();
  if (!trimmed) {
    return null;
  }

  return `${previewSlug(chatId)}.${trimmed}`;
}

/**
 * The inverse of `previewHostname`: recover a chat's slug from a full host,
 * given the configured base domain — or `null` when the host does not
 * actually belong to that domain.
 *
 * This is the check `/api/preview-auth` (`route.ts`) and its `/grant`
 * companion both need before trusting anything derived from an incoming
 * `Host`/`X-Forwarded-Host` value. Taking just the leading label
 * (`host.split(".")[0]`) — what the route used to do — accepts *any* host
 * with at least one dot: a request claiming to be
 * `<real-slug>.attacker.example` would extract the same slug as the
 * legitimate `<real-slug>.<configured-base-domain>`, without the base
 * domain ever being consulted. Requiring the full `.<baseDomain>` suffix is
 * what makes the extracted label trustworthy enough to look up.
 */
export function previewSlugFromHost(
  host: string,
  baseDomain: string | null,
): string | null {
  const trimmedBase = baseDomain?.trim();
  if (!trimmedBase) {
    return null;
  }

  const suffix = `.${trimmedBase}`;
  if (!host.endsWith(suffix)) {
    return null;
  }

  const label = host.slice(0, -suffix.length);
  return label.length > 0 ? label : null;
}
