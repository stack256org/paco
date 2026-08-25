import { lstat, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { getPlugin } from "@/lib/db/plugins";
import { pluginDir } from "@/lib/plugins/install";

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
 * The response carries a strict, literal CSP —
 * `default-src 'none'; script-src 'unsafe-inline'; style-src
 * 'unsafe-inline'` — so the served document can run its own inline
 * `<script>`/`<style>` (that is how a renderer talks to its parent frame
 * and styles itself) but cannot load ANY external resource: no images,
 * fonts, frames, `fetch`/`XHR`, or nested navigation targets. Combined
 * with the iframe's `sandbox="allow-scripts"` (no `allow-same-origin`,
 * so the document's origin is opaque — see `plugin-renderer.tsx`), a
 * renderer has no way to reach Paco's own origin, storage, cookies, or
 * network — its only channel to the outside is `postMessage` to its
 * parent frame.
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

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pluginId: string; file: string }> },
) {
  const { pluginId, file } = await params;

  // Step 1: allowlist both segments before any fs or db call sees them.
  if (!(PLUGIN_ID_PATTERN.test(pluginId) && RENDERER_FILE_PATTERN.test(file))) {
    return notFound();
  }

  // Step 2: installed AND enabled — a disabled plugin 404s exactly like an
  // unknown one.
  const plugin = await getPlugin(pluginId);
  if (!plugin || !plugin.enabled) {
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
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CONTENT_SECURITY_POLICY,
    },
  });
}
