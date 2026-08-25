import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PluginManifest } from "@paco/plugin-kit";
import type { PluginRow } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

type StartResult = { tools: [] };
let startBehavior: (id: string) => Promise<StartResult>;
let startedIds: string[];

class FakePluginHost {
  static instances: FakePluginHost[] = [];
  id: string;
  constructor(options: { descriptor: { manifest: { name: string } } }) {
    this.id = options.descriptor.manifest.name;
    FakePluginHost.instances.push(this);
  }
  async start(): Promise<StartResult> {
    startedIds.push(this.id);
    return await startBehavior(this.id);
  }
}

mock.module("@paco/plugin-host", () => ({ PluginHost: FakePluginHost }));

let discoverBehavior: (
  rootDir: string,
) => Promise<
  | { ok: true; plugin: { manifest: { name: string }; rootDir: string } }
  | { ok: false; error: string }
>;

mock.module("@paco/plugin-kit", () => ({
  discoverPlugin: (rootDir: string) => discoverBehavior(rootDir),
}));

mock.module("@/lib/plugins/install", () => ({
  pluginDir: (id: string) => `/plugins/${id}`,
}));

mock.module("@/lib/plugins/capability-handlers", () => ({
  buildCapabilityHandlers: () => ({}),
}));

let rows: PluginRow[];
let listPluginsBehavior: () => Promise<PluginRow[]>;
mock.module("@/lib/db/plugins", () => ({
  listPlugins: () => listPluginsBehavior(),
}));

const { ensurePluginsStarted, getPluginRegistry } =
  await import("./registry.ts");

function row(id: string, enabled = true): PluginRow {
  return {
    id,
    source: "local:/tmp",
    version: "1.0.0",
    contentHash: "hash",
    manifest: {
      name: id,
      version: "1.0.0",
      description: "d",
      pacoApi: 1,
      capabilities: [],
    } as PluginManifest,
    grantedCapabilities: [],
    consentedNetDomains: [],
    enabled,
    installedAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      __pacoPluginRegistry?: unknown;
      __pacoPluginStartLocks?: unknown;
    }
  ).__pacoPluginRegistry = undefined;
  (
    globalThis as typeof globalThis & {
      __pacoPluginRegistry?: unknown;
      __pacoPluginStartLocks?: unknown;
    }
  ).__pacoPluginStartLocks = undefined;

  FakePluginHost.instances = [];
  startedIds = [];
  rows = [];
  listPluginsBehavior = async () => rows;
  startBehavior = async () => ({ tools: [] });
  discoverBehavior = async (rootDir) => ({
    ok: true,
    plugin: {
      manifest: { name: rootDir.split("/").pop() ?? "unknown" },
      rootDir,
    },
  });
});

describe("ensurePluginsStarted", () => {
  test("starts a host for every enabled plugin and registers it", async () => {
    rows = [row("plugin-a"), row("plugin-b")];

    await ensurePluginsStarted();

    const registry = getPluginRegistry();
    expect([...registry.keys()].sort()).toEqual(["plugin-a", "plugin-b"]);
    expect(startedIds.sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  test("skips disabled plugins", async () => {
    rows = [row("plugin-a", true), row("plugin-b", false)];

    await ensurePluginsStarted();

    expect([...getPluginRegistry().keys()]).toEqual(["plugin-a"]);
  });

  test("does not start a plugin already in the registry", async () => {
    rows = [row("plugin-a")];
    await ensurePluginsStarted();
    expect(startedIds).toEqual(["plugin-a"]);

    // Second call: plugin-a is already registered, so it must not be
    // started again even though listPlugins still reports it.
    await ensurePluginsStarted();
    expect(startedIds).toEqual(["plugin-a"]);
  });

  test("never throws when listPlugins fails", async () => {
    listPluginsBehavior = async () => {
      throw new Error("db is down");
    };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();
    expect([...getPluginRegistry().keys()]).toEqual([]);
  });

  test("logs and skips a plugin whose discovery fails, without throwing", async () => {
    rows = [row("plugin-a"), row("plugin-b")];
    discoverBehavior = async (rootDir) => {
      if (rootDir.endsWith("plugin-a")) {
        return { ok: false, error: "manifest is invalid" };
      }
      return {
        ok: true,
        plugin: { manifest: { name: "plugin-b" }, rootDir },
      };
    };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();
    expect([...getPluginRegistry().keys()]).toEqual(["plugin-b"]);
  });

  test("logs and skips a plugin whose host fails to start, without throwing", async () => {
    rows = [row("plugin-a"), row("plugin-b")];
    startBehavior = async (id) => {
      if (id === "plugin-a") {
        throw new Error("worker crashed on boot");
      }
      return { tools: [] };
    };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();
    expect([...getPluginRegistry().keys()]).toEqual(["plugin-b"]);
  });

  test("two concurrent calls do not start the same plugin twice", async () => {
    rows = [row("plugin-a")];
    const deferred = Promise.withResolvers<StartResult>();
    startBehavior = () => deferred.promise;

    const first = ensurePluginsStarted();
    const second = ensurePluginsStarted();
    deferred.resolve({ tools: [] });
    await Promise.all([first, second]);

    expect(startedIds).toEqual(["plugin-a"]);
  });
});
