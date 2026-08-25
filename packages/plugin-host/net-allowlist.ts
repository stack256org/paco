/**
 * The `net:fetch` allowlist check, shared by the plugin host and by whatever
 * implements the `net:fetch` handler.
 *
 * It is exported rather than kept private to the host on purpose: the host is
 * the first gate, not the only one. The handler must run this check again on
 * the initial URL **and on every redirect hop**, because a request the host
 * approved can still be redirected to a host nobody consented to.
 */

/** Dotted-quad IPv4, after WHATWG URL normalization (`127.1` → `127.0.0.1`). */
const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Lowercases and strips a single trailing dot, so `API.Example.com.` and
 * `api.example.com` are the same name. Exactly one dot: `example.com..` is
 * not a real name and stays unmatched.
 */
function normalizeHostname(hostname: string): string {
  const lowered = hostname.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

export type FetchAllowDecision =
  | { allowed: true; hostname: string }
  | { allowed: false; reason: string };

/**
 * Decides whether `url` may be fetched under the consented `netDomains`.
 *
 * The rules, in order:
 *
 * 1. `url` must parse as an absolute URL. An unparsable target cannot be
 *    checked, so it is denied.
 * 2. The scheme must be `http:` or `https:`. `file:`, `data:` and friends
 *    have no hostname to match and would reach the host filesystem.
 * 3. IP literals are denied outright, in both families. An allowlist is a
 *    list of names; letting a plugin dial `127.0.0.1` or `169.254.169.254`
 *    by number would walk straight past it.
 * 4. The hostname must equal an entry in `netDomains` exactly, after
 *    normalization. There is no subdomain matching in either direction: a
 *    grant for `api.linear.app` covers neither `evil.api.linear.app` nor
 *    `linear.app`.
 * 5. An empty `netDomains` denies everything.
 *
 * What this canNOT check, and the handler therefore must: where the name
 * actually resolves. A consented domain whose DNS answer is `10.0.0.5` or
 * `169.254.169.254` is an SSRF into the operator's own network, and only the
 * code performing the socket connection can see that.
 */
export function checkFetchAllowed(
  url: string,
  netDomains: readonly string[],
): FetchAllowDecision {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return {
      allowed: false,
      reason: `net:fetch denied: unparsable url ${url}`,
    };
  }

  if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
    return {
      allowed: false,
      reason: `net:fetch denied: scheme ${target.protocol} not allowed`,
    };
  }

  const hostname = normalizeHostname(target.hostname);

  // IPv6 literals arrive bracketed from the URL parser.
  if (hostname.startsWith("[") || IPV4_LITERAL.test(hostname)) {
    return {
      allowed: false,
      reason: `net:fetch denied: ip literal ${hostname} not allowed`,
    };
  }

  const allowed = netDomains.some(
    (domain) => normalizeHostname(domain) === hostname,
  );
  if (!allowed) {
    return {
      allowed: false,
      reason: `net:fetch denied: host ${hostname} not in netDomains`,
    };
  }

  return { allowed: true, hostname };
}

/** Boolean form of {@link checkFetchAllowed}, for callers that only branch. */
export function isFetchAllowed(
  url: string,
  netDomains: readonly string[],
): boolean {
  return checkFetchAllowed(url, netDomains).allowed;
}
