/**
 * Build the nginx server block that routes one chat's preview.
 *
 * This is a pure function on purpose — same reason `previewLabels` (the
 * Traefik-labels module this replaces) was one: it is the single place a
 * preview's routing and auth wiring is decided, so a test can cover every
 * combination of hostname and TLS exhaustively, and the injection guard
 * below only has to be written once.
 *
 * Four properties matter, each a lesson the Traefik version paid for:
 *
 * 1. `auth_request` is emitted unconditionally, never conditioned on
 *    `tlsEnabled` or any stored visibility. `decidePreviewAccess`
 *    (`lib/preview/decide-access.ts`) reads the chat's row fresh on every
 *    request; a config that only ever describes the visibility it was
 *    generated with cannot react when a preview is made private again
 *    without being regenerated — and nothing regenerates it on that event.
 * 2. The auth subrequest targets `127.0.0.1:<appPort>` — the loopback, not
 *    the public origin. A request that left this host and re-entered
 *    through the public entrypoint would have `X-Forwarded-Host`
 *    recomputed from the new request, not the one the browser actually
 *    sent, and `/api/preview-auth` would deny every private preview.
 * 3. `X-Forwarded-Host $host` is passed on the auth subrequest so
 *    `/api/preview-auth` can resolve the *preview's* hostname back to a
 *    chat, not nginx's own.
 * 4. The hostname is validated before it is ever interpolated into
 *    generated config text. It comes from `previewSlug(chatId)` plus a
 *    configured base domain, so it should always be safe — but nginx
 *    config is executed as configuration, and "should" is not a guarantee.
 *
 * One known gap, worth stating rather than hiding: nginx's `auth_request`
 * module only understands three outcomes from the subrequest — 2xx (allow),
 * 401, and 403 (deny) — anything else becomes an internal 500. Traefik's
 * forwardAuth, by contrast, relayed *any* non-2xx response — including the
 * 302 `redirectToGrant`/`consumeGrant` responses in
 * `app/api/preview-auth/route.ts` use to hand a private preview's owner a
 * grant cookie. Because that route must not be rewritten as part of this
 * change, the redirect-to-grant flow does not survive the move to nginx as
 * literally as the allow/deny paths do — see the task-345 report's concerns.
 */

export const CERT_ROOT = "/etc/paco/preview-certs";

/** Where a preview hostname's certificate and key live, if it has one. */
export function previewCertDir(hostname: string): string {
  assertSafeHostname(hostname);
  return `${CERT_ROOT}/${hostname}`;
}

/**
 * A hostname made of dot-separated DNS labels only — letters, digits,
 * hyphens — with at least one dot (every preview hostname is
 * `<slug>.<baseDomain>`). Anything with whitespace, `;`, `{`, `}`, or other
 * characters nginx's config parser treats specially fails this and throws
 * rather than ever reaching a file nginx will load.
 */
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function assertSafeHostname(hostname: string): void {
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      `Refusing to generate an nginx config for an unsafe hostname: ${JSON.stringify(hostname)}`,
    );
  }
}

function assertValidPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Refusing to generate an nginx config with an invalid ${label}: ${port}`,
    );
  }
}

export type PreviewServerBlockInput = {
  /** The full hostname this preview is reachable at, e.g. from `previewHostname`. */
  hostname: string;
  /** `127.0.0.1:<upstreamPort>` is where the chat's sandbox published its dev server. */
  upstreamPort: number;
  /** `127.0.0.1:<appPort>` is where Paco's own service listens — see `PACO_APP_PORT`. */
  appPort: number;
  /**
   * The directory holding this hostname's `fullchain.pem` and `privkey.pem`,
   * or `null` to serve the preview over plain HTTP.
   *
   * Deliberately not a `tlsEnabled` boolean. nginx checks every
   * `ssl_certificate` path at *config test* time, so naming a file that does
   * not exist makes `nginx -t` fail — and `syncPreviewRoutes` then throws and
   * restores the previous config, which means **no preview route can be
   * synced at all** until the config stops naming it.
   *
   * That is not hypothetical: this used to take `tlsEnabled` straight from
   * Settings and emit `<CERT_ROOT>/<hostname>/fullchain.pem` whenever the
   * operator turned the toggle on. Nothing has ever written to `CERT_ROOT` —
   * `paco tls` uses certbot, which writes to `/etc/letsencrypt/live/` and
   * covers only Paco's own domain ("one hostname, no wildcard, previews
   * excluded"). So the toggle broke every preview on the instance while
   * being labelled as though it fetched certificates.
   *
   * Requiring the path here, and having the caller confirm it exists on disk
   * first, makes that failure unrepresentable: without a real certificate the
   * worst outcome is a preview served over HTTP, which works.
   */
  certDir: string | null;
};

/**
 * Render one preview's nginx `server { ... }` block as text.
 *
 * Throws — never returns a string a caller might write to disk unchecked —
 * when `hostname`, `upstreamPort`, or `appPort` cannot be trusted to appear
 * literally in generated nginx configuration.
 */
export function previewServerBlock(input: PreviewServerBlockInput): string {
  const { hostname, upstreamPort, appPort, certDir } = input;

  assertSafeHostname(hostname);
  assertValidPort(upstreamPort, "upstreamPort");
  assertValidPort(appPort, "appPort");

  // A certificate directory is interpolated into generated nginx config, so
  // it gets the same treatment as the hostname: `;` or whitespace in a path
  // would end the `ssl_certificate` directive and start another one.
  if (certDir !== null && /[\s;{}"'$\\]/.test(certDir)) {
    throw new Error(
      `Refusing to generate an nginx config for an unsafe certificate path: ${JSON.stringify(certDir)}`,
    );
  }

  const listenLines =
    certDir === null
      ? "    listen 80;\n"
      : `    listen 80;\n    listen 443 ssl;\n    ssl_certificate ${certDir}/fullchain.pem;\n    ssl_certificate_key ${certDir}/privkey.pem;\n`;

  // One server block handles both ports when TLS is on, rather than a
  // second server block just for the redirect — `$scheme` already reflects
  // which listener accepted the connection, so `server_name` only ever
  // appears once for this hostname.
  const httpsRedirect =
    certDir === null
      ? ""
      : '    if ($scheme = "http") {\n        return 301 https://$host$request_uri;\n    }\n\n';

  return `# Generated by Paco (lib/preview/nginx-config.ts) via nginx-reload.ts.
# Do not edit by hand — this file is overwritten every time preview routes
# are synced, and a hand edit is silently lost on the next sync.
server {
${listenLines}    server_name ${hostname};

${httpsRedirect}    # Every preview is authorized by Paco on every request, public or
    # private alike. decidePreviewAccess reads the chat's live visibility,
    # so this subrequest is never conditioned on it here — see this file's
    # header comment for why a config that decided for itself broke the
    # moment a public preview was made private again.
    location = /_paco_auth {
        internal;
        # The loopback, not the public origin: see this file's header
        # comment, point 2.
        proxy_pass http://127.0.0.1:${appPort}/api/preview-auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Uri $request_uri;
    }

    location / {
        auth_request /_paco_auth;

        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}
