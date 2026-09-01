import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const modulePromise = import("./backend-capabilities");

describe("capabilitiesForBackend", () => {
  test("claude-code reports effort: true", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("claude-code");

    expect(capabilities.id).toBe("claude-code");
    expect(capabilities.effort).toBe(true);
  });

  test("claude-code declares that it can see images, which the attachment path relies on", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    // Not `undefined`: `images` is required precisely so no backend can
    // answer by omission.
    expect(capabilitiesForBackend("claude-code").images).toBe(true);
  });

  test("claude-code leaves customAgents/structuredOutput undefined, which the interface defines as 'yes'", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("claude-code");

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

    const capabilities = capabilitiesForBackend("claude-code");

    expect(capabilities.models).toEqual([...CLAUDE_MODEL_IDS]);
  });

  test("an unknown/null backend falls back to claude-code's capabilities", async () => {
    const { capabilitiesForBackend } = await modulePromise;
    const originalWarn = console.warn;
    console.warn = () => {
      // Silenced: the unknown-id case warns on purpose.
    };

    try {
      expect(capabilitiesForBackend(null).id).toBe("claude-code");
      expect(capabilitiesForBackend("some-future-backend").id).toBe(
        "claude-code",
      );
      // A chat row still holding the id of a retired backend reports the
      // capabilities of the backend that will actually RUN it, rather than
      // those of a backend this build no longer contains.
      expect(capabilitiesForBackend("a-retired-backend").id).toBe(
        "claude-code",
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
