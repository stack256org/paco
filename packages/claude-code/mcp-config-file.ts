import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

/**
 * `--mcp-config` payload delivery.
 *
 * The CLI accepts either an inline JSON string or a path (`--mcp-config
 * <configs...>`: "Load MCP servers from JSON files or strings"). Paco passed
 * it inline, which put the whole `mcpServers` object — **including each
 * server's `env`** — into the CLI process's argument vector. That vector is
 * world-readable through `ps auxww`, and the agent's own `Bash` tool can
 * read it too, so the 6-hour bearer token that authorizes
 * `/api/internal/plugin-tools` (`apps/web/lib/plugins/tools-token.ts`) was
 * readable by every account on the host and by the agent itself.
 *
 * This is a standing rule in this repository, not a new judgement.
 * AGENTS.md, on `gh`: *"The token goes in the environment, never in argv.
 * `ps` shows one process's arguments to every user on the machine."*
 * `packages/sandbox/docker/sandbox.ts` states it again for the Docker path
 * and gets it right. This path missed it.
 *
 * A file rather than an environment variable, because the CLI has no
 * environment-variable form of `--mcp-config`, and because the payload has
 * to carry per-server `env` blocks that only a config can express. The file
 * is created inside a fresh `0700` directory and written `0600`, so the
 * bytes are reachable only by the user Paco runs as — the same account that
 * could already read Paco's `.env`.
 */

export const MCP_CONFIG_FLAG = "--mcp-config";

/**
 * Prefix for the private directory each config is written into. Also what
 * {@link cleanupMcpConfigFile} matches on, so cleanup can only ever remove a
 * directory this module made.
 */
const CONFIG_DIR_PREFIX = "paco-mcp-config-";

export type McpServerSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * Writes `{ mcpServers }` to a private file and returns its path.
 *
 * A fresh directory per call (`mkdtempSync`, which creates it `0700`) rather
 * than a fixed name: two turns can start at once, and a shared path would
 * have one run reading the other's servers — or reading a half-written file.
 */
export function writeMcpConfigFile(
  mcpServers: Record<string, McpServerSpec>,
): string {
  const dir = mkdtempSync(join(tmpdir(), CONFIG_DIR_PREFIX));
  const file = join(dir, "mcp-config.json");
  writeFileSync(file, JSON.stringify({ mcpServers }), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return file;
}

/**
 * Whether `path` is a file this module wrote — the only thing cleanup is
 * ever allowed to delete.
 *
 * `--mcp-config` also accepts an inline JSON string and an operator's own
 * config path, and cleanup removes a *directory* recursively, so matching
 * loosely here would be a way to delete something that matters. The check is
 * on the parent directory's name carrying `CONFIG_DIR_PREFIX` under the
 * system temp directory, which only `writeMcpConfigFile` produces.
 */
function isOwnConfigFile(path: string): boolean {
  const dir = dirname(path);
  const parent = dirname(dir);
  const base = dir.slice(parent.length + 1);
  return (
    parent === tmpdir().replace(/[/\\]$/, "") &&
    base.startsWith(CONFIG_DIR_PREFIX)
  );
}

/**
 * Removes the config file named by `--mcp-config` in `args`, and the private
 * directory holding it.
 *
 * Takes the argv rather than a path so the caller does not have to thread a
 * second value around: `buildArgs` is the only thing that knows whether a
 * config file was written at all, and the path it chose is already recorded
 * in the argv it returned.
 *
 * Never throws. A run whose temp file has already gone (a second call, a
 * cleaned `/tmp`) is not a failure worth propagating into a turn.
 */
export function cleanupMcpConfigFile(args: readonly string[]): void {
  const index = args.indexOf(MCP_CONFIG_FLAG);
  const path = index === -1 ? undefined : args[index + 1];
  if (!path?.includes(sep) || !isOwnConfigFile(path)) {
    return;
  }

  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    // Best effort: the file is 0600 in a 0700 directory either way.
  }
}
