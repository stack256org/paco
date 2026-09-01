import { PACO_APP_PORT } from "@/lib/sandbox/config";

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
 * The app's own loopback base URL — for the app calling itself, never for
 * anything public-facing.
 *
 * Three places need this: the tool-approval hook's callback
 * (`app/workflows/chat.ts`, `lib/tasks/reviewer-gate.ts`) and the
 * plugin-tool bridge (`lib/agent/chat-environment.ts`). Each spawns a child
 * process on this same machine that posts straight back to this server.
 *
 * This must NOT be built from `appUrl()`. `appUrl()` is the public origin —
 * on a packaged install that is `https://<domain>` behind nginx, and nginx's
 * default server now carries `auth_basic` for the instance password (see
 * AGENTS.md's Authentication section, and `packaging/debian/postinst`).
 * Deriving a loopback port from the public origin (`appUrl().port || "80"`)
 * sends these internal requests through nginx on port 80 instead of past it,
 * so they get a 401 instead of reaching the app. That is worse than a loud
 * failure: the approval hook fails *open* on a transport error by design, so
 * a callback that can't get through would silently approve every tool call
 * this gate exists to stop, rather than error.
 *
 * The port here is the app's actual listening port: `PORT` if the
 * environment sets it (the packaged install's `paco.env` does, so an
 * operator who moves the app to another port is still honoured), otherwise
 * `PACO_APP_PORT` — the same `3000` `postinst` writes into both `paco.env`
 * and nginx's `proxy_pass`.
 */
export function appLoopbackUrl(): string {
  const port = process.env.PORT?.trim() || String(PACO_APP_PORT);
  return `http://127.0.0.1:${port}`;
}
