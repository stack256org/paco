// No "server-only" marker: this is pure header arithmetic with no server
// dependencies, and the route tests import it directly.

/**
 * The host a request actually arrived on, as `host[:port]`.
 *
 * Read from the request URL rather than the `Host` header. Next reconstructs
 * `request.url` from that header, so the two agree in production — but a
 * `Request` built in a test carries no explicit `Host` at all, and reading the
 * header directly would make this untestable without inventing one.
 */
export function requestHost(request: Request): string {
  try {
    return new URL(request.url).host;
  } catch {
    return "";
  }
}

/**
 * Whether `origin` names the same host the request arrived on.
 *
 * This is the CSRF check for unauthenticated endpoints, and it deliberately
 * asks about the *request* rather than about configuration.
 *
 * It used to compare against `appUrl().origin`, which broke every default
 * install. `curl | sudo sh` has no terminal, so the installer's domain prompt
 * is always skipped and `APP_URL` is left unset; `appUrl()` then falls back to
 * `http://localhost:3000`, and a browser at the host's real address or domain
 * was refused with "That request didn't come from this Paco instance". The
 * instance could not be claimed from anywhere — including localhost, since
 * nginx serves it on port 80 while the fallback names 3000.
 *
 * Hosts are compared whole, never by prefix or suffix: `paco.example` and
 * `paco.example.evil.test` are different hosts, and a `startsWith`/`endsWith`
 * check is the classic way this is got wrong.
 *
 * Scheme is deliberately NOT compared. Paco sits behind nginx, which speaks
 * plain HTTP to the app, so a browser on `https://paco.example` sends
 * `Origin: https://paco.example` to a server that sees an `http://` request
 * URL. Requiring the schemes to match would reject every TLS deployment.
 * Comparing `host:port` is also what better-auth does for its own trusted
 * origins, so the two agree.
 *
 * What this still stops is the attack the check exists for: a page on another
 * site posting here with the victim's browser. Browsers set `Origin`
 * themselves and a page cannot forge it, so a cross-site post always carries
 * that site's origin and never matches. A caller that is not a browser can set
 * both headers freely — but such a caller never needed CSRF in the first
 * place, so this is exactly as strong as it ever was.
 */
export function isSameOrigin(origin: string | null, request: Request): boolean {
  if (!origin) {
    return false;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // `Origin: null` — a sandboxed iframe, or a redirect that dropped it — and
    // anything else unparseable. Not same-origin.
    return false;
  }

  const host = requestHost(request);
  return originHost !== "" && originHost === host;
}
