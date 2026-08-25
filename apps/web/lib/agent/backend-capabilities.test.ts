import { describe, expect, test } from "bun:test";
import { mock } from "bun:test";

mock.module("server-only", () => ({}));

const modulePromise = import("./backend-capabilities");

describe("capabilitiesForBackend", () => {
  test("claude-code reports effort: true", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("claude-code");

    expect(capabilities.id).toBe("claude-code");
    expect(capabilities.effort).toBe(true);
  });

  test("openfx reports effort: false", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("openfx");

    expect(capabilities.id).toBe("openfx");
    expect(capabilities.effort).toBe(false);
  });

  test("an unknown/null backend falls back to claude-code's capabilities", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    expect(capabilitiesForBackend(null).id).toBe("claude-code");
    expect(capabilitiesForBackend("some-future-backend").id).toBe(
      "claude-code",
    );
  });
});
