/**
 * Runs inside a plugin worker before any plugin code loads, via
 * `node --import worker-preload.ts`.
 *
 * Node's permission model removes the filesystem, child processes, workers
 * and native addons. On Node >= 24 it also gates sockets. On Node 22.x it
 * does NOT, so this file closes that gap from inside the process, in four
 * layers — every one of which is needed, because each on its own has a hole:
 *
 * 1. The network globals are deleted, so `fetch(...)` is not a function any
 *    more. The only way out is the host's `net:fetch` capability, which is
 *    allowlisted against the operator's consented domains.
 * 2. A synchronous resolve hook refuses the modules that could rebuild a
 *    socket, spawn something, or unpick this file's own work.
 * 3. `process.getBuiltinModule` is replaced by a guarded version. This is not
 *    belt-and-braces: it walks straight past the resolve hook, because it
 *    never goes through module resolution at all. Without this, a plugin on
 *    Node 22.21.1 opens a real TCP socket in two lines.
 * 4. `process.binding` and `process._linkedBinding` are neutralized — the
 *    deprecated back door to the same native bindings.
 *
 * Layers 3 and 4 install non-configurable, non-writable properties, so plugin
 * code cannot put the originals back.
 *
 * `module.registerHooks` (Node >= 22.15) is deliberate: the older
 * `module.register` runs hooks on a worker thread, which the permission model
 * blocks unless `--allow-worker` is passed — and passing that would hand
 * plugins the worker escape hatch this is meant to remove.
 *
 * This is process-level containment, not a container. See SECURITY.md.
 */
import * as module from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Modules a plugin may not import. Network reachability first, then the
 * process/isolation escapes, then `module` itself — without that last one a
 * plugin could `registerHooks` its way around this list or `createRequire`
 * its way around the resolver.
 */
const DENIED_MODULES: readonly string[] = [
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "dns/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "repl",
  "tls",
  "vm",
  "wasi",
  "worker_threads",
];

const DENIED = new Set<string>(
  DENIED_MODULES.flatMap((name) => [name, `node:${name}`]),
);

/**
 * The host package's own files are trusted: worker-entry imports
 * `node:readline` and friends and must keep working. Everything else — every
 * plugin slot file and every dependency it drags in — is denied.
 */
const HOST_PACKAGE_DIR = import.meta.dirname;
const HOST_PACKAGE_URL = pathToFileURL(`${HOST_PACKAGE_DIR}${path.sep}`).href;

function isHostModule(parentURL: string | undefined): boolean {
  return parentURL !== undefined && parentURL.startsWith(HOST_PACKAGE_URL);
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

function denied(specifier: string): Error {
  return new Error(
    `plugin module denied: ${specifier} is not available to plugin code`,
  );
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
 * 22.21.1 under `--permission`, `process.getBuiltinModule("node:net")`
 * returned a working `net` and connected a TCP socket to the internet.
 *
 * The original is captured in this closure before being replaced, so host
 * code keeps working and plugin code has no reference to it.
 */
function guardBuiltinModuleAccess(): void {
  const original = process.getBuiltinModule;
  const originalCall =
    typeof original === "function" ? original.bind(process) : undefined;

  lockProperty(process, "getBuiltinModule", (id: never): unknown => {
    const specifier = String(id);
    if (DENIED.has(specifier)) {
      throw denied(specifier);
    }
    if (!originalCall) {
      throw denied(specifier);
    }
    return originalCall(specifier);
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
    if (DENIED.has(specifier) && !isHostModule(context.parentURL)) {
      throw denied(specifier);
    }
    return nextResolve(specifier, context);
  },
});
