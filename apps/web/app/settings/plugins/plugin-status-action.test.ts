import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Capability } from "@paco/plugin-kit";

mock.module("server-only", () => ({}));

let adminOk = true;
mock.module("@/lib/admin/require-admin", () => ({
  requireAdmin: async () => {
    if (!adminOk) {
      throw new Error("Not an administrator");
    }
    return "admin-1";
  },
}));

type FakeRow = {
  id: string;
  source: string;
  version: string;
  manifest: { capabilities: Capability[] };
  grantedCapabilities: Capability[];
  enabled: boolean;
};

let rows: FakeRow[];
mock.module("@/lib/db/plugins", () => ({
  listPlugins: async () => rows,
}));

type FakeHostState = "starting" | "running" | "crashed" | "stopped";
let registry: Map<string, { state: FakeHostState }>;
mock.module("@/lib/plugins/registry", () => ({
  getPluginRegistry: () => registry,
}));

const { pluginStatusAction } = await import("./plugin-status-action.ts");

function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    source: "local:/tmp",
    version: "1.0.0",
    manifest: { capabilities: ["tools:register"] },
    grantedCapabilities: [],
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  adminOk = true;
  rows = [];
  registry = new Map();
});

describe("pluginStatusAction", () => {
  test("throws when the caller is not an admin", async () => {
    adminOk = false;
    await expect(pluginStatusAction()).rejects.toThrow(/administrator/);
  });

  test("reports a running host's state", async () => {
    rows = [row("plugin-a")];
    registry.set("plugin-a", { state: "running" });

    expect(await pluginStatusAction()).toEqual({ "plugin-a": "running" });
  });

  test("reports a crashed host's state", async () => {
    rows = [row("plugin-a")];
    registry.set("plugin-a", { state: "crashed" });

    expect(await pluginStatusAction()).toEqual({ "plugin-a": "crashed" });
  });

  test("reports not-running for a plugin absent from the registry", async () => {
    rows = [row("plugin-a", { enabled: false })];

    expect(await pluginStatusAction()).toEqual({ "plugin-a": "not-running" });
  });
});
