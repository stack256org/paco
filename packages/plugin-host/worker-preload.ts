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
 * ## The third surface: `process` itself
 *
 * Closing both module routes is not enough, because some of what the module
 * allowlist withholds is also sitting on `process`, reachable with no import
 * at all. `process.report.getReport()` returns the host's IP addresses and
 * MACs, its hostname, this worker's `--allow-fs-read` prefixes and its
 * environment — everything the `os` exclusion below exists to withhold. The
 * uid/gid family is `os.userInfo()` under another name. See
 * `guardProcessReconnaissance`.
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
 *
 * `os` is deliberately EXCLUDED. It reaches no socket, but it is pure
 * reconnaissance — `os.networkInterfaces()` hands over the host's internal IP
 * addresses and `os.userInfo()` its username, either of which could later
 * leave through a granted `net:fetch` domain. A plugin that genuinely needs
 * platform information should get it through a capability, with consent, not
 * by reading the host.
 */
const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "buffer",
  "crypto",
  "events",
  "fs",
  "fs/promises",
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
 * property nor `defineProperty` the original back over it. A data descriptor
 * also replaces an accessor, which is what `process.report` is.
 */
function lockValue(target: object, name: string, value: unknown): void {
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

/** `lockValue` for the common case of replacing a method with a guard. */
function lockProperty(
  target: object,
  name: string,
  value: (...args: never[]) => unknown,
): void {
  lockValue(target, name, value);
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

/**
 * Members of `process` that hand over the same information the `os` exclusion
 * exists to withhold — plus the two that hand over more than information.
 *
 * The uid/gid family IS `os.userInfo()` by another name: `getuid`, `getgid`
 * and `getgroups` name the account this worker runs as. The setters are here
 * for the same reason `os` is excluded wholesale rather than filtered — a
 * plugin has no business touching process credentials at all, and a
 * non-root worker gains nothing by them anyway.
 *
 * `_getActiveHandles` and `_getActiveRequests` are worse than reconnaissance:
 * they return the live libuv handle OBJECTS, so anything socket-backed the
 * process happens to be holding is handed straight to plugin code. That is
 * exactly the class of underscore-prefixed back door the module allowlist
 * refuses (`_tls_wrap` and friends), reached without module resolution.
 *
 * `dlopen` loads a native addon, which executes outside every gate in this
 * file. Node's permission model refuses it without `--allow-addons`, which
 * the host never passes; this is the second lock on that door, in keeping
 * with the rest of the file's refusal to depend on one gate.
 *
 * Each is replaced only if it currently exists, so a platform-specific
 * member this Node does not have is not conjured into being for a library's
 * feature detection to find and call.
 */
const DENIED_PROCESS_METHODS: readonly string[] = [
  "getuid",
  "getgid",
  "geteuid",
  "getegid",
  "getgroups",
  "setuid",
  "setgid",
  "seteuid",
  "setegid",
  "setgroups",
  "initgroups",
  "_getActiveHandles",
  "_getActiveRequests",
  "dlopen",
];

/**
 * Closes the reconnaissance surface on `process` itself.
 *
 * `os` is excluded from the module allowlist because `os.networkInterfaces()`
 * and `os.userInfo()` are pure reconnaissance that could later leave through
 * a granted `net:fetch` domain. That exclusion was being walked around:
 * `process.report.getReport()` — no import, no resolution, nothing for the
 * hook to see — returns `header.networkInterfaces` (every host IP and MAC),
 * `header.host` (the machine's hostname), `header.commandLine` (which spells
 * out this worker's `--allow-fs-read` prefixes, i.e. a map of what it may
 * read), `environmentVariables`, and several hundred `sharedObjects`
 * filesystem paths. `writeReport()` puts the same document on disk, so
 * denying only the getter would leave the second route open — the whole
 * object goes.
 *
 * `execArgv` is emptied for the same reason `header.commandLine` is refused:
 * it is the fs-read allowlist in plain text. Nothing in the worker reads it
 * (`worker-entry.ts` takes its configuration from `process.env`, which the
 * host builds from scratch rather than inheriting), and `child_process` —
 * the one API that would use it — is denied.
 *
 * Deliberately NOT locked, and why:
 *
 * - `process.env`: the host already spawns the worker with an environment
 *   built from scratch (`PATH`, `PACO_PLUGIN_ID`, `PACO_PLUGIN_STATE_DIR`) —
 *   see `host.ts`. There is nothing in it to leak, and `worker-entry.ts`
 *   reads `PACO_PLUGIN_STATE_DIR` from it.
 * - `process.cwd()`: the host sets the child's cwd to the plugin's OWN
 *   directory, which it already knows.
 * - `process.permission.has(scope, path)`: an oracle that only confirms a
 *   path the caller already supplied, and only what the caller could learn
 *   anyway by attempting the operation. It enumerates nothing, which is the
 *   line that puts `commandLine` and `execArgv` on the other side.
 * - `process.platform` / `arch` / `version` / `execPath`, and
 *   `navigator.platform` / `hardwareConcurrency`: platform and capacity, not
 *   host identity. Node's own internals and most libraries read them, and
 *   locking them buys nothing while breaking ordinary code.
 * - `process.argv`: Node resolves the entry point through it, and it names
 *   only this package's own path — not the fs-read map that made
 *   `execArgv` worth emptying.
 */
function guardProcessReconnaissance(): void {
  lockValue(process, "report", undefined);

  for (const name of DENIED_PROCESS_METHODS) {
    if (!(name in process)) {
      continue;
    }
    lockProperty(process, name, (): never => {
      throw denied(`process.${name}()`);
    });
  }

  lockValue(process, "execArgv", Object.freeze([]));
}

removeNetworkGlobals();
guardBuiltinModuleAccess();
guardProcessReconnaissance();

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
