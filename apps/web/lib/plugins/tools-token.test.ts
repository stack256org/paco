import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

process.env.APP_SECRET ??= "test-secret-for-plugin-tools-token-000000000";

let mintPluginToolsToken: typeof import("./tools-token").mintPluginToolsToken;
let verifyPluginToolsToken: typeof import("./tools-token").verifyPluginToolsToken;

beforeAll(async () => {
  ({ mintPluginToolsToken, verifyPluginToolsToken } =
    await import("./tools-token"));
});

describe("plugin tools token", () => {
  test("a freshly minted token verifies for a plugin id it was scoped to", () => {
    const token = mintPluginToolsToken(["demo-plugin"]);
    expect(verifyPluginToolsToken(token, "demo-plugin")).toEqual({ ok: true });
  });

  test("verifies for every plugin id in a multi-plugin scope", () => {
    const token = mintPluginToolsToken(["plugin-a", "plugin-b"]);
    expect(verifyPluginToolsToken(token, "plugin-a")).toEqual({ ok: true });
    expect(verifyPluginToolsToken(token, "plugin-b")).toEqual({ ok: true });
  });

  test("rejects a plugin id outside the token's scope, distinctly from an invalid token", () => {
    const token = mintPluginToolsToken(["demo-plugin"]);
    expect(verifyPluginToolsToken(token, "other-plugin")).toEqual({
      ok: false,
      reason: "out-of-scope",
    });
  });

  test("rejects a tampered signature", () => {
    const token = mintPluginToolsToken(["demo-plugin"]);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.not-the-real-signature`;
    expect(verifyPluginToolsToken(tampered, "demo-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("rejects a tampered payload, even with the original signature", () => {
    const token = mintPluginToolsToken(["demo-plugin"]);
    const parts = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        pluginIds: ["demo-plugin", "other-plugin"],
        exp: Date.now() + 1_000_000,
      }),
      "utf-8",
    ).toString("base64url");
    const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    expect(verifyPluginToolsToken(tampered, "other-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("rejects an expired token", () => {
    const token = mintPluginToolsToken(["demo-plugin"]);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 7 * 60 * 60 * 1000; // past the 6h TTL
      expect(verifyPluginToolsToken(token, "demo-plugin")).toEqual({
        ok: false,
        reason: "expired",
      });
    } finally {
      Date.now = realNow;
    }
  });

  test("rejects malformed input", () => {
    expect(verifyPluginToolsToken(null, "demo-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyPluginToolsToken(undefined, "demo-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyPluginToolsToken("", "demo-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyPluginToolsToken("not.enough", "demo-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyPluginToolsToken("v2.abc.def", "demo-plugin")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("deduplicates and sorts the scope, but still verifies every id in it", () => {
    const token = mintPluginToolsToken(["plugin-b", "plugin-a", "plugin-a"]);
    expect(verifyPluginToolsToken(token, "plugin-a")).toEqual({ ok: true });
    expect(verifyPluginToolsToken(token, "plugin-b")).toEqual({ ok: true });
  });

  test("two tokens minted for the same scope still verify independently", () => {
    const first = mintPluginToolsToken(["demo-plugin"]);
    const second = mintPluginToolsToken(["demo-plugin"]);
    expect(verifyPluginToolsToken(first, "demo-plugin")).toEqual({ ok: true });
    expect(verifyPluginToolsToken(second, "demo-plugin")).toEqual({
      ok: true,
    });
  });
});
