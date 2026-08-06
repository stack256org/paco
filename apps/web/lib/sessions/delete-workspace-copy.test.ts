import { describe, expect, test } from "bun:test";
import type { UnsavedWork } from "@/lib/reaping/types";
import {
  DELETE_WORKSPACE_COPY,
  deletedNotice,
  deleteFailureMessage,
  deleteWorkspaceAnywayConfirm,
  deleteWorkspaceConfirm,
  unsavedWorkSentence,
} from "./delete-workspace-copy";

const clean: UnsavedWork = {
  uncommittedFiles: 0,
  unpushedCommits: 0,
  hasRemote: true,
  trackedFiles: 40,
};

describe("deleteWorkspaceConfirm", () => {
  test("names the workspace being deleted", () => {
    expect(deleteWorkspaceConfirm("Lisbon").description).toContain('"Lisbon"');
  });

  test("says the files and the chats go permanently", () => {
    const { description } = deleteWorkspaceConfirm("Lisbon");

    expect(description).toContain("permanently");
    expect(description).toContain("files");
    expect(description).toContain("chat");
  });

  test("separates this from archiving, which is the reversible neighbour", () => {
    const { description } = deleteWorkspaceConfirm("Lisbon");

    expect(description).toContain("Archiving can be undone");
    expect(description).toContain("This cannot");
  });

  test("says what survives on GitHub, because that is the only reassurance", () => {
    expect(deleteWorkspaceConfirm("Lisbon").description).toContain(
      "pushed to GitHub is safe",
    );
  });

  test("labels the button with the action, never OK", () => {
    const { confirmLabel, busyLabel } = deleteWorkspaceConfirm("Lisbon");

    expect(confirmLabel).toBe("Delete it");
    expect(confirmLabel).not.toBe("OK");
    expect(busyLabel).toBe("Deleting…");
  });
});

describe("unsavedWorkSentence", () => {
  test("counts uncommitted files", () => {
    expect(
      unsavedWorkSentence("Lisbon", { ...clean, uncommittedFiles: 3 }),
    ).toContain("3 uncommitted files");
  });

  test("never says '1 files'", () => {
    expect(
      unsavedWorkSentence("Lisbon", { ...clean, uncommittedFiles: 1 }),
    ).toContain("1 uncommitted file ");
  });

  test("agrees its verb with a single unpushed commit", () => {
    const one = unsavedWorkSentence("Lisbon", { ...clean, unpushedCommits: 1 });
    const many = unsavedWorkSentence("Lisbon", {
      ...clean,
      unpushedCommits: 4,
    });

    expect(one).toContain("1 commit that was never pushed");
    expect(many).toContain("4 commits that were never pushed");
  });

  test("says why nothing is pushed when there is no remote at all", () => {
    const sentence = unsavedWorkSentence("Lisbon", {
      ...clean,
      unpushedCommits: 2,
      hasRemote: false,
    });

    expect(sentence).toContain("2 commits that exist on no remote");
    expect(sentence).not.toContain("never pushed");
  });

  test("agrees its verb on the no-remote branch too", () => {
    expect(
      unsavedWorkSentence("Lisbon", {
        ...clean,
        unpushedCommits: 1,
        hasRemote: false,
      }),
    ).toContain("1 commit that exists on no remote");
  });

  test("joins both kinds of work into one sentence", () => {
    const sentence = unsavedWorkSentence("Lisbon", {
      uncommittedFiles: 2,
      unpushedCommits: 1,
      hasRemote: true,
      trackedFiles: 10,
    });

    expect(sentence).toContain("2 uncommitted files and 1 commit");
  });

  test("treats all-zeros as 'we could not tell', never as 'nothing here'", () => {
    // The route refuses the delete when the probe returned null, and null
    // arrives on the wire as zeros. Reading that as "nothing to lose" would
    // reassure someone about a workspace nobody managed to read.
    const sentence = unsavedWorkSentence("Lisbon", {
      uncommittedFiles: 0,
      unpushedCommits: 0,
      hasRemote: false,
      trackedFiles: 0,
    });

    expect(sentence).toContain("could not read the git history");
    expect(sentence).toContain("treat everything in it as unsaved");
  });
});

describe("deleteWorkspaceAnywayConfirm", () => {
  const copy = deleteWorkspaceAnywayConfirm("Lisbon", {
    ...clean,
    uncommittedFiles: 3,
  });

  test("leads with what is unsaved rather than with an error", () => {
    expect(copy.description).toContain("3 uncommitted files");
    expect(copy.description).toContain("exists nowhere else");
  });

  test("offers the other way out as well as the destructive one", () => {
    expect(copy.description).toContain("restore the workspace and push it");
    expect(copy.confirmLabel).toBe("Delete anyway");
  });

  test("is a different question from the first one, not the same button relabelled", () => {
    expect(copy.confirmLabel).not.toBe(
      deleteWorkspaceConfirm("Lisbon").confirmLabel,
    );
    expect(copy.title).not.toBe(deleteWorkspaceConfirm("Lisbon").title);
  });
});

describe("deletedNotice", () => {
  test("names what was deleted", () => {
    expect(deletedNotice("Lisbon", 0).title).toBe('Deleted "Lisbon".');
  });

  test("stays quiet when there is nothing extra to report", () => {
    expect(deletedNotice("Lisbon", 0).description).toBeUndefined();
  });

  test("reports reclaimed space in units matching du and Finder", () => {
    expect(deletedNotice("Lisbon", 1_610_612_736).description).toContain(
      "Freed 1.5 GB.",
    );
  });

  test("passes on what the server admitted it could not remove", () => {
    const notice = deletedNotice("Lisbon", 0, [
      "Could not remove the container paco-sbx-session_x: busy",
    ]);

    expect(notice.description).toContain("Could not remove the container");
  });
});

describe("deleteFailureMessage", () => {
  test("prefers the server's own wording", () => {
    expect(deleteFailureMessage(new Error("Workspace is locked"))).toBe(
      "Workspace is locked",
    );
  });

  test("falls back to something a person can act on", () => {
    expect(deleteFailureMessage(null)).toBe(
      DELETE_WORKSPACE_COPY.deleteFailedFallback,
    );
    expect(deleteFailureMessage(new Error("   "))).toBe(
      DELETE_WORKSPACE_COPY.deleteFailedFallback,
    );
  });
});
