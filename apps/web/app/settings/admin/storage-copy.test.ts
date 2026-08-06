import { describe, expect, test } from "bun:test";
import type {
  ClassifiedContainer,
  ClassifiedWorkspace,
} from "@/lib/reaping/types";
import {
  orphanedContainersConfirm,
  orphanedWorkspaceConfirm,
  stoppedContainersConfirm,
} from "./storage-copy";

function container(name: string, writableBytes = 0): ClassifiedContainer {
  return {
    id: `id-${name}`,
    name,
    state: "exited",
    running: false,
    createdAtSeconds: 0,
    writableBytes,
    ownership: "orphaned",
    sessionId: null,
    sessionTitle: null,
  };
}

function workspace(
  overrides: Partial<ClassifiedWorkspace> = {},
): ClassifiedWorkspace {
  return {
    name: "session_abc",
    path: "/home/u/.paco/workspaces/session_abc",
    sizeBytes: 1.5 * 1024 * 1024 * 1024,
    measured: true,
    modifiedAtMs: 0,
    unsavedWork: {
      uncommittedFiles: 0,
      unpushedCommits: 0,
      hasRemote: true,
      trackedFiles: 10,
    },
    ownership: "orphaned",
    sessionId: null,
    sessionTitle: null,
    mayHoldUnsavedWork: false,
    ...overrides,
  };
}

describe("orphanedContainersConfirm", () => {
  const copy = orphanedContainersConfirm([
    container("paco-sbx-session_a", 1024 * 1024),
    container("paco-sbx-session_b", 1024 * 1024),
  ]);

  test("names what goes", () => {
    expect(copy.title).toBe("Remove 2 unclaimed containers?");
    expect(copy.description).toContain("paco-sbx-session_a");
    expect(copy.description).toContain("paco-sbx-session_b");
    expect(copy.description).toContain("2.0 MB");
  });

  test("says what survives, because a container is not the code", () => {
    expect(copy.description).toContain("Nothing on disk is deleted");
  });

  test("promises not to touch anything that is not Paco's", () => {
    expect(copy.description).toContain("paco-sbx-");
    expect(copy.description).toContain("left alone");
  });

  test("never says 1 containers", () => {
    expect(orphanedContainersConfirm([container("paco-sbx-x")]).title).toBe(
      "Remove 1 unclaimed container?",
    );
  });

  test("abbreviates a long list rather than printing all of it", () => {
    const many = orphanedContainersConfirm(
      Array.from({ length: 8 }, (_, index) => container(`paco-sbx-s${index}`)),
    );
    expect(many.description).toContain("and 4 more");
  });
});

describe("stoppedContainersConfirm", () => {
  test("is honest that the workspace comes back", () => {
    const copy = stoppedContainersConfirm([container("paco-sbx-session_a")]);

    expect(copy.title).toBe("Remove 1 sleeping container?");
    expect(copy.description).toContain("No code is lost");
    expect(copy.description).toContain("next start is slower");
  });
});

describe("orphanedWorkspaceConfirm", () => {
  test("names the exact path and the real size", () => {
    const copy = orphanedWorkspaceConfirm(workspace());

    expect(copy.title).toBe("Delete session_abc permanently?");
    expect(copy.description).toContain("/home/u/.paco/workspaces/session_abc");
    expect(copy.description).toContain("1.5 GB");
    expect(copy.description).toContain("cannot be undone");
  });

  test("says plainly when nothing unique would be lost", () => {
    expect(orphanedWorkspaceConfirm(workspace()).description).toContain(
      "already on a remote",
    );
  });

  test("counts the work that would be destroyed", () => {
    const copy = orphanedWorkspaceConfirm(
      workspace({
        mayHoldUnsavedWork: true,
        unsavedWork: {
          uncommittedFiles: 12,
          unpushedCommits: 3,
          hasRemote: true,
          trackedFiles: 400,
        },
      }),
    );

    expect(copy.description).toContain("12 uncommitted files");
    expect(copy.description).toContain("3 commits");
    expect(copy.description).toContain("never pushed");
    expect(copy.description).toContain("exists nowhere else");
  });

  test("says so when there is no remote at all", () => {
    const copy = orphanedWorkspaceConfirm(
      workspace({
        unsavedWork: {
          uncommittedFiles: 0,
          unpushedCommits: 5,
          hasRemote: false,
          trackedFiles: 400,
        },
      }),
    );

    expect(copy.description).toContain("no remote");
  });

  test("an unreadable folder is described as unsaved, not as empty", () => {
    const copy = orphanedWorkspaceConfirm(
      workspace({ unsavedWork: null, mayHoldUnsavedWork: true }),
    );

    expect(copy.description).toContain("treat everything in it as unsaved");
  });

  test("mentions the container that goes with it", () => {
    expect(orphanedWorkspaceConfirm(workspace()).description).toContain(
      "Its container is removed with it",
    );
  });
});
