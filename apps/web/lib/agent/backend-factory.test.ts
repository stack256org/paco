import { describe, expect, mock, test } from "bun:test";

// `backend-factory.ts` and `instance-settings.ts` are both server-only; the
// marker package throws outside a server component and has nothing to do
// with what is being tested.
mock.module("server-only", () => ({}));

let openfxSettings = {
  endpoint: null as string | null,
  apiKey: null as string | null,
  binaryPath: null as string | null,
};

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({
    appDomain: null,
    tlsEnabled: false,
    previewBaseDomain: null,
    smtp: {
      host: null,
      port: null,
      secure: null,
      user: null,
      password: null,
      from: null,
    },
    openfx: openfxSettings,
    onboardingCompletedAt: null,
  }),
}));

const modulePromise = import("./backend-factory");

describe("resolveBackend", () => {
  test("defaults to claude-code when chat.backend is absent", async () => {
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({});

    expect(backend.capabilities().id).toBe("claude-code");
  });

  test("resolves the claude-code backend explicitly", async () => {
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({ backend: "claude-code" });

    expect(backend.capabilities().id).toBe("claude-code");
  });

  test("falls back to claude-code, with a warning, for an unknown value", async () => {
    const { resolveBackend } = await modulePromise;
    const warnSpy = mock((..._args: unknown[]) => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const backend = await resolveBackend({ backend: "some-future-backend" });

      expect(backend.capabilities().id).toBe("claude-code");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        "some-future-backend",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("resolves the openfx backend, reading its settings from instanceSettings", async () => {
    openfxSettings = {
      endpoint: "https://gateway.example.com",
      apiKey: "sk-openfx-secret",
      binaryPath: "/usr/local/bin/openfx",
    };
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({ backend: "openfx" });

    const capabilities = backend.capabilities();
    expect(capabilities.id).toBe("openfx");
    expect(capabilities.effort).toBe(false);
  });
});

describe("normalizeBackendId", () => {
  test("passes a known backend id through unchanged", async () => {
    const { normalizeBackendId } = await modulePromise;

    expect(normalizeBackendId("claude-code")).toBe("claude-code");
    expect(normalizeBackendId("openfx")).toBe("openfx");
  });

  test("falls back to claude-code for null and undefined", async () => {
    const { normalizeBackendId } = await modulePromise;

    expect(normalizeBackendId(null)).toBe("claude-code");
    expect(normalizeBackendId(undefined)).toBe("claude-code");
  });

  test("falls back to claude-code for an unrecognised non-null string", async () => {
    // The whole point of sharing this rule: the workflow's own fallback used
    // to catch only null/undefined, so an unrecognised string would have run
    // its turn on Claude Code while filing the resume token under that
    // string's key -- a token no later turn could ever find.
    const { normalizeBackendId } = await modulePromise;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args[0]);
    };

    try {
      expect(normalizeBackendId("some-future-backend")).toBe("claude-code");
    } finally {
      console.warn = originalWarn;
    }

    expect(String(warnings[0])).toContain("some-future-backend");
  });

  test("agrees with resolveBackend for every input, so the two can never diverge", async () => {
    const { normalizeBackendId, resolveBackend } = await modulePromise;
    const inputs = [
      "claude-code",
      "openfx",
      "some-future-backend",
      "",
      null,
      undefined,
    ] as const;
    const originalWarn = console.warn;
    console.warn = () => {
      // Silenced: the unknown-id cases warn on purpose.
    };

    try {
      for (const input of inputs) {
        const resolved = await resolveBackend({ backend: input });
        expect(resolved.capabilities().id).toBe(normalizeBackendId(input));
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("buildOpenFxBackendConfig", () => {
  test("maps a fully configured settings row onto executable + env", async () => {
    const { buildOpenFxBackendConfig } = await modulePromise;

    const config = buildOpenFxBackendConfig({
      endpoint: "https://gateway.example.com",
      apiKey: "sk-openfx-secret",
      binaryPath: "/usr/local/bin/openfx",
    });

    expect(config.executable).toBe("/usr/local/bin/openfx");
    expect(config.env).toEqual({ AI_GATEWAY_API_KEY: "sk-openfx-secret" });
  });

  test("omits executable/env when nothing is configured", async () => {
    const { buildOpenFxBackendConfig } = await modulePromise;

    const config = buildOpenFxBackendConfig({
      endpoint: null,
      apiKey: null,
      binaryPath: null,
    });

    expect(config.executable).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  test("does not forward endpoint to any env var (PROTOCOL.md §1: no override exists)", async () => {
    const { buildOpenFxBackendConfig } = await modulePromise;

    const config = buildOpenFxBackendConfig({
      endpoint: "https://gateway.example.com",
      apiKey: null,
      binaryPath: null,
    });

    expect(config.env).toBeUndefined();
  });
});
