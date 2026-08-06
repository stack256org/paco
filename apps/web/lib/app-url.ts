/**
 * The public origin this deployment is served on.
 *
 * `APP_URL` deliberately carries no `NEXT_PUBLIC_` prefix. Next inlines
 * `process.env.NEXT_PUBLIC_*` at build time — in server code as well as in the
 * browser bundle — so a prefixed variable would be frozen to whatever the image
 * was built with, and one published image could not serve two installations.
 * Nothing in the browser reads this value, so the prefix bought nothing and
 * cost runtime configurability.
 *
 * Unlike the previous version there *is* a fallback, because a fresh install
 * has no domain yet and must still be reachable. The fallback names localhost,
 * which is only ever right for the machine the operator is on — it cannot be
 * mistaken for a working public origin the way a stale baked-in domain could.
 *
 * A domain configured in Settings does not appear here. `paco-entrypoint.sh`,
 * which the systemd unit runs, reads it from the database and exports
 * `APP_URL` before the server starts, so there is one resolution path rather
 * than two — and so a domain saved in Settings takes effect on the restart
 * the interface asks for.
 */
const DEFAULT_PORT = "3000";

/**
 * Whether `url` is usable as a public origin: an http(s) scheme with a host.
 *
 * `new URL("localhost:3066")` parses without throwing — it reads as the
 * scheme "localhost:" with the path "3066" and an empty host. "Did `new
 * URL()` throw" is therefore not enough; every caller that accepts an
 * operator-supplied origin needs this check too. It used to be four separate
 * copies of the same expression (here, `lib/config/required-env.ts`,
 * `scripts/dev.ts`, and — loosely, via the more permissive `z.url()` — the
 * Settings domain schema); they now all import this one.
 */
export function isHttpUrlWithHost(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") && url.host !== ""
  );
}

export function appUrl(): URL {
  const value = process.env.APP_URL?.trim();
  const raw =
    value || `http://localhost:${process.env.PORT?.trim() || DEFAULT_PORT}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `APP_URL is not a valid URL: ${raw}. Include the scheme and, unless it is the default for that scheme, the port.`,
    );
  }

  if (!isHttpUrlWithHost(url)) {
    throw new Error(
      `APP_URL must be an http(s) URL with a host: ${raw}. A missing scheme is the usual cause — "localhost:3066" parses as a scheme, not a host.`,
    );
  }

  return url;
}

/**
 * The origin's `host:port`, as better-auth matches trusted origins.
 *
 * `URL.host` keeps an explicit port and omits the default one for the scheme,
 * which is what a browser sends in the `Host` header — so `https://paco.example`
 * matches a request to that host, and a URL naming an explicit port only
 * matches that port.
 */
export function appHost(): string {
  return appUrl().host;
}
