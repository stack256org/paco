import { describe, expect, test } from "bun:test";
import {
  commitBlocker,
  commitBlockerMessage,
  commitOutcome,
} from "./commit-panel-state";

describe("commitOutcome", () => {
  test("committed and pushed is a plain success", () => {
    expect(
      commitOutcome({ committed: true, pushed: true }, { hasRepo: true }),
    ).toEqual({ kind: "saved" });
  });

  test("no repository to push to is still a plain success", () => {
    expect(
      commitOutcome({ committed: true, pushed: false }, { hasRepo: false }),
    ).toEqual({ kind: "saved" });
  });

  test("a commit whose push failed is not a failure", () => {
    // The whole bug: work that *was* saved was shown in red, and the panel
    // skipped the refresh that follows a successful save.
    const outcome = commitOutcome(
      {
        committed: true,
        pushed: false,
        error: "Saved on this machine. Connect your GitHub account…",
      },
      { hasRepo: true },
    );

    expect(outcome.kind).toBe("saved-not-sent");
    expect(outcome.kind === "saved-not-sent" && outcome.reason).toContain(
      "Saved on this machine",
    );
  });

  test("an unpushed commit always explains itself, even with no reason given", () => {
    const outcome = commitOutcome(
      { committed: true, pushed: false },
      { hasRepo: true },
    );

    expect(outcome.kind).toBe("saved-not-sent");
    expect(
      outcome.kind === "saved-not-sent" && outcome.reason.length,
    ).toBeGreaterThan(20);
  });

  test("nothing committed is the only failure", () => {
    expect(
      commitOutcome(
        {
          committed: false,
          pushed: false,
          error: "There's nothing to commit — no files have changed.",
        },
        { hasRepo: true },
      ),
    ).toEqual({
      kind: "failed",
      reason: "There's nothing to commit — no files have changed.",
    });
  });

  test("a failure with no message still says something", () => {
    const outcome = commitOutcome(
      { committed: false, pushed: false },
      { hasRepo: true },
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason.length).toBeGreaterThan(
      20,
    );
  });
});

const ready = {
  isAgentWorking: false,
  hasSandbox: true,
  gitStatusKnown: true,
  hasPendingGitWork: true,
};

describe("commitBlocker", () => {
  test("nothing blocks a ready panel with pending work", () => {
    expect(commitBlocker(ready)).toBeNull();
  });

  test("first paint is 'checking', not 'nothing has changed'", () => {
    expect(
      commitBlocker({
        ...ready,
        gitStatusKnown: false,
        hasPendingGitWork: false,
      }),
    ).toBe("checking-changes");
  });

  test("a known-clean workspace says nothing has changed", () => {
    expect(commitBlocker({ ...ready, hasPendingGitWork: false })).toBe(
      "nothing-to-save",
    );
  });

  test("a working agent comes before anything else", () => {
    expect(
      commitBlocker({
        isAgentWorking: true,
        hasSandbox: false,
        gitStatusKnown: false,
        hasPendingGitWork: false,
      }),
    ).toBe("agent-working");
  });

  test("a missing workspace comes before a missing git status", () => {
    expect(commitBlocker({ ...ready, hasSandbox: false })).toBe(
      "workspace-starting",
    );
  });
});

describe("commitBlockerMessage", () => {
  test("every blocker has a distinct sentence", () => {
    const messages = (
      [
        "agent-working",
        "workspace-starting",
        "checking-changes",
        "nothing-to-save",
      ] as const
    ).map(commitBlockerMessage);

    for (const message of messages) {
      expect(message.length).toBeGreaterThan(10);
    }
    expect(new Set(messages).size).toBe(messages.length);
  });
});
