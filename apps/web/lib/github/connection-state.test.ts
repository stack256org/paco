import { describe, expect, test } from "bun:test";
import {
  githubConnectionAdvice,
  githubConnectionState,
} from "./connection-state";

const connected = {
  connected: true,
  missingScopes: [],
};

describe("githubConnectionState", () => {
  test("says nothing until the answer arrives", () => {
    expect(githubConnectionState(undefined)).toBe("checking");
  });

  test("a user who has never connected is not asked to reconnect", () => {
    expect(githubConnectionState({ connected: false, missingScopes: [] })).toBe(
      "not-connected",
    );
  });

  test("a working token is connected", () => {
    expect(githubConnectionState(connected)).toBe("connected");
  });

  test("a stored token that cannot be decrypted is its own state", () => {
    expect(githubConnectionState({ ...connected, tokenUnreadable: true })).toBe(
      "token-unreadable",
    );
  });

  test("a stored token missing scopes asks for a reconnect", () => {
    expect(
      githubConnectionState({ ...connected, missingScopes: ["repo"] }),
    ).toBe("reconnect-required");
  });

  test("an unreadable token outranks missing scopes", () => {
    // Adding scopes to a token nobody can unlock fixes nothing.
    expect(
      githubConnectionState({
        connected: true,
        missingScopes: ["repo"],
        tokenUnreadable: true,
      }),
    ).toBe("token-unreadable");
  });

  test("a missing CLI outranks everything a token could fix", () => {
    expect(
      githubConnectionState({
        connected: true,
        missingScopes: ["repo"],
        tokenUnreadable: true,
        cliMissing: true,
      }),
    ).toBe("cli-missing");
    expect(
      githubConnectionState({
        connected: false,
        missingScopes: [],
        cliMissing: true,
      }),
    ).toBe("cli-missing");
  });
});

describe("githubConnectionAdvice", () => {
  test("stays quiet while checking and when connected", () => {
    expect(githubConnectionAdvice("checking")).toBeNull();
    expect(githubConnectionAdvice("connected")).toBeNull();
  });

  test("every failure state has a cause and a next action", () => {
    for (const state of [
      "not-connected",
      "reconnect-required",
      "token-unreadable",
      "cli-missing",
    ] as const) {
      const advice = githubConnectionAdvice(state);
      expect(advice).not.toBeNull();
      expect(advice?.message.length).toBeGreaterThan(20);
    }
  });

  test("never tells a user who has no connection to refresh one", () => {
    const advice = githubConnectionAdvice("not-connected");
    expect(advice?.message).not.toContain("refresh");
    expect(advice?.action?.label).toBe("Connect GitHub");
  });

  test("offers no link for a problem no page can fix", () => {
    expect(githubConnectionAdvice("cli-missing")?.action).toBeNull();
  });

  test("gives each failure state a message of its own", () => {
    const messages = (
      [
        "not-connected",
        "reconnect-required",
        "token-unreadable",
        "cli-missing",
      ] as const
    ).map((state) => githubConnectionAdvice(state)?.message);

    expect(new Set(messages).size).toBe(messages.length);
  });
});
