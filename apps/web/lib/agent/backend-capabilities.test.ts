import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

/*
 * Deliberately NOT stubbing `@paco/poolside-backend`. This module's whole
 * job is to report the REAL backends' declared capabilities to the client,
 * so a stub here would assert only that the stub says what the stub says.
 * Constructing the real backends is safe: both constructors are
 * side-effect-free, and only `startTurn` spawns a process.
 */
const modulePromise = import("./backend-capabilities");

describe("capabilitiesForBackend", () => {
  test("claude-code reports effort: true", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("claude-code");

    expect(capabilities.id).toBe("claude-code");
    expect(capabilities.effort).toBe(true);
  });

  test("poolside reports effort: false", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("poolside");

    expect(capabilities.id).toBe("poolside");
    expect(capabilities.effort).toBe(false);
  });

  /**
   * What a Poolside turn cannot carry, declared rather than silently dropped
   * in `run-step.ts`: flipping a chat to a second backend used to take the
   * subagent roster and the planner/reviewer's shaped output with it, with
   * nothing in the UI to say so.
   *
   * `effort` is on this list for a subtler reason than the other two.
   * Poolside HAS a reasoning knob (`thought_level`), but it holds two values
   * against Paco's five, so `true` would render a five-level control where
   * four of the five choices are indistinguishable — the same class of
   * silent-drop this file exists to prevent, one level down.
   */
  test("poolside declares what it cannot carry, so the UI can stop offering it", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("poolside");

    expect(capabilities.customAgents).toBe(false);
    expect(capabilities.structuredOutput).toBe(false);
    expect(capabilities.effort).toBe(false);
  });

  /**
   * The half the previous backend could not do, and the reason the model
   * picker is not simply hidden for Poolside: `models` is a real list, not
   * the empty array that meant "I resolve my own model, there is nothing to
   * pick". Poolside accepts its own ids over ACP's `model` config option.
   */
  test("poolside declares the model ids it really accepts", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("poolside");

    expect(capabilities.models).toEqual([
      "poolside/laguna-s-2.1",
      "poolside/laguna-xs-2.1",
    ]);
  });

  /**
   * The one capability the ACP handshake actively lies about.
   *
   * `initialize` answers `promptCapabilities: {image: true}` for Poolside,
   * which is the TRANSPORT agreeing to carry an image block. Both models
   * behind it are blind, measured against `pool` 1.0.16: an inline image
   * block returns `stopReason: "end_turn"` with no error while the model
   * answers "IMAGE-NOT-VISIBLE", and `Read` on a staged PNG fails with "the
   * configured model does not support image inputs".
   *
   * This is the value the composer and the turn prompt both branch on, so
   * pin it here rather than only in the package's own test: this is where it
   * crosses to the client.
   */
  test("poolside declares that its model cannot see images", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    expect(capabilitiesForBackend("poolside").images).toBe(false);
  });

  test("claude-code declares that it can, which the attachment path relies on", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    // Not `undefined`: unlike `customAgents`/`structuredOutput`, `images` is
    // required precisely so no backend can answer by omission.
    expect(capabilitiesForBackend("claude-code").images).toBe(true);
  });

  /** MCP is declared true AND received — see `run-step.test.ts`. */
  test("poolside declares mcp, resume and steering", async () => {
    const { capabilitiesForBackend } = await modulePromise;

    const capabilities = capabilitiesForBackend("poolside");

    expect(capabilities.mcp).toBe(true);
    expect(capabilities.resume).toBe(true);
    expect(capabilities.steering).toBe("restart");
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
   * because it filters client-side against options that now span two
   * vendors and would read `undefined` as "show every one of them". So it is
   * expanded here, before the object leaves the server.
   */
  test("claude-code's `models` is expanded into the catalog it stands for", async () => {
    const { capabilitiesForBackend } = await modulePromise;
    const { CLAUDE_MODEL_IDS } = await import("@/lib/model-catalog");

    const capabilities = capabilitiesForBackend("claude-code");

    expect(capabilities.models).toEqual([...CLAUDE_MODEL_IDS]);
    // Specifically: not Poolside's, which the CLI would reject.
    expect(capabilities.models).not.toContain("poolside/laguna-s-2.1");
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
      // A chat row still holding the id of the backend Poolside replaced
      // reports the capabilities of the backend that will actually RUN it,
      // rather than those of a backend this build no longer contains.
      expect(capabilitiesForBackend("a-retired-backend").id).toBe(
        "claude-code",
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
