/**
 * Runs inside a plugin worker before any plugin code loads, via
 * `node --import worker-preload.ts`.
 *
 * Node's permission model removes the filesystem, child processes, workers
 * and native addons. It does NOT cover the network, so this file closes that
 * gap from inside the process, in two layers:
 *
 * 1. The network globals are deleted, so `fetch(...)` is not a function any
 *    more. The only way out is the host's `net:fetch` capability, which is
 *    allowlisted against the operator's consented domains.
 * 2. A synchronous resolve hook refuses the modules that could rebuild a
 *    socket, spawn something, or unpick this file's own work.
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

removeNetworkGlobals();

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (DENIED.has(specifier) && !isHostModule(context.parentURL)) {
      throw new Error(
        `plugin module denied: ${specifier} is not available to plugin code`,
      );
    }
    return nextResolve(specifier, context);
  },
});
