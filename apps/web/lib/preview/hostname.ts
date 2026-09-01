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
