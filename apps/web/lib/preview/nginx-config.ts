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

import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";

export const CERT_ROOT = "/etc/paco/preview-certs";

/**
 * Path, on every design-candidate preview host, that serves the click
 * inspector script.
 *
 * Proxied straight through to Paco's own app rather than read off disk by
 * nginx itself: the script lives at `apps/web/public/design-inspector.js`
 * and is already served like any other Next.js public asset at
 * `/design-inspector.js` on Paco's own origin, so this location just needs
 * to reach that origin over the loopback — the same `127.0.0.1:<appPort>`
 * the `/_paco_auth` subrequest already targets, for the same reason (see
 * this file's header comment, point 2).
 */
export const DESIGN_INSPECTOR_PATH = "/__paco/design-inspector.js";

/**
 * Which of a sandbox's published container ports a design candidate's dev
 * server is expected to bind, for a candidate index of 1..3.
 *
 * The chat's own preview always targets `PREVIEW_PORT`
 * (`lib/sandbox/config.ts`) — the first of `DEFAULT_SANDBOX_PORTS`
 * (`[3000, 5173, 4321, 8000]`). That list publishes three *more* ports from
 * the very same container for exactly this purpose: rather than inventing
 * new ports and wiring a fifth (or sixth, or seventh) one through the
 * sandbox's Docker config, a candidate simply claims the next slot already
 * published — candidate 1 on 5173, candidate 2 on 4321, candidate 3 on
 * 8000. Whatever dev-server tooling a candidate's worktree runs is
 * responsible for actually binding there (the same way the chat's own dev
 * server is expected to bind 3000); this function only names the
 * convention. The caller that wires up a candidate's nginx block
 * (`syncPreviewRoutes`'s candidate handling) still has to resolve that
 * container port to whatever host port Docker actually published it on —
 * `listSandboxPreviewPorts` already does exactly that, called once per
 * container port instead of just `PREVIEW_PORT`'s.
 *
 * ---
 * **CONTRACT WITH THE DESIGN TURN.** This function is only half of making a
 * candidate's preview reachable. The other half happens wherever a
 * candidate's dev server actually gets started, and nothing in this codebase
 * enforces it: candidate `n`'s dev server MUST bind
 * `candidateContainerPort(n)` — 5173 for candidate 1, 4321 for candidate 2,
 * 8000 for candidate 3 — instead of whatever port its framework defaults to,
 * and not the chat's own 3000, which would collide with the chat's preview.
 *
 * The other side of that contract now exists and is written down:
 * `buildPortContractInstruction` in `lib/design/design-turn.ts` restates it
 * as an instruction in every candidate's own system prompt, which is the
 * only place it can be enforced at all — a candidate's dev server is started
 * by the candidate's own agent turn, so nothing downstream can distinguish
 * "the dev server started, but on the wrong port" from "it has not started
 * yet."
 *
 * The failure is quiet by nature. Docker publishes all four ports at
 * container creation, so nginx's block for candidate `n` is written the
 * moment the worktree exists; if nothing ever binds the port behind it, the
 * candidate's iframe gets a 502 from nginx and the design-mode UI shows that
 * candidate as unreachable, with no error surfaced anywhere in this
 * codebase. This comment, `buildPortContractInstruction`, and this
 * function's exact return values (covered by `nginx-config.test.ts`'s
 * `candidateContainerPort` suite) are the whole of the contract.
 * ---
 */
export function candidateContainerPort(index: 1 | 2 | 3): number {
  return DEFAULT_SANDBOX_PORTS[index];
}

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

/**
 * An origin of exactly `scheme://host[:port]` — no path, query, fragment,
 * or characters that could break out of the `add_header`/HTML-attribute
 * contexts this gets interpolated into (an `add_header` value ends at
 * unescaped whitespace or `;`, same as the rest of this file's directives).
 */
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

function assertSafeOrigin(origin: string): void {
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new Error(
      `Refusing to generate an nginx config for an unsafe app origin: ${JSON.stringify(origin)}`,
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
  /**
   * Whether this block routes a design-candidate preview rather than an
   * ordinary chat preview. Defaults to `false`.
   *
   * The *only* thing this flag changes: a candidate block gets the click
   * inspector injected (`sub_filter` before `</body>`, plus the
   * `DESIGN_INSPECTOR_PATH` location that serves it) — nothing about
   * routing or auth differs, since a candidate is authorized exactly like
   * its owning chat (`decideCandidatePreviewAccess`). An ordinary chat
   * block must never carry the inspector: it is unreviewed, freshly
   * generated code shown to whoever the chat's preview is shared with, not
   * a design surface meant to be clicked on.
   */
  isDesignCandidate?: boolean;
  /**
   * Paco's own public origin (`scheme://host[:port]`, e.g.
   * `https://paco.example.com`) — required when `isDesignCandidate` is
   * true, ignored otherwise.
   *
   * Two independent uses, both about keeping a candidate's inspector
   * talking to Paco's own UI and nobody else:
   *
   * 1. Embedded in the injected `<script>` tag as `data-paco-origin`.
   *    `design-inspector.js` reads it off its own `<script>` element
   *    (`document.currentScript`) and uses it both as the required
   *    `origin` on every `paco-inspect-arm` message it will accept, and as
   *    the exact `targetOrigin` it posts `paco-inspect-click` back to —
   *    `postMessage(..., "*")` would hand a click's selector and text to
   *    whatever page happens to have this preview framed.
   * 2. Emitted as `X-Frame-Options` and a `Content-Security-Policy:
   *    frame-ancestors` response header, so nothing but Paco's own UI can
   *    frame a candidate preview in the first place. Pinning the
   *    `postMessage` origin (above) is worthless if any origin can embed
   *    the page and read what gets posted out of it.
   */
  appOrigin?: string;
};

/**
 * Render one preview's nginx `server { ... }` block as text.
 *
 * Throws — never returns a string a caller might write to disk unchecked —
 * when `hostname`, `upstreamPort`, or `appPort` cannot be trusted to appear
 * literally in generated nginx configuration.
 */
export function previewServerBlock(input: PreviewServerBlockInput): string {
  const {
    hostname,
    upstreamPort,
    appPort,
    certDir,
    isDesignCandidate = false,
    appOrigin,
  } = input;

  assertSafeHostname(hostname);
  assertValidPort(upstreamPort, "upstreamPort");
  assertValidPort(appPort, "appPort");

  if (isDesignCandidate) {
    if (!appOrigin) {
      throw new Error(
        "previewServerBlock: isDesignCandidate requires appOrigin (Paco's own public origin) — it pins both the inspector's postMessage origin and the frame-ancestors policy.",
      );
    }
    assertSafeOrigin(appOrigin);
  }

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

  // Only a design-candidate block gets the inspector: an nginx location
  // that hands the script out (proxied to Paco's own public asset, see
  // `DESIGN_INSPECTOR_PATH`'s doc comment) plus the `sub_filter` directives
  // that inject a `<script>` tag for it into every HTML response. An
  // ordinary chat preview must never carry either — see this input's
  // `isDesignCandidate` doc comment.
  const inspectorLocation = isDesignCandidate
    ? `
    location = ${DESIGN_INSPECTOR_PATH} {
        proxy_pass http://127.0.0.1:${appPort}/design-inspector.js;
    }
`
    : "";

  // `sub_filter` cannot rewrite a response nginx never sees uncompressed,
  // so the upstream is told not to gzip in the first place — clearing
  // `Accept-Encoding` on the proxied request, rather than trying to
  // decompress and re-encode it here.
  const inspectorSubFilter = isDesignCandidate
    ? `        proxy_set_header Accept-Encoding "";
        sub_filter '</body>' '<script src="${DESIGN_INSPECTOR_PATH}" data-paco-origin="${appOrigin}"></script></body>';
        sub_filter_once on;
`
    : "";

  // Only a design-candidate host may be framed at all, and only by Paco's
  // own UI: `frame-ancestors` is what modern browsers actually enforce;
  // `X-Frame-Options` rides along for anything old enough to ignore CSP.
  // Emitted at server level so it lands on every location's response,
  // `location /`'s (the actual page) included — an nginx `add_header` at
  // one level is inherited into every location under it that defines no
  // `add_header` of its own, which is true of all three locations here.
  const frameAncestorsGuard = isDesignCandidate
    ? `    add_header X-Frame-Options "ALLOW-FROM ${appOrigin}" always;
    add_header Content-Security-Policy "frame-ancestors ${appOrigin};" always;
`
    : "";

  return `# Generated by Paco (lib/preview/nginx-config.ts) via nginx-reload.ts.
# Do not edit by hand — this file is overwritten every time preview routes
# are synced, and a hand edit is silently lost on the next sync.
server {
${listenLines}    server_name ${hostname};

${frameAncestorsGuard}${httpsRedirect}    # Every preview is authorized by Paco on every request, public or
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
${inspectorLocation}
    location / {
        auth_request /_paco_auth;

${inspectorSubFilter}        proxy_pass http://127.0.0.1:${upstreamPort};
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
