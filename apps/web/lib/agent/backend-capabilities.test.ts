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

  /**
   * The three things an OpenFX turn cannot carry. Declared rather than
   * silently dropped in `run-step.ts`: flipping a chat to OpenFX used to
   * take the subagent roster, the planner/reviewer's shaped output and the
   * meaning of the model picker with it, with nothing in the UI to say so.
   */
  test("openfx declares what it cannot carry, so the UI can stop offering it", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("openfx");

    expect(capabilities.customAgents).toBe(false);
    expect(capabilities.structuredOutput).toBe(false);
    expect(capabilities.models).toEqual([]);
  });

  test("claude-code leaves them undefined, which the interface defines as 'yes'", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("claude-code");

    expect(capabilities.customAgents).toBeUndefined();
    expect(capabilities.structuredOutput).toBeUndefined();
    expect(capabilities.models).toBeUndefined();
  });

  test("an unknown/null backend falls back to claude-code's capabilities", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    expect(capabilitiesForBackend(null).id).toBe("claude-code");
    expect(capabilitiesForBackend("some-future-backend").id).toBe(
      "claude-code",
    );
  });
});
