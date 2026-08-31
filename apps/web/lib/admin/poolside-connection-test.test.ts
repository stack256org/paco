import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * Guards one property of `testPoolsideConnection`: it must run against a host
 * that has configured NOTHING on the settings form.
 *
 * That sounds like the least interesting case and is actually the most
 * important one. `paco auth poolside` signs the service user in with
 * `pool login`, and such a host legitimately has no binary path (pool is on
 * PATH), no API key (the credential is a file), and no base URL (the default
 * endpoint). An earlier guard refused to run unless one of the three was set,
 * so the operator who had just signed in from a terminal — the one with the
 * least on-screen confirmation that anything worked — was the one operator the
 * button would not help.
 *
 * The test asserts on the action's *dependencies* rather than spawning a real
 * `pool`: it must reach the backend probe even when settings are empty, and
 * must not short-circuit on the shape of the form.
 */

let readSettingsResult: {
  poolside: {
    binaryPath: string | null;
    apiKey: string | null;
    baseUrl: string | null;
  };
};
let probeCalls = 0;

// The whole module is replaced, so every export the action imports must be
// present — omitting one fails at import time, not at the assertion.
mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: () => Promise.resolve(readSettingsResult),
  saveAppDomain: () => Promise.resolve(),
  savePoolsideSettings: () => Promise.resolve(),
}));

mock.module("@paco/poolside-backend", () => ({
  buildPoolsideBackendConfig: () => ({ executable: "pool", env: {} }),
  AcpClient: class {
    initialize() {
      probeCalls++;
      return Promise.resolve({
        agentCapabilities: {
          _meta: { "poolside/service_mode": "provider: inference.poolside.ai" },
        },
      });
    }
    close() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));

const emptySettings = {
  poolside: { binaryPath: null, apiKey: null, baseUrl: null },
};

describe("testPoolsideConnection on a login-only host", () => {
  test("does not refuse just because the settings form is empty", async () => {
    readSettingsResult = emptySettings;
    probeCalls = 0;

    const { testPoolsideConnection } =
      await import("./instance-settings-actions");
    const result = await testPoolsideConnection();

    // The old guard returned this without ever spawning anything.
    expect(result.error ?? "").not.toContain("nothing to test yet");
    // It must actually have tried the host.
    expect(probeCalls).toBeGreaterThan(0);
  });
});
