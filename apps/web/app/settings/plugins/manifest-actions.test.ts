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

type FakeRow = {
  id: string;
  manifest: {
    netDomains?: string[];
    channels?: { name: string; auth: "shared-secret" | "self-verified" }[];
  };
};
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
  ensurePluginIngressSecret: async () => {
    // Unreachable from this file's tests.
  },
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

const { getPluginConsentDetailsAction } = await import("./manifest-actions");

describe("getPluginConsentDetailsAction", () => {
  test("rejects a non-admin caller", async () => {
    adminOk = false;
    rows = new Map();
    await expect(getPluginConsentDetailsAction("some-plugin")).rejects.toThrow(
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

    const result = await getPluginConsentDetailsAction("linear-bridge");

    expect(result).toEqual({
      ok: true,
      netDomains: ["api.linear.app"],
      selfVerifiedChannels: [],
    });
  });

  test("returns an empty list when the manifest declares no domains", async () => {
    rows = new Map([["no-net", { id: "no-net", manifest: {} }]]);

    const result = await getPluginConsentDetailsAction("no-net");

    expect(result).toEqual({
      ok: true,
      netDomains: [],
      selfVerifiedChannels: [],
    });
  });

  test("returns only the channels declared self-verified, by name", async () => {
    // A shared-secret channel must NOT appear here: the warning this drives
    // is about the channels Paco stops checking a secret for, and listing a
    // secret-gated one would make the consent screen overstate the risk.
    rows = new Map([
      [
        "slack",
        {
          id: "slack",
          manifest: {
            channels: [
              { name: "events", auth: "self-verified" },
              { name: "commands", auth: "shared-secret" },
            ],
          },
        },
      ],
    ]);

    const result = await getPluginConsentDetailsAction("slack");

    expect(result).toEqual({
      ok: true,
      netDomains: [],
      selfVerifiedChannels: ["events"],
    });
  });

  test("reports a plugin that does not exist, rather than throwing", async () => {
    rows = new Map();

    const result = await getPluginConsentDetailsAction("ghost");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ghost");
    }
  });
});
