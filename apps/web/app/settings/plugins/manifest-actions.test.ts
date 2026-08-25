import { describe, expect, mock, test } from "bun:test";

let adminOk = true;
mock.module("@/lib/admin/require-admin", () => ({
  requireAdmin: async () => {
    if (!adminOk) {
      throw new Error("Not an administrator");
    }
    return "admin-1";
  },
}));

type FakeRow = { id: string; manifest: { netDomains?: string[] } };
let rows: Map<string, FakeRow>;

class FakePluginGrantEscalationError extends Error {
  constructor() {
    super("escalation");
    this.name = "FakePluginGrantEscalationError";
  }
}

/**
 * A full stand-in for `@/lib/db/plugins`, not just `getPlugin`.
 *
 * Bun's `mock.module` replaces a module specifier for the whole test run,
 * not just this file — `./actions.test.ts` mocks the same specifier with
 * its own shape, and whichever mock is in effect when a given import
 * resolves must satisfy every named export anything in this directory pulls
 * from it (see that file's own comment on the same point). Only `getPlugin`
 * does anything here; the rest are unreachable stubs kept solely so a
 * named-export check against this mock never fails for code this file
 * never exercises.
 */
mock.module("@/lib/db/plugins", () => ({
  PluginGrantEscalationError: FakePluginGrantEscalationError,
  getPlugin: async (id: string) => rows.get(id),
  listPlugins: async () => [...rows.values()],
  removePlugin: async () => {
    // Unreachable from this file's tests.
  },
  setPluginEnabled: async () => {
    // Unreachable from this file's tests.
  },
  setPluginGrants: async () => {
    // Unreachable from this file's tests.
  },
}));

const { getPluginNetDomainsAction } = await import("./manifest-actions");

describe("getPluginNetDomainsAction", () => {
  test("rejects a non-admin caller", async () => {
    adminOk = false;
    rows = new Map();
    await expect(getPluginNetDomainsAction("some-plugin")).rejects.toThrow(
      "Not an administrator",
    );
    adminOk = true;
  });

  test("returns the manifest's exact declared net:fetch domains", async () => {
    rows = new Map([
      [
        "linear-bridge",
        { id: "linear-bridge", manifest: { netDomains: ["api.linear.app"] } },
      ],
    ]);

    const result = await getPluginNetDomainsAction("linear-bridge");

    expect(result).toEqual({ ok: true, netDomains: ["api.linear.app"] });
  });

  test("returns an empty list when the manifest declares no domains", async () => {
    rows = new Map([["no-net", { id: "no-net", manifest: {} }]]);

    const result = await getPluginNetDomainsAction("no-net");

    expect(result).toEqual({ ok: true, netDomains: [] });
  });

  test("reports a plugin that does not exist, rather than throwing", async () => {
    rows = new Map();

    const result = await getPluginNetDomainsAction("ghost");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ghost");
    }
  });
});
