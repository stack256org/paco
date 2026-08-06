import { describe, expect, test } from "bun:test";
import { isMissingSessionResult } from "./resume.ts";
import type { ClaudeResultMessage } from "./types.ts";

function result(overrides: Partial<ClaudeResultMessage>): ClaudeResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 0,
    num_turns: 0,
    session_id: "s",
    uuid: "u",
    ...overrides,
  };
}

describe("isMissingSessionResult", () => {
  test("recognises the CLI's missing-session failure", () => {
    // Verbatim from the CLI when a chat's working directory moved.
    expect(
      isMissingSessionResult(
        result({
          is_error: true,
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID: 70e13af4-29c5"],
        }),
      ),
    ).toBe(true);
  });

  test("also reads the message out of `result`", () => {
    expect(
      isMissingSessionResult(
        result({
          is_error: true,
          subtype: "error_during_execution",
          result: "No conversation found with session ID: abc",
        }),
      ),
    ).toBe(true);
  });

  test("leaves other execution errors alone", () => {
    // Retrying a real failure without resume would silently discard the
    // conversation's history.
    expect(
      isMissingSessionResult(
        result({
          is_error: true,
          subtype: "error_during_execution",
          errors: ["Tool 'Bash' failed: permission denied"],
        }),
      ),
    ).toBe(false);
  });

  test("ignores successful runs", () => {
    expect(isMissingSessionResult(result({}))).toBe(false);
  });
});
