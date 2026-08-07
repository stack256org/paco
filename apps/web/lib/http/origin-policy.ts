// No "server-only" marker: this is pure string comparison with no server
// dependencies, and the tests import it directly.

/** The `host[:port]` of a URL, or `""` if it is not one. */
function hostOf(value: string): string {
  try {
    return new URL(value.trim()).host;
  } catch {
    return "";
  }
}

/**
 * Whether a request may claim this instance, given the domain it is configured
 * with.
 *
 * The rule: **an instance that has not been told its own address is in no
 * position to judge anyone else's.** With no domain configured, any origin is
 * accepted — including none at all. Once a domain is configured, the browser's
 * origin has to be that domain.
 *
 * Two earlier versions of this check both locked operators out of their own
 * fresh installs, and both made the same mistake — enforcing an identity the
 * instance did not have yet:
 *
 *   1. Comparing against `APP_URL`. A piped `curl | sudo sh` has no terminal,
 *      so the installer's domain prompt is skipped, `APP_URL` is unset, and it
 *      falls back to `http://localhost:3000`. Every real address was refused,
 *      and there was no address that worked.
 *   2. Comparing against the request's own `Host`. Right in principle, and
 *      still wrong behind an edge that rewrites Host on the way in: the browser
 *      is on one name, the app is handed another, and they never match. That is
 *      not an exotic setup — it is most managed platforms.
 *
 * Nothing is given up by falling open here. The window this guards is the one
 * where the instance is unclaimed, and in that window anyone who can reach it
 * can claim it — from a browser, from curl, from anything. `isFirstRun()` is
 * re-checked inside the request that creates the account, so this endpoint
 * stops answering the moment an owner exists.
 *
 * Once a domain *is* configured the operator has stated the instance's
 * identity, and it is enforced: hosts are compared whole, so
 * `paco.example.evil.test` does not pass as `paco.example`, and a missing or
 * unparseable origin is refused because there is now something it failed to
 * match.
 *
 * Scheme is deliberately not compared. An edge that terminates TLS speaks
 * plain HTTP to the app, so the browser's `https://` origin reaches a server
 * that has only ever seen `http://`. Requiring schemes to match would reject
 * every deployment behind TLS termination — which is most of them.
 */
export function isClaimOriginAllowed(
  origin: string | null,
  configuredDomain: string | null,
): boolean {
  const expected = configuredDomain ? hostOf(configuredDomain) : "";
  if (expected === "") {
    // Not configured, or configured with something unusable. Either way there
    // is nothing to check against, and refusing would only lock out the owner.
    return true;
  }

  return origin !== null && hostOf(origin) === expected;
}
