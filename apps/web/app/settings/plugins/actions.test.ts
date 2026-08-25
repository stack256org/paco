import { mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Capability } from "@paco/plugin-kit";

mock.module("server-only", () => ({}));

// --- admin gate --------------------------------------------------------

let adminOk = true;
mock.module("@/lib/admin/require-admin", () => ({
  requireAdmin: async () => {
    if (!adminOk) {
      throw new Error("Not an administrator");
    }
    return "admin-1";
  },
}));

// --- @/lib/db/plugins ----------------------------------------------------

class FakePluginGrantEscalationError extends Error {
  constructor(
    pluginId: string,
    requested: Capability[],
    declared: Capability[],
  ) {
    super(
      `Plugin "${pluginId}" requested grants ${JSON.stringify(requested)} that are not a subset of its declared capabilities ${JSON.stringify(declared)}`,
    );
    this.name = "FakePluginGrantEscalationError";
  }
}

type FakeRow = {
  id: string;
  manifest: { capabilities: Capability[]; netDomains?: string[] };
  grantedCapabilities: Capability[];
  consentedNetDomains: string[];
  enabled: boolean;
};

let rows: Map<string, FakeRow>;

async function getPluginImpl(id: string): Promise<FakeRow | undefined> {
  return rows.get(id);
}

async function setPluginEnabledImpl(
  id: string,
  enabled: boolean,
): Promise<void> {
  const row = rows.get(id);
  if (row) {
    row.enabled = enabled;
  }
}

async function setPluginGrantsImpl(
  id: string,
  grants: Capability[],
): Promise<void> {
  const row = rows.get(id);
  if (!row) {
    throw new Error(`No plugin installed with id "${id}"`);
  }
  const declared = row.manifest.capabilities;
  const escalated = grants.filter((grant) => !declared.includes(grant));
  if (escalated.length > 0) {
    throw new FakePluginGrantEscalationError(id, grants, declared);
  }
  row.grantedCapabilities = grants;
  row.consentedNetDomains = row.manifest.netDomains ?? [];
}

async function removePluginImpl(id: string): Promise<void> {
  rows.delete(id);
}

mock.module("@/lib/db/plugins", () => ({
  PluginGrantEscalationError: FakePluginGrantEscalationError,
  getPlugin: (id: string) => getPluginImpl(id),
  // Unused by anything this file exercises, but `lib/plugins/registry.ts`
  // (now the real, unmocked module backing `startPluginHost`/
  // `stopPluginHost`) imports it too, and a named ESM import is validated
  // against the mocked module's exports at load time regardless of whether
  // the importing code path is actually reached.
  listPlugins: () => Promise.resolve([...rows.values()]),
  setPluginEnabled: (id: string, enabled: boolean) =>
    setPluginEnabledImpl(id, enabled),
  setPluginGrants: (id: string, grants: Capability[]) =>
    setPluginGrantsImpl(id, grants),
  removePlugin: (id: string) => removePluginImpl(id),
}));

// --- @/lib/plugins/install -------------------------------------------------

type InstallResult =
  | { ok: true; pluginId: string; requested: Capability[] }
  | { ok: false; error: string };

let installBehavior: (source: unknown) => Promise<InstallResult>;
const installCalls: unknown[] = [];
let pluginDirImpl: (id: string) => string = (id) => `/plugins/${id}`;

mock.module("@/lib/plugins/install", () => ({
  installPlugin: (source: unknown) => {
    installCalls.push(source);
    return installBehavior(source);
  },
  pluginDir: (id: string) => pluginDirImpl(id),
  // Unused by anything this file exercises directly, but `lib/plugins/registry.ts`
  // (the real, unmocked module backing `startPluginHost`/`stopPluginHost` — see
  // the registry section below) calls it before every start; a passing default
  // keeps this file's own start/stop tests exercising what they were written
  // to exercise instead of failing on unrelated integrity-check plumbing.
  recheckPluginIntegrity: () => Promise.resolve({ ok: true }),
}));

// --- @paco/plugin-kit --------------------------------------------------

let discoverBehavior: (rootDir: string) => Promise<
  | {
      ok: true;
      plugin: {
        manifest: { name: string; capabilities: Capability[] };
        rootDir: string;
      };
    }
  | { ok: false; error: string }
>;

mock.module("@paco/plugin-kit", () => ({
  discoverPlugin: (rootDir: string) => discoverBehavior(rootDir),
}));

// --- @paco/plugin-host ---------------------------------------------------

let startBehavior: () => Promise<{ tools: [] }>;
let stopCalls: string[];

type FakePluginHost = {
  id: string;
  start: () => Promise<{ tools: [] }>;
  stop: () => Promise<void>;
};

/**
 * A plain factory rather than a `class` — this file already declares
 * `FakePluginGrantEscalationError`, and Ultracite's `max-classes-per-file`
 * caps a file at one. The shape (an object with `start`/`stop`) is all
 * `startPluginHost`/`stopPluginHost` in `actions.ts` ever touch.
 */
function makeFakePluginHost(options: {
  descriptor: { manifest: { name: string } };
}): FakePluginHost {
  const id = options.descriptor.manifest.name;
  return {
    id,
    start: () => startBehavior(),
    stop: () => {
      stopCalls.push(id);
      return Promise.resolve();
    },
  };
}

mock.module("@paco/plugin-host", () => ({ PluginHost: makeFakePluginHost }));

// --- @/lib/plugins/capability-handlers -----------------------------------

mock.module("@/lib/plugins/capability-handlers", () => ({
  buildCapabilityHandlers: () => ({}),
}));

// --- @/lib/plugins/registry ------------------------------------------------
//
// Deliberately NOT mocked: `startPluginHost`/`stopPluginHost` now live in
// `lib/plugins/registry.ts` (Task 7 consolidated them out of this file), so
// this test exercises the real registry module against the same mocked
// `@paco/plugin-host`/`@paco/plugin-kit`/`@/lib/plugins/install`/
// `@/lib/db/plugins` it already set up above — the same approach
// `lib/plugins/registry.test.ts` uses for the registry's own tests.

const registryModule = await import("@/lib/plugins/registry");

/** The real, shared registry `Map` — cast for this file's `FakePluginHost`. */
function registry(): Map<string, FakePluginHost> {
  return registryModule.getPluginRegistry() as unknown as Map<
    string,
    FakePluginHost
  >;
}

const {
  disablePluginAction,
  grantAndEnableAction,
  installPluginAction,
  parseInstallSource,
  removePluginAction,
} = await import("./actions");

function makeRow(id: string, capabilities: Capability[] = []): FakeRow {
  return {
    id,
    manifest: {
      capabilities,
      netDomains: capabilities.includes("net:fetch")
        ? ["api.example.com"]
        : undefined,
    },
    grantedCapabilities: [],
    consentedNetDomains: [],
    enabled: false,
  };
}

beforeEach(() => {
  adminOk = true;
  rows = new Map();
  registry().clear();
  (
    globalThis as typeof globalThis & { __pacoPluginStartLocks?: unknown }
  ).__pacoPluginStartLocks = undefined;
  stopCalls = [];
  installCalls.length = 0;
  pluginDirImpl = (id) => `/plugins/${id}`;
  installBehavior = async () => ({
    ok: true,
    pluginId: "some-plugin",
    requested: ["storage:kv"],
  });
  discoverBehavior = async (rootDir) => ({
    ok: true,
    plugin: {
      manifest: {
        name: rootDir.split("/").pop() ?? "unknown",
        capabilities: [],
      },
      rootDir,
    },
  });
  startBehavior = async () => ({ tools: [] });
});

describe("parseInstallSource", () => {
  test("parses a bare owner/repo", () => {
    expect(parseInstallSource("acme/widgets")).toEqual({
      ok: true,
      source: { kind: "github", repo: "acme/widgets", ref: undefined },
    });
  });

  test("parses an owner/repo#ref", () => {
    expect(parseInstallSource("acme/widgets#v2")).toEqual({
      ok: true,
      source: { kind: "github", repo: "acme/widgets", ref: "v2" },
    });
  });

  test("parses a local:/abs/path source", () => {
    expect(parseInstallSource("local:/opt/my-plugin")).toEqual({
      ok: true,
      source: { kind: "local", path: "/opt/my-plugin" },
    });
  });

  test("rejects a non-absolute local path", () => {
    const result = parseInstallSource("local:relative/path");
    expect(result.ok).toBe(false);
  });

  test("rejects an empty repo", () => {
    const result = parseInstallSource("#v2");
    expect(result.ok).toBe(false);
  });
});

describe("admin gate", () => {
  test("a non-admin is rejected for every action", async () => {
    adminOk = false;

    await expect(
      installPluginAction({ source: "acme/widgets" }),
    ).rejects.toThrow();
    await expect(
      grantAndEnableAction({ pluginId: "p", grants: [] }),
    ).rejects.toThrow();
    await expect(disablePluginAction({ pluginId: "p" })).rejects.toThrow();
    await expect(removePluginAction({ pluginId: "p" })).rejects.toThrow();
  });
});

describe("installPluginAction", () => {
  test("yields disabled+ungranted and returns the requested capabilities", async () => {
    installBehavior = async () => ({
      ok: true,
      pluginId: "widgets",
      requested: ["storage:kv", "net:fetch"],
    });

    const result = await installPluginAction({ source: "acme/widgets" });

    expect(result).toEqual({
      ok: true,
      pluginId: "widgets",
      requested: ["storage:kv", "net:fetch"],
    });
    expect(installCalls).toEqual([
      { kind: "github", repo: "acme/widgets", ref: undefined },
    ]);
  });

  test("surfaces an install failure as a value", async () => {
    installBehavior = async () => ({ ok: false, error: "git clone failed" });

    const result = await installPluginAction({ source: "acme/widgets" });

    expect(result).toEqual({ ok: false, error: "git clone failed" });
  });

  test("rejects an unparseable source before ever calling installPlugin", async () => {
    const result = await installPluginAction({ source: "local:relative" });

    expect(result.ok).toBe(false);
    expect(installCalls).toEqual([]);
  });
});

describe("grantAndEnableAction", () => {
  test("enforces the grant subset rule as an error value, not a throw", async () => {
    rows.set("widgets", makeRow("widgets", ["storage:kv"]));

    const result = await grantAndEnableAction({
      pluginId: "widgets",
      grants: ["net:fetch"],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a subset/);
    expect(rows.get("widgets")?.enabled).toBe(false);
    expect(registry().size).toBe(0);
  });

  test("grants, enables, and starts the host", async () => {
    rows.set("widgets", makeRow("widgets", ["storage:kv"]));

    const result = await grantAndEnableAction({
      pluginId: "widgets",
      grants: ["storage:kv"],
    });

    expect(result).toEqual({ ok: true });
    expect(rows.get("widgets")?.enabled).toBe(true);
    expect(rows.get("widgets")?.grantedCapabilities).toEqual(["storage:kv"]);
    expect(registry().has("widgets")).toBe(true);
  });

  test("surfaces a host start failure, including the Node-floor message, verbatim", async () => {
    rows.set("widgets", makeRow("widgets", ["storage:kv"]));
    const nodeFloorMessage =
      "plugin widgets cannot start: the runtime at /usr/bin/node reports major version 18, but a hardened plugin worker requires Node >= 24. Point the `nodeExecutable` option at a Node >= 24 binary.";
    startBehavior = async () => {
      throw new Error(nodeFloorMessage);
    };

    const result = await grantAndEnableAction({
      pluginId: "widgets",
      grants: ["storage:kv"],
    });

    expect(result).toEqual({ ok: false, error: nodeFloorMessage });
    // Enabling already happened; only the host failed to start.
    expect(rows.get("widgets")?.enabled).toBe(true);
    expect(registry().has("widgets")).toBe(false);
  });

  test("does not start a second host when one is already registered", async () => {
    rows.set("widgets", makeRow("widgets", ["storage:kv"]));
    const already = makeFakePluginHost({
      descriptor: { manifest: { name: "widgets" } },
    });
    registry().set("widgets", already);

    const result = await grantAndEnableAction({
      pluginId: "widgets",
      grants: ["storage:kv"],
    });

    expect(result).toEqual({ ok: true });
    expect(registry().get("widgets")).toBe(already);
  });
});

describe("disablePluginAction", () => {
  test("stops the host and sets enabled false", async () => {
    rows.set("widgets", { ...makeRow("widgets"), enabled: true });
    const host = makeFakePluginHost({
      descriptor: { manifest: { name: "widgets" } },
    });
    registry().set("widgets", host);

    const result = await disablePluginAction({ pluginId: "widgets" });

    expect(result).toEqual({ ok: true });
    expect(stopCalls).toEqual(["widgets"]);
    expect(registry().has("widgets")).toBe(false);
    expect(rows.get("widgets")?.enabled).toBe(false);
  });

  test("is a no-op on the host when none is running", async () => {
    rows.set("widgets", { ...makeRow("widgets"), enabled: true });

    const result = await disablePluginAction({ pluginId: "widgets" });

    expect(result).toEqual({ ok: true });
    expect(stopCalls).toEqual([]);
    expect(rows.get("widgets")?.enabled).toBe(false);
  });
});

describe("removePluginAction", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paco-plugin-remove-"));
    pluginDirImpl = () => tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("stops the host, removes the plugin directory, and deletes the row", async () => {
    rows.set("widgets", { ...makeRow("widgets"), enabled: true });
    const host = makeFakePluginHost({
      descriptor: { manifest: { name: "widgets" } },
    });
    registry().set("widgets", host);

    const result = await removePluginAction({ pluginId: "widgets" });

    expect(result).toEqual({ ok: true });
    expect(stopCalls).toEqual(["widgets"]);
    expect(registry().has("widgets")).toBe(false);
    expect(rows.has("widgets")).toBe(false);
    await expect(stat(tempDir)).rejects.toThrow();
  });

  test("removing a plugin with no directory on disk does not throw", async () => {
    rows.set("widgets", makeRow("widgets"));
    await rm(tempDir, { recursive: true, force: true });

    await expect(removePluginAction({ pluginId: "widgets" })).resolves.toEqual({
      ok: true,
    });
  });
});
