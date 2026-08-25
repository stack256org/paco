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

/**
 * A design candidate's hostname, or `null` when no preview base domain is
 * configured — mirrors `previewHostname`'s own bail-out for the same reason.
 *
 * The convention is the chat's own preview slug with a `-d<n>` suffix
 * (`n` in 1..3, matching `DesignCandidate.index` in
 * `lib/design/candidates.ts`), so a candidate's preview lives one label away
 * from the chat's — e.g. `abc123.previews.example.com` (the chat) and
 * `abc123-d2.previews.example.com` (candidate 2) — rather than under an
 * unrelated hostname that would need its own access wiring.
 *
 * This is deliberately *not* collision-proof: a chat id whose own slug
 * happens to end in `-d1`, `-d2`, or `-d3` would produce a hostname
 * identical to some other chat's candidate preview. nanoid's alphabet makes
 * that astronomically unlikely in practice, and closing the gap completely
 * would mean reserving the `-d<n>` suffix shape from every chat id — not
 * worth doing for a preview hostname. Documented here rather than silently
 * assumed away, the same way `nginx-config.ts`'s header names its own known
 * gaps.
 */
export function candidatePreviewHostname(
  chatId: string,
  index: 1 | 2 | 3,
  baseDomain: string | null,
): string | null {
  const trimmed = baseDomain?.trim();
  if (!trimmed) {
    return null;
  }

  return `${previewSlug(chatId)}-d${index}.${trimmed}`;
}

/**
 * What a preview host's leading label (as returned by `previewSlugFromHost`)
 * resolves to: the owning chat's slug — exactly what
 * `findChatOwnerByPreviewSlug` (`lib/preview/authorize.ts`) looks up — plus,
 * for a design-candidate host, which candidate it is.
 */
export type PreviewHostSlug = {
  /** The slug `chats.previewSlug` stores for the owning chat. */
  chatSlug: string;
  /** `null` for the chat's own preview; 1..3 for a design candidate's. */
  candidateIndex: 1 | 2 | 3 | null;
};

const CANDIDATE_SUFFIX_PATTERN = /^(.+)-d([1-9]\d*)$/;

function isCandidateIndex(value: number): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

/**
 * Split a preview host's leading label into the chat slug it maps to and,
 * if the label is a design candidate's, which candidate.
 *
 * This is the reverse of `candidatePreviewHostname`, and the piece forward
 * auth needs to make candidates access-controlled exactly like the chat's
 * own preview: a candidate carries no `visibility` of its own anywhere in
 * the schema, so the only way to decide access for one is to strip its
 * `-d<n>` suffix first, look the resulting `chatSlug` up with
 * `findChatOwnerByPreviewSlug` exactly as an ordinary preview request
 * would, and hand that chat's owner/visibility to `decidePreviewAccess`
 * (see `decideCandidatePreviewAccess` in `decide-access.ts`) unchanged.
 * `candidateIndex` never participates in that decision — it only tells the
 * caller which candidate's dev-server port to proxy to.
 *
 * A trailing `-d<n>` where `n` is out of the 1..3 range (or has a leading
 * zero, since `[1-9]\d*` never matches one) is not a candidate suffix at
 * all — it is left as part of `chatSlug` untouched, on the assumption that
 * it is simply how that chat's id happened to end.
 */
export function parsePreviewHostSlug(slug: string): PreviewHostSlug {
  const match = CANDIDATE_SUFFIX_PATTERN.exec(slug);
  if (!match) {
    return { chatSlug: slug, candidateIndex: null };
  }

  const [, base, indexRaw] = match;
  const index = Number(indexRaw);
  if (!base || !isCandidateIndex(index)) {
    return { chatSlug: slug, candidateIndex: null };
  }

  return { chatSlug: base, candidateIndex: index };
}
