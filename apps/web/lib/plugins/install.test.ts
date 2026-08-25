import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type PluginRow = {
  id: string;
  source: string;
  version: string;
  contentHash: string;
  manifest: unknown;
  grantedCapabilities: unknown;
  enabled: boolean;
};

const upsertPluginCalls: PluginRow[] = [];
let upsertPluginImpl: (row: PluginRow) => Promise<void> = async (row) => {
  upsertPluginCalls.push(row);
};

mock.module("@/lib/db/plugins", () => ({
  upsertPlugin: (row: PluginRow) => upsertPluginImpl(row),
}));

const execFileCalls: { command: string; args: string[] }[] = [];
let execFileImpl: (
  command: string,
  args: string[],
  callback: (
    error: unknown,
    result: { stdout: string; stderr: string },
  ) => void,
) => void = (_command, _args, callback) => {
  callback(null, { stdout: "", stderr: "" });
};

mock.module("node:child_process", () => ({
  execFile: (
    command: string,
    args: string[],
    callback: (
      error: unknown,
      result: { stdout: string; stderr: string },
    ) => void,
  ) => {
    execFileCalls.push({ command, args });
    execFileImpl(command, args, callback);
  },
}));

const { buildCloneArgs, installPlugin } = await import("./install");

let pluginsRoot: string;
let localSourceDirs: string[] = [];

function writeManifest(
  dir: string,
  overrides: Partial<{
    name: string;
    version: string;
    description: string;
    pacoApi: number;
    capabilities: string[];
  }> = {},
) {
  const manifest = {
    name: "sample-plugin",
    version: "1.0.0",
    description: "A sample plugin",
    pacoApi: 1,
    capabilities: [],
    ...overrides,
  };
  return writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
}

async function makeLocalSource(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paco-plugin-source-"));
  localSourceDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  pluginsRoot = await mkdtemp(path.join(os.tmpdir(), "paco-plugins-root-"));
  process.env.PACO_PLUGINS_DIR = pluginsRoot;
  upsertPluginCalls.length = 0;
  execFileCalls.length = 0;
  upsertPluginImpl = async (row) => {
    upsertPluginCalls.push(row);
  };
  execFileImpl = (_command, _args, callback) => {
    callback(null, { stdout: "", stderr: "" });
  };
});

afterEach(async () => {
  delete process.env.PACO_PLUGINS_DIR;
  await rm(pluginsRoot, { recursive: true, force: true });
  await Promise.all(
    localSourceDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  localSourceDirs = [];
});

describe("buildCloneArgs", () => {
  test("builds argv for a bare repo", () => {
    expect(buildCloneArgs("acme/widgets")).toEqual([
      "clone",
      "--depth",
      "1",
      "https://github.com/acme/widgets",
    ]);
  });

  test("builds argv with a branch/ref", () => {
    expect(buildCloneArgs("acme/widgets", "main")).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "https://github.com/acme/widgets",
    ]);
  });

  test("rejects a repo that isn't owner/name", () => {
    expect(() => buildCloneArgs("acme/widgets; rm -rf /")).toThrow();
    expect(() => buildCloneArgs("../../etc/passwd")).toThrow();
  });

  test("rejects a ref carrying a flag-like or shell-metacharacter value", () => {
    expect(() =>
      buildCloneArgs("acme/widgets", "--upload-pack=evil"),
    ).toThrow();
    expect(() => buildCloneArgs("acme/widgets", "main; rm -rf /")).toThrow();
  });
});

describe("installPlugin", () => {
  test("installs a valid local plugin disabled, ungranted, with a content hash", async () => {
    const source = await makeLocalSource();
    await writeManifest(source);
    await mkdir(path.join(source, "tools"), { recursive: true });
    await writeFile(path.join(source, "tools", "hello.ts"), "export {};");

    const result = await installPlugin({ kind: "local", path: source });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("sample-plugin");
    expect(result.requested).toEqual([]);

    expect(upsertPluginCalls).toHaveLength(1);
    const row = upsertPluginCalls[0];
    expect(row.id).toBe("sample-plugin");
    expect(row.enabled).toBe(false);
    expect(row.grantedCapabilities).toEqual([]);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.source).toBe(`local:${source}`);

    const installedDir = path.join(pluginsRoot, "sample-plugin");
    const entries = await readdir(installedDir);
    expect(entries.sort()).toEqual(["plugin.json", "tools"]);
  });

  test("an invalid manifest installs nothing on disk or in the db", async () => {
    const source = await makeLocalSource();
    await writeFile(
      path.join(source, "plugin.json"),
      JSON.stringify({ nope: true }),
    );

    const result = await installPlugin({ kind: "local", path: source });

    expect(result.ok).toBe(false);
    expect(upsertPluginCalls).toHaveLength(0);

    const remainingEntries = await readdir(pluginsRoot);
    expect(remainingEntries).toEqual([]);
  });

  test("re-installing the same plugin id updates it in place", async () => {
    const sourceV1 = await makeLocalSource();
    await writeManifest(sourceV1, { version: "1.0.0" });
    await writeFile(path.join(sourceV1, "marker.txt"), "v1");

    const first = await installPlugin({ kind: "local", path: sourceV1 });
    expect(first.ok).toBe(true);

    const sourceV2 = await makeLocalSource();
    await writeManifest(sourceV2, { version: "2.0.0" });
    await writeFile(path.join(sourceV2, "marker.txt"), "v2");

    const second = await installPlugin({ kind: "local", path: sourceV2 });
    expect(second.ok).toBe(true);

    expect(upsertPluginCalls).toHaveLength(2);
    expect(upsertPluginCalls[1].version).toBe("2.0.0");
    expect(upsertPluginCalls[1].contentHash).not.toBe(
      upsertPluginCalls[0].contentHash,
    );

    const installedDir = path.join(pluginsRoot, "sample-plugin");
    const marker = await readFile(
      path.join(installedDir, "marker.txt"),
      "utf-8",
    );
    expect(marker).toBe("v2");

    // Only one live directory for the plugin id — no leftover backup dirs.
    const rootEntries = await readdir(pluginsRoot);
    expect(rootEntries).toEqual(["sample-plugin"]);
  });

  test("a failed re-install (db write throws) keeps the previously installed copy", async () => {
    const sourceV1 = await makeLocalSource();
    await writeManifest(sourceV1, { version: "1.0.0" });
    await writeFile(path.join(sourceV1, "marker.txt"), "v1");

    const first = await installPlugin({ kind: "local", path: sourceV1 });
    expect(first.ok).toBe(true);

    upsertPluginImpl = async () => {
      throw new Error("simulated db failure");
    };

    const sourceV2 = await makeLocalSource();
    await writeManifest(sourceV2, { version: "2.0.0" });
    await writeFile(path.join(sourceV2, "marker.txt"), "v2");

    const second = await installPlugin({ kind: "local", path: sourceV2 });
    expect(second.ok).toBe(false);

    const installedDir = path.join(pluginsRoot, "sample-plugin");
    const marker = await readFile(
      path.join(installedDir, "marker.txt"),
      "utf-8",
    );
    expect(marker).toBe("v1");

    const manifestOnDisk = JSON.parse(
      await readFile(path.join(installedDir, "plugin.json"), "utf-8"),
    );
    expect(manifestOnDisk.version).toBe("1.0.0");

    // No stray backup or temp directories left behind.
    const rootEntries = await readdir(pluginsRoot);
    expect(rootEntries).toEqual(["sample-plugin"]);
  });

  test("github source clones via execFile with validated argv, never a shell", async () => {
    const result = await installPlugin({
      kind: "github",
      repo: "acme/widgets",
      ref: "main",
    });

    // The mocked execFile does nothing, so there's no plugin.json for
    // discoverPlugin to find in the clone target — that's expected. This
    // test only asserts on how git was invoked, matching the brief's "no
    // network in tests" constraint for the github path.
    expect(result.ok).toBe(false);

    expect(execFileCalls).toHaveLength(1);
    const call = execFileCalls[0];
    expect(call.command).toBe("git");
    expect(call.args[0]).toBe("clone");
    expect(call.args).toContain("https://github.com/acme/widgets");
    expect(call.args).toContain("--branch");
    expect(call.args).toContain("main");
    // Destination is the last argv element, appended by installPlugin.
    expect(call.args.at(-1)?.startsWith(pluginsRoot)).toBe(true);

    // No leftover temp directory from the aborted install.
    const rootEntries = await readdir(pluginsRoot);
    expect(rootEntries).toEqual([]);
  });

  test("an invalid github repo never reaches execFile", async () => {
    const result = await installPlugin({
      kind: "github",
      repo: "acme/widgets; rm -rf /",
    });

    expect(result.ok).toBe(false);
    expect(execFileCalls).toHaveLength(0);
  });
});
