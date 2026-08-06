/**
 * Start the dev server on the port `APP_URL` names.
 *
 * Next reads that variable itself, but only after it has already chosen a port,
 * so the port has to be resolved out here and passed in. Deriving it means the
 * origin the app tells the browser about and the origin it actually listens on
 * cannot disagree — a mismatch shows up as magic links that load a dead port.
 *
 * `APP_URL` is optional, the same as `lib/app-url.ts` treats it: a fresh
 * install has no domain yet, so an absent or blank value falls back to
 * `http://localhost:$PORT` (port 3000 if `PORT` is unset too) rather than
 * failing to start. Only a value that was actually set and does not parse as
 * an http(s) origin is a mistake worth failing loudly for — that is the
 * failure this file exists to catch, not "unset".
 *
 * Passing `--port` explicitly also makes the port binding: Next fails with
 * EADDRINUSE rather than quietly moving to the next free port, which is the
 * behaviour that puts the app somewhere `APP_URL` does not point.
 *
 * Usage:  node scripts/dev.ts [...next dev args]
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { config } from "dotenv";
import { isHttpUrlWithHost } from "../lib/app-url.ts";

// Next loads `.env` for the app; this script needs the value before Next runs.
config({ path: join(import.meta.dirname, "..", ".env"), quiet: true });

const DEFAULT_PORT = "3000";

const configuredAppUrl = process.env.APP_URL?.trim();
const appUrl =
  configuredAppUrl ||
  `http://localhost:${process.env.PORT?.trim() || DEFAULT_PORT}`;

let url: URL;
try {
  url = new URL(appUrl);
} catch {
  console.error(
    `APP_URL is not a valid URL: ${appUrl}. Include the scheme and, unless it is the default for that scheme, the port.`,
  );
  process.exit(1);
}

// `new URL("localhost:3066")` succeeds — it reads as the scheme "localhost:"
// with path "3066" and an empty host, which would leave no port to bind. Same
// check `appUrl()` and `findConfigProblems` use — see `lib/app-url.ts`.
if (!isHttpUrlWithHost(url)) {
  console.error(
    `APP_URL must be an http(s) URL with a host: ${appUrl}. A missing scheme is the usual cause — "localhost:3066" parses as a scheme, not a host.`,
  );
  process.exit(1);
}

// `URL.port` is empty when the origin uses the scheme's default port, which is
// the shape a deployed origin takes (https://paco.example). Locally there is
// always an explicit port.
const port = url.port || (url.protocol === "https:" ? "443" : "80");

const child = spawn("next", ["dev", "--port", port, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
