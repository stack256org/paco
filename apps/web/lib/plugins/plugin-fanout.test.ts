import { beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test is server-only; both imports below must stay
// dynamic (after this mock is registered) — a static import hoists above
// this call and would pull in the real `server-only` package first.
mock.module("server-only", () => ({}));

const { getPluginEventFanout } = await import("./plugin-fanout.ts");
const { SessionEventFanout } = await import("@/lib/plugins/event-fanout");

function resetGlobalFanout(): void {
  (
    globalThis as typeof globalThis & {
      __pacoPluginEventFanout?: unknown;
    }
  ).__pacoPluginEventFanout = undefined;
}

describe("getPluginEventFanout", () => {
  beforeEach(() => {
    resetGlobalFanout();
  });

  test("returns a SessionEventFanout instance", () => {
    expect(getPluginEventFanout()).toBeInstanceOf(SessionEventFanout);
  });

  test("returns the same instance on repeated calls (a process-wide singleton)", () => {
    const first = getPluginEventFanout();
    const second = getPluginEventFanout();

    expect(second).toBe(first);
  });

  test("survives a module reload the same way the plugin registry does — cached on globalThis, not module scope", () => {
    const first = getPluginEventFanout();
    resetGlobalFanout();
    const second = getPluginEventFanout();

    expect(second).not.toBe(first);
  });
});
