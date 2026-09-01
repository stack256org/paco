import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

/**
 * Mutable so individual tests can flip between "no gateway configured" (the
 * default every existing test in this file relies on) and "a gateway is
 * configured" without re-mocking the module per test.
 */
let claudeBaseUrl: string | null = null;

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: () =>
    Promise.resolve({
      appDomain: null,
      tlsEnabled: false,
      previewBaseDomain: null,
      claudeCredentialKind: null,
      claudeCredentialSetAt: null,
      claudeBaseUrl,
      claudeModelDiscovery: false,
    }),
}));

const modulePromise = import("./backend-capabilities");

describe("capabilitiesForBackend", () => {
  test("claude-code reports effort: true", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = await capabilitiesForBackend("claude-code");

    expect(capabilities.id).toBe("claude-code");
    expect(capabilities.effort).toBe(true);
  });

  test("claude-code declares that it can see images, which the attachment path relies on", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    // Not `undefined`: `images` is required precisely so no backend can
    // answer by omission.
    expect((await capabilitiesForBackend("claude-code")).images).toBe(true);
  });

  test("claude-code leaves customAgents/structuredOutput undefined, which the interface defines as 'yes'", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = await capabilitiesForBackend("claude-code");

    expect(capabilities.customAgents).toBeUndefined();
    expect(capabilities.structuredOutput).toBeUndefined();
  });

  /**
   * `models` is the one field NOT passed through verbatim.
   * `ClaudeCodeBackend` declares it `undefined`, meaning "the app's own
   * catalog applies unchanged" — a shorthand the composer cannot re-apply,
   * because it filters client-side against options and would read
   * `undefined` as "show every one of them". So it is expanded here, before
   * the object leaves the server.
   */
  test("claude-code's `models` is expanded into the catalog it stands for", async () => {
    const { capabilitiesForBackend } = await modulePromise;
    const { CLAUDE_MODEL_IDS } = await import("@/lib/model-catalog");

    const capabilities = await capabilitiesForBackend("claude-code");

    expect(capabilities.models).toEqual([...CLAUDE_MODEL_IDS]);
  });

  test("an unknown/null backend falls back to claude-code's capabilities", async () => {
    const { capabilitiesForBackend } = await modulePromise;
    const originalWarn = console.warn;
    console.warn = () => {
      // Silenced: the unknown-id case warns on purpose.
    };

    try {
      expect((await capabilitiesForBackend(null)).id).toBe("claude-code");
      expect((await capabilitiesForBackend("some-future-backend")).id).toBe(
        "claude-code",
      );
      // A chat row still holding the id of a retired backend reports the
      // capabilities of the backend that will actually RUN it, rather than
      // those of a backend this build no longer contains.
      expect((await capabilitiesForBackend("a-retired-backend")).id).toBe(
        "claude-code",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  /*
   * Critical 2 lived here: `models: undefined` used to resolve to the
   * static `CLAUDE_MODEL_IDS` unconditionally. With a gateway configured,
   * the composer (`model-effort-backend-controls.tsx`) filters its options
   * — built from `listClaudeModels(claudeBaseUrl)`, which returns the
   * gateway's own ids once the CLI has discovered them — against this
   * capability, and none of those gateway ids matched the static aliases.
   * Every option was filtered out and the picker vanished entirely.
   */
  describe("with a gateway configured and discovered", () => {
    let previousHome: string | undefined;
    let tempHome: string;

    beforeEach(() => {
      claudeBaseUrl = "https://llm.example.com";
      previousHome = process.env.HOME;
      tempHome = mkdtempSync(join(tmpdir(), "paco-backend-capabilities-test-"));
      process.env.HOME = tempHome;

      const cacheDir = join(tempHome, ".claude", "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "gateway-models.json"),
        JSON.stringify({
          data: [{ id: "claude-gateway-model", display_name: "Gateway Model" }],
        }),
      );
    });

    afterEach(() => {
      claudeBaseUrl = null;
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    });

    test("fills the picker with the gateway's own model ids instead of the static aliases", async () => {
      const { capabilitiesForBackend } = await modulePromise;

      const capabilities = await capabilitiesForBackend("claude-code");

      expect(capabilities.models).toEqual(["claude-gateway-model"]);
    });
  });

  /**
   * A gateway an operator just configured has not been queried by the CLI
   * yet, so its discovery cache doesn't exist. This must not empty the
   * picker — it must fall back to the static aliases, same as
   * `listClaudeModels` itself does.
   */
  describe("with a gateway configured but not yet discovered", () => {
    let previousHome: string | undefined;
    let tempHome: string;

    beforeEach(() => {
      claudeBaseUrl = "https://llm.example.com";
      previousHome = process.env.HOME;
      tempHome = mkdtempSync(join(tmpdir(), "paco-backend-capabilities-test-"));
      process.env.HOME = tempHome;
    });

    afterEach(() => {
      claudeBaseUrl = null;
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    });

    test("falls back to the static aliases rather than leaving the picker empty", async () => {
      const { capabilitiesForBackend } = await modulePromise;
      const { CLAUDE_MODEL_IDS } = await import("@/lib/model-catalog");

      const capabilities = await capabilitiesForBackend("claude-code");

      expect(capabilities.models).toEqual([...CLAUDE_MODEL_IDS]);
    });
  });
});
