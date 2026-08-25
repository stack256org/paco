import { describe, expect, test } from "bun:test";
import type { Capability } from "@paco/plugin-kit";
import { removeWithConfirm, toggleEnabled } from "./plugin-mutations";
import type { PluginListRow } from "./plugin-list-row";

function plugin(overrides: Partial<PluginListRow> = {}): PluginListRow {
  return {
    id: "linear-bridge",
    source: "github:acme/linear-bridge#main",
    version: "1.2.0",
    enabled: false,
    grantedCapabilities: ["events:subscribe", "net:fetch"],
    ...overrides,
  };
}

describe("toggleEnabled", () => {
  test("turning it on re-grants exactly the capabilities it already holds", async () => {
    const calls: unknown[] = [];
    const result = await toggleEnabled(plugin(), true, {
      grantAndEnableAction: async (input) => {
        calls.push({ action: "grant", input });
        return { ok: true };
      },
      disablePluginAction: async (input) => {
        calls.push({ action: "disable", input });
        return { ok: true };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        action: "grant",
        input: {
          pluginId: "linear-bridge",
          grants: ["events:subscribe", "net:fetch"],
        },
      },
    ]);
  });

  test("turning it off disables, and never touches grants", async () => {
    const calls: unknown[] = [];
    const result = await toggleEnabled(plugin({ enabled: true }), false, {
      grantAndEnableAction: async (input) => {
        calls.push({ action: "grant", input });
        return { ok: true };
      },
      disablePluginAction: async (input) => {
        calls.push({ action: "disable", input });
        return { ok: true };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { action: "disable", input: { pluginId: "linear-bridge" } },
    ]);
  });

  test("surfaces a host-start failure's error verbatim", async () => {
    const result = await toggleEnabled(plugin(), true, {
      grantAndEnableAction: async () => ({
        ok: false,
        error: "plugin host requires Node >= 24",
      }),
      disablePluginAction: async () => ({ ok: true }),
    });

    expect(result).toEqual({
      ok: false,
      error: "plugin host requires Node >= 24",
    });
  });

  test("never escalates beyond the capabilities already held", async () => {
    const held: Capability[] = ["storage:kv"];
    const grantCalls: Capability[][] = [];

    await toggleEnabled(plugin({ grantedCapabilities: held }), true, {
      grantAndEnableAction: async (input) => {
        grantCalls.push(input.grants);
        return { ok: true };
      },
      disablePluginAction: async () => ({ ok: true }),
    });

    expect(grantCalls).toEqual([held]);
  });
});

describe("removeWithConfirm", () => {
  test("does not call remove when the operator declines", async () => {
    let removeCalled = false;
    const result = await removeWithConfirm(
      "linear-bridge",
      async () => false,
      async () => {
        removeCalled = true;
        return { ok: true };
      },
    );

    expect(removeCalled).toBe(false);
    expect(result).toBeNull();
  });

  test("calls remove with the plugin id once the operator confirms", async () => {
    const removeCalls: { pluginId: string }[] = [];
    const result = await removeWithConfirm(
      "linear-bridge",
      async () => true,
      async (input) => {
        removeCalls.push(input);
        return { ok: true };
      },
    );

    expect(removeCalls).toEqual([{ pluginId: "linear-bridge" }]);
    expect(result).toEqual({ ok: true });
  });

  test("surfaces a remove failure's error verbatim", async () => {
    const result = await removeWithConfirm(
      "linear-bridge",
      async () => true,
      async () => ({
        ok: false,
        error: 'Invalid plugin id "linear-bridge"',
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'Invalid plugin id "linear-bridge"',
    });
  });
});
