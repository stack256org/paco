/**
 * Runs inside a plugin worker before any plugin code loads, via
 * `node --import worker-preload.ts`.
 *
 * ## Why this is an allowlist
 *
 * Three adversarial reviews found three escapes here, and all three were the
 * same mistake: containment expressed as a denylist of named modules. Node's
 * builtin surface is larger than any hand-maintained list and grows with every
 * release. The third review made the point unanswerably — `_tls_wrap`,
 * `_http_client`, `_http_agent`, `_http_outgoing`, `_http_common` and
 * `_stream_wrap` are all socket-capable, all reachable, and none of them were
 * on the list. A plugin with no network grant opened a TLS connection and got
 * back `HTTP/1.1 200 OK`.
 *
 * So nothing is denied by name. A small set of builtins is ALLOWED, and
 * everything else — every underscore-prefixed internal, every module nobody
 * here has heard of, every builtin a future Node adds — is refused by default.
 *
 * ## The two gates
 *
 * A builtin can be reached by two routes, and both must be closed:
 *
 * 1. `import` / `require`, which goes through module resolution — covered by
 *    the resolve hook. It asks Node to resolve first and then checks the
 *    RESOLVED url, so a builtin is identified by Node itself rather than by a
 *    list this file keeps.
 * 2. `process.getBuiltinModule(id)`, which does NOT go through resolution and
 *    so is invisible to the hook. This is how the second escape worked.
 *    `process.binding` / `process._linkedBinding` are the same story.
 *
 * The network globals are deleted too, and the guards are installed as
 * non-configurable, non-writable properties so plugin code cannot restore the
 * originals.
 *
 * `module.registerHooks` (Node >= 22.15) is deliberate: the older
 * `module.register` runs hooks on a worker thread, which the permission model
 * blocks unless `--allow-worker` is passed — and passing that would hand
 * plugins the worker escape hatch this is meant to remove.
 *
 * This is process-level containment, not a container, and on Node < 24 it is
 * the only barrier to the network — which is why the host refuses to run
 * hardened on anything older. See SECURITY.md.
 */
import * as module from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The builtins plugin code may use. Bare names; the `node:` forms are handled
 * by normalization.
 *
 * Every entry is here because plugin slot code plausibly needs it, and none of
 * them can reach a socket, spawn a process, or load native code. Adding to
 * this set is a security decision: justify it here, in a comment, and check it
 * cannot reach the network — directly or by handing out a handle that can.
 *
 * `fs` is deliberately included and deliberately harmless: it is gated
 * independently by Node's permission model, which confines it to the plugin's
 * own directory and its state directory.
 */
const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "buffer",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "os",
  "path",
  "querystring",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "zlib",
]);

/** Longest plausible builtin specifier; anything longer is not one. */
const MAX_SPECIFIER_LENGTH = 64;

/**
 * The host package's own files are trusted: worker-entry imports
 * `node:readline` and friends, which plugins may not have. Everything else —
 * every plugin slot file and every dependency it drags in — goes through the
 * allowlist.
 */
const HOST_PACKAGE_DIR = import.meta.dirname;
const HOST_PACKAGE_URL = pathToFileURL(`${HOST_PACKAGE_DIR}${path.sep}`).href;

function isHostModule(parentURL: string | undefined): boolean {
  return parentURL !== undefined && parentURL.startsWith(HOST_PACKAGE_URL);
}

function denied(specifier: string): Error {
  return new Error(
    `plugin module denied: ${specifier} is not available to plugin code`,
  );
}

/**
 * Reduces a specifier to the bare builtin name it names, or `undefined` if it
 * is not a well-formed builtin specifier.
 *
 * `undefined` always means DENY, never "allow, could not tell". The input is
 * attacker-controlled, so anything unexpected — a non-string, whitespace, a
 * control character, a slash where none belongs — fails closed.
 *
 * Note what is deliberately NOT done: the input is never trimmed. `"node:fs "`
 * must not become `"fs"`; it must be refused, because the two are different
 * strings and only one of them was reviewed.
 */
function normalizeBuiltinSpecifier(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  if (raw.length === 0 || raw.length > MAX_SPECIFIER_LENGTH) {
    return undefined;
  }
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    // Space, every control character, and DEL. No trimming, no tolerance.
    if (code <= 0x20 || code === 0x7f) {
      return undefined;
    }
  }

  const lowered = raw.toLowerCase();
  const bare = lowered.startsWith("node:") ? lowered.slice(5) : lowered;
  if (bare.length === 0) {
    return undefined;
  }
  // `node:node:fs`, `node:/fs`, `fs/`, `fs//promises`, `../x` — all malformed.
  if (
    bare.startsWith("/") ||
    bare.endsWith("/") ||
    bare.includes("//") ||
    bare.includes("..") ||
    bare.includes(":")
  ) {
    return undefined;
  }
  return bare;
}

function isAllowedBuiltin(raw: unknown): boolean {
  const bare = normalizeBuiltinSpecifier(raw);
  return bare !== undefined && ALLOWED_BUILTINS.has(bare);
}

function removeNetworkGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
    try {
      delete globals[name];
    } catch {
      // A non-configurable global cannot be removed; overwrite it instead so
      // calling it still fails rather than reaching the network.
      globals[name] = undefined;
    }
  }
}

/**
 * Installs `value` as a locked-down own property of `target`.
 *
 * Non-writable and non-configurable, so plugin code can neither reassign the
 * property nor `defineProperty` the original back over it.
 */
function lockProperty(
  target: object,
  name: string,
  value: (...args: never[]) => unknown,
): void {
  try {
    Object.defineProperty(target, name, {
      value,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    // Already non-configurable and not ours. Nothing further to do here; the
    // resolve hook and the permission model remain in place.
  }
}

/**
 * `process.getBuiltinModule(id)` hands back a builtin WITHOUT going through
 * module resolution, so the resolve hook never sees it. Verified: on Node
 * 22.21.1 under `--permission`, it returned a working `net` — and later, a
 * working `_tls_wrap` — and connected to the internet.
 *
 * The original is captured in this closure before being replaced, so nothing
 * plugin code can reach still holds a reference to it.
 */
function guardBuiltinModuleAccess(): void {
  const original = process.getBuiltinModule;
  const originalCall =
    typeof original === "function" ? original.bind(process) : undefined;

  lockProperty(process, "getBuiltinModule", (id: never): unknown => {
    if (!(isAllowedBuiltin(id) && originalCall)) {
      throw denied(typeof id === "string" ? id : String(id));
    }
    return originalCall(id as unknown as string);
  });

  // The deprecated native-binding back doors, which reach the same C++ layer
  // without touching either gate above.
  for (const name of ["binding", "_linkedBinding"]) {
    lockProperty(process, name, (id: never): never => {
      throw denied(`process.${name}(${String(id)})`);
    });
  }
}

removeNetworkGlobals();
guardBuiltinModuleAccess();

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isHostModule(context.parentURL)) {
      return nextResolve(specifier, context);
    }

    // Cheap pre-check: an explicit `node:` specifier is a builtin request by
    // definition, so it can be refused before Node does any work.
    if (
      typeof specifier === "string" &&
      specifier.toLowerCase().startsWith("node:") &&
      !isAllowedBuiltin(specifier)
    ) {
      throw denied(specifier);
    }

    const resolved = nextResolve(specifier, context);

    // Let Node say whether this is a builtin, rather than keeping a list of
    // them here. A bare `_tls_wrap` resolves to `node:_tls_wrap`, and the
    // allowlist then refuses it — including builtins added in future
    // releases, which no denylist could have known about.
    if (typeof resolved.url === "string" && resolved.url.startsWith("node:")) {
      if (!isAllowedBuiltin(resolved.url)) {
        throw denied(specifier);
      }
    }
    return resolved;
  },
});
