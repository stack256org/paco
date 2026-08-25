import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test is server-only.
mock.module("server-only", () => ({}));

type FakePluginRow = { id: string; enabled: boolean };

let pluginRows: FakePluginRow[] = [];
let listPluginsError: Error | undefined;
// Spread over the real module the same way `contributions.test.ts` does:
// `install.ts` (imported transitively via `pluginDir`) imports
// `upsertPlugin` from this same module, so a from-scratch mock would break
// that import for no reason related to what this file tests.
const realDbPlugins = await import("@/lib/db/plugins");
async function listPluginsMock(): Promise<FakePluginRow[]> {
  if (listPluginsError) {
    throw listPluginsError;
  }
  return pluginRows;
}
mock.module("@/lib/db/plugins", () => ({
  ...realDbPlugins,
  listPlugins: listPluginsMock,
}));

const { enabledPluginRenderers } = await import("./renderer-info.ts");

let pluginsRoot: string;
const consoleErrorCalls: unknown[][] = [];
const originalConsoleError = console.error;

beforeEach(async () => {
  pluginsRoot = await mkdtemp(
    path.join(os.tmpdir(), "paco-plugins-renderer-fixture-"),
  );
  process.env.PACO_PLUGINS_DIR = pluginsRoot;
  pluginRows = [];
  listPluginsError = undefined;
  consoleErrorCalls.length = 0;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
});

afterEach(async () => {
  console.error = originalConsoleError;
  delete process.env.PACO_PLUGINS_DIR;
  await rm(pluginsRoot, { recursive: true, force: true });
});

async function writeManifest(pluginId: string): Promise<void> {
  const dir = path.join(pluginsRoot, pluginId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      description: "a fixture plugin",
      pacoApi: 1,
      capabilities: [],
    }),
    "utf-8",
  );
}

async function writeRenderer(
  pluginId: string,
  toolName: string,
): Promise<void> {
  const renderersDir = path.join(pluginsRoot, pluginId, "renderers");
  await mkdir(renderersDir, { recursive: true });
  await writeFile(
    path.join(renderersDir, `${toolName}.html`),
    "<!doctype html><html><body>hi</body></html>",
    "utf-8",
  );
}

describe("enabledPluginRenderers", () => {
  test("returns tool names for an enabled plugin's renderer files", async () => {
    await writeManifest("demo-plugin");
    await writeRenderer("demo-plugin", "search_docs");
    await writeRenderer("demo-plugin", "lookup_ticket");
    pluginRows = [{ id: "demo-plugin", enabled: true }];

    const result = await enabledPluginRenderers();

    expect(result).toEqual([
      { pluginId: "demo-plugin", toolNames: ["lookup_ticket", "search_docs"] },
    ]);
  });

  test("excludes a disabled plugin even if it has renderer files on disk", async () => {
    await writeManifest("demo-plugin");
    await writeRenderer("demo-plugin", "search_docs");
    pluginRows = [{ id: "demo-plugin", enabled: false }];

    expect(await enabledPluginRenderers()).toEqual([]);
  });

  test("omits an enabled plugin that has no renderers directory", async () => {
    await writeManifest("no-renderers-plugin");
    pluginRows = [{ id: "no-renderers-plugin", enabled: true }];

    expect(await enabledPluginRenderers()).toEqual([]);
  });

  test("logs and skips an enabled plugin whose manifest fails to discover, without throwing", async () => {
    // No plugin.json written at all for this id.
    pluginRows = [{ id: "missing-plugin", enabled: true }];

    await expect(enabledPluginRenderers()).resolves.toEqual([]);
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
  });

  test("never throws when listPlugins fails", async () => {
    listPluginsError = new Error("db is down");

    await expect(enabledPluginRenderers()).resolves.toEqual([]);
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
  });
});
