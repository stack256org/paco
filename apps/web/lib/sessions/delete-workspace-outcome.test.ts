import { describe, expect, test } from "bun:test";
import { DELETE_WORKSPACE_COPY } from "./delete-workspace-copy";
import {
  parseDeleteWorkspaceResponse,
  UNKNOWN_UNSAVED_WORK,
} from "./delete-workspace-outcome";

describe("parseDeleteWorkspaceResponse", () => {
  test("reads a successful delete, with what it freed", () => {
    const outcome = parseDeleteWorkspaceResponse(200, {
      success: true,
      removedContainers: ["paco-sbx-session_x"],
      removedWorkspaces: 1,
      freedBytes: 2048,
      warnings: [],
    });

    expect(outcome).toEqual({
      kind: "deleted",
      freedBytes: 2048,
      warnings: [],
    });
  });

  test("carries the warnings through, so a surviving container is admitted", () => {
    const outcome = parseDeleteWorkspaceResponse(200, {
      success: true,
      freedBytes: 0,
      warnings: ["Could not remove the container paco-sbx-session_x: busy"],
    });

    expect(outcome).toEqual({
      kind: "deleted",
      freedBytes: 0,
      warnings: ["Could not remove the container paco-sbx-session_x: busy"],
    });
  });

  test("does not call a 2xx that never said success a delete", () => {
    // The row may still be there. Reporting it gone would remove the only list
    // from which it could be deleted again.
    expect(parseDeleteWorkspaceResponse(200, { session: null })).toEqual({
      kind: "failed",
      message: DELETE_WORKSPACE_COPY.deleteFailedFallback,
    });
  });

  test("turns the 409 into the counts the second question is built from", () => {
    const outcome = parseDeleteWorkspaceResponse(409, {
      error: "This workspace has work that isn't saved anywhere else.",
      unsavedWork: {
        uncommittedFiles: 3,
        unpushedCommits: 2,
        hasRemote: true,
        trackedFiles: 120,
      },
    });

    expect(outcome).toEqual({
      kind: "blocked",
      unsavedWork: {
        uncommittedFiles: 3,
        unpushedCommits: 2,
        hasRemote: true,
        trackedFiles: 120,
      },
    });
  });

  test("stays blocked when the 409 could not describe itself", () => {
    // The refusal is the load-bearing fact: the delete did not happen. Dropping
    // it because a field was the wrong shape would turn "we stopped and asked"
    // into "something went wrong", which is the outcome that loses work.
    expect(parseDeleteWorkspaceResponse(409, { error: "nope" })).toEqual({
      kind: "blocked",
      unsavedWork: UNKNOWN_UNSAVED_WORK,
    });
    expect(
      parseDeleteWorkspaceResponse(409, { unsavedWork: { uncommitted: "3" } }),
    ).toEqual({ kind: "blocked", unsavedWork: UNKNOWN_UNSAVED_WORK });
    expect(parseDeleteWorkspaceResponse(409, null)).toEqual({
      kind: "blocked",
      unsavedWork: UNKNOWN_UNSAVED_WORK,
    });
  });

  test("repeats the server's reason for any other refusal", () => {
    expect(
      parseDeleteWorkspaceResponse(403, { error: "That isn't yours." }),
    ).toEqual({ kind: "failed", message: "That isn't yours." });
  });

  test("has something to say when the body is unreadable", () => {
    expect(parseDeleteWorkspaceResponse(500, null)).toEqual({
      kind: "failed",
      message: DELETE_WORKSPACE_COPY.deleteFailedFallback,
    });
  });
});
