import { describe, expect, test } from "bun:test";
import type { SandboxState } from "@paco/sandbox";
import {
  canOperateOnSandbox,
  clearSandboxResumeState,
  clearSandboxState,
  hasPausedSandboxState,
  hasResumableSandboxState,
  hasRuntimeSandboxState,
  isSandboxActive,
} from "./utils";

/** What provisioning persists: a name plus the container it just started. */
const RUNNING: SandboxState = {
  type: "docker",
  sandboxName: "session_s1",
  containerId: "c0ffee",
  expiresAt: Date.now() + 60_000,
};

describe("hasPausedSandboxState", () => {
  test("reports a snapshot once the sandbox is hibernated", () => {
    /*
     * The regression this guards: `hasPausedSandboxState` was
     * `hasResumableSandboxState(s) && !hasRuntimeSandboxState(s)` while
     * `hasRuntimeSandboxState` was itself `hasResumableSandboxState(s)` — an
     * `X && !X` that could never be true. `/api/sandbox/status` and
     * `/reconnect` therefore answered `hasPausedWorkspace: false` for every session,
     * so a hibernated sandbox never offered "Resume".
     */
    const hibernated = clearSandboxState(RUNNING);

    expect(hasPausedSandboxState(hibernated)).toBe(true);
    // And the two predicates must genuinely disagree, which is the whole fix.
    expect(hasRuntimeSandboxState(hibernated)).toBe(false);
  });

  test("is false while the sandbox is running", () => {
    expect(hasPausedSandboxState(RUNNING)).toBe(false);
    expect(hasRuntimeSandboxState(RUNNING)).toBe(true);
  });

  test("is false when there is nothing to resume", () => {
    // A session row before provisioning, and one whose resume handle was wiped
    // by a hard 404.
    expect(hasPausedSandboxState({ type: "docker" })).toBe(false);
    expect(hasPausedSandboxState(clearSandboxResumeState(RUNNING))).toBe(false);
    expect(hasPausedSandboxState(null)).toBe(false);
  });

  test("the call sites' `!runtime && paused` composition still works", () => {
    // Both routes compute it this way, so an equivalence between the two
    // predicates silently zeroes the result no matter what `paused` returns.
    const hibernated = clearSandboxState(RUNNING);

    expect(
      !hasRuntimeSandboxState(hibernated) && hasPausedSandboxState(hibernated),
    ).toBe(true);
  });
});

describe("hasRuntimeSandboxState", () => {
  test("accepts a legacy state that only carries an expiry", () => {
    // `/api/sandbox/extend` writes `{...state, expiresAt}` when the sandbox
    // cannot serialize itself; that is still a live container.
    expect(
      hasRuntimeSandboxState({
        type: "docker",
        sandboxName: "session_s1",
        expiresAt: Date.now() + 1000,
      }),
    ).toBe(true);
  });

  test("rejects a container id with no way to resume it", () => {
    expect(
      hasRuntimeSandboxState({ type: "docker", containerId: "c0ffee" }),
    ).toBe(false);
  });
});

describe("resume-handle predicates stay loose", () => {
  test("a hibernated sandbox is still active and operable", () => {
    /*
     * Docker connect is name-keyed and idempotent — it restarts a stopped
     * container — so a name is enough to run a turn against, and enough for
     * the lifecycle workflow to stop. Tightening these along with
     * `hasRuntimeSandboxState` would have stopped hibernation from ever
     * running.
     */
    const hibernated = clearSandboxState(RUNNING);

    expect(hasResumableSandboxState(hibernated)).toBe(true);
    expect(isSandboxActive(hibernated)).toBe(true);
    expect(canOperateOnSandbox(hibernated)).toBe(true);
  });
});
