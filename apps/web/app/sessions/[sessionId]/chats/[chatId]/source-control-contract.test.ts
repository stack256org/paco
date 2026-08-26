import { describe, expect, test } from "bun:test";
import {
  type ChangeRow,
  commitBlocker,
  commitBlockerMessage,
  describeDiscard,
  fileRowKey,
  isSameFile,
  patchHasBothSides,
  splitPath,
  stagedRows,
  statusLabel,
  statusLetter,
  statusToneClass,
  totalChangeCount,
  type WorkingTreeStatus,
  workingTreeRows,
} from "./source-control-contract";

function status(overrides: Partial<WorkingTreeStatus> = {}): WorkingTreeStatus {
  return {
    aheadOfBase: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    ...overrides,
  };
}

function row(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return { path: "a.ts", status: "M", untracked: false, ...overrides };
}

describe("commitBlocker", () => {
  const base = {
    canMutate: true,
    committing: false,
    message: "fix the parser",
    stagedCount: 2,
  };

  test("lets a staged change with a message through", () => {
    expect(commitBlocker(base)).toBeNull();
    expect(commitBlockerMessage(null)).toBeNull();
  });

  test("refuses with nothing staged, and says a commit only takes staged work", () => {
    const blocker = commitBlocker({ ...base, stagedCount: 0 });

    expect(blocker).toBe("nothing-staged");
    expect(commitBlockerMessage(blocker)).toContain("Stage a file first");
  });

  test("refuses an empty message, and a message of only whitespace", () => {
    expect(commitBlocker({ ...base, message: "" })).toBe("empty-message");
    expect(commitBlocker({ ...base, message: "   \n\t " })).toBe(
      "empty-message",
    );
    expect(commitBlockerMessage("empty-message")).toContain(
      "Write a commit message",
    );
  });

  test("an offline workspace outranks every other reason", () => {
    expect(
      commitBlocker({
        ...base,
        canMutate: false,
        message: "",
        stagedCount: 0,
      }),
    ).toBe("offline");
  });

  test("a commit in flight outranks the contents of the box", () => {
    expect(commitBlocker({ ...base, committing: true, message: "" })).toBe(
      "committing",
    );
  });
});

describe("status letters", () => {
  /*
   * Git reports an untracked file as `A`, not `U` — it is an addition, and
   * that is what `git status` calls it. The panel still writes `U`, as VS Code
   * does, because `A` on an untracked row and `A` on a staged row would be one
   * letter for the two states this list exists to tell apart.
   */
  test("writes U for an untracked file even though git sent A", () => {
    expect(statusLetter("A", true)).toBe("U");
    expect(statusLabel("A", true)).toBe("Untracked");
    expect(statusToneClass("A", true)).toBe("text-success");
  });

  test("leaves a staged addition as A", () => {
    expect(statusLetter("A", false)).toBe("A");
    expect(statusLabel("A", false)).toBe("Added");
    expect(statusToneClass("A", false)).toBe("text-success");
  });

  test("a U from git is a conflict, and shows red", () => {
    expect(statusLetter("U", false)).toBe("U");
    expect(statusLabel("U", false)).toBe("Conflicted");
    expect(statusToneClass("U", false)).toBe("text-error");
  });

  test("uses the conventional colours for the rest", () => {
    expect(statusToneClass("M", false)).toBe("text-warning");
    expect(statusToneClass("D", false)).toBe("text-error");
    expect(statusLabel("R", false)).toBe("Renamed");
    expect(statusLabel("C", false)).toBe("Copied");
    expect(statusLetter("M", false)).toBe("M");
  });
});

describe("row identity", () => {
  test("a file staged and modified again gets two distinct keys", () => {
    const path = "apps/web/app/page.tsx";

    expect(fileRowKey({ path, staged: true })).not.toBe(
      fileRowKey({ path, staged: false }),
    );
  });

  test("selection compares the list as well as the path", () => {
    const path = "a.ts";

    expect(
      isSameFile({ path, staged: true }, { path, staged: true }),
    ).toBeTrue();
    expect(
      isSameFile({ path, staged: true }, { path, staged: false }),
    ).toBeFalse();
    expect(isSameFile(null, { path, staged: true })).toBeFalse();
  });
});

describe("splitPath", () => {
  test("splits a nested path into name and directory", () => {
    expect(splitPath("apps/web/app/page.tsx")).toEqual({
      dirPath: "apps/web/app",
      fileName: "page.tsx",
    });
  });

  test("leaves a root-level file without a directory", () => {
    expect(splitPath("README.md")).toEqual({
      dirPath: "",
      fileName: "README.md",
    });
  });
});

describe("workingTreeRows", () => {
  test("merges unstaged and untracked into one flat, sorted list", () => {
    const rows = workingTreeRows(
      status({
        unstaged: [{ path: "z/last.ts", status: "M" }],
        untracked: [{ path: "a/first.ts", status: "A" }],
      }),
    );

    expect(rows.map((file) => file.path)).toEqual(["a/first.ts", "z/last.ts"]);
  });

  /*
   * The invariant the server half guarantees: nothing in `untracked` is ever
   * `U`, and nothing outside `unstaged` is ever `U`. The flag is what keeps
   * that readable once the two arrays have been merged into one list.
   */
  test("keeps an untracked addition apart from a conflict after the merge", () => {
    const rows = workingTreeRows(
      status({
        unstaged: [{ path: "conflict.ts", status: "U" }],
        untracked: [{ path: "new.ts", status: "A" }],
      }),
    );
    const untracked = rows.find((file) => file.path === "new.ts");
    const conflict = rows.find((file) => file.path === "conflict.ts");

    expect(untracked?.untracked).toBeTrue();
    expect(statusLetter(untracked?.status ?? "M", true)).toBe("U");
    expect(conflict?.untracked).toBeFalse();
    expect(statusToneClass(untracked?.status ?? "M", true)).not.toBe(
      statusToneClass(conflict?.status ?? "M", false),
    );
  });

  test("nothing in the index is ever untracked", () => {
    const rows = stagedRows(
      status({ staged: [{ path: "new.ts", status: "A" }] }),
    );

    expect(rows[0]?.untracked).toBeFalse();
  });
});

describe("totalChangeCount", () => {
  test("counts a file that is in both lists twice, as the panel shows it", () => {
    expect(
      totalChangeCount(
        status({
          staged: [{ path: "a.ts", status: "M" }],
          unstaged: [{ path: "a.ts", status: "M" }],
        }),
      ),
    ).toBe(2);
  });

  test("is zero for a clean tree and for no data at all", () => {
    expect(totalChangeCount(status())).toBe(0);
    expect(totalChangeCount(null)).toBe(0);
  });
});

describe("describeDiscard", () => {
  test("names the file that will be deleted when it is untracked", () => {
    const request = describeDiscard([
      row({ path: "scratch/notes.md", status: "A", untracked: true }),
    ]);

    expect(request.title).toBe("Delete notes.md?");
    expect(request.description).toContain("scratch/notes.md");
    expect(request.description).toContain("deletes the file");
    expect(request.confirmLabel).toBe("Delete file");
  });

  test("promises a tracked file that its staged version survives", () => {
    const request = describeDiscard([row({ path: "src/parser.ts" })]);

    expect(request.title).toBe("Discard changes in parser.ts?");
    expect(request.description).toContain("src/parser.ts");
    expect(request.description).toContain("cannot be undone");
    expect(request.description).toContain("unstage it first");
    expect(request.confirmLabel).toBe("Discard changes");
    expect(request.cancelLabel).toBe("Keep the changes");
  });

  test("does not offer that promise when only untracked files are going", () => {
    const request = describeDiscard([
      row({ path: "one.txt", status: "A", untracked: true }),
    ]);

    expect(request.description).not.toContain("unstage it first");
  });

  test("counts both kinds when several files go at once", () => {
    const request = describeDiscard([
      row({ path: "a.ts" }),
      row({ path: "b.ts" }),
      row({ path: "c.txt", status: "A", untracked: true }),
    ]);

    expect(request.title).toBe("Discard changes in 3 files?");
    expect(request.description).toContain("2 tracked files go back");
    expect(request.description).toContain("1 untracked file is deleted");
    expect(request.confirmLabel).toBe("Discard and delete");
  });

  test("spells out a rename as old to new", () => {
    const request = describeDiscard([
      row({ oldPath: "src/old.ts", path: "src/new.ts", status: "R" }),
    ]);

    expect(request.description).toContain("src/old.ts");
    expect(request.description).toContain("src/new.ts");
  });

  test("never leaks a backtick or markdown into the copy shown to a person", () => {
    for (const request of [
      describeDiscard([row()]),
      describeDiscard([row({ status: "A", untracked: true })]),
      describeDiscard([row({ path: "a.ts" }), row({ path: "b.ts" })]),
    ]) {
      expect(request.title).not.toContain("`");
      expect(request.description).not.toContain("`");
      expect(request.description).not.toContain("*");
    }
  });
});

describe("patchHasBothSides", () => {
  test("is false for a file that is purely new", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+const a = 1;",
      "+export default a;",
    ].join("\n");

    expect(patchHasBothSides(patch)).toBeFalse();
  });

  test("is true once a line was removed as well as added", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");

    expect(patchHasBothSides(patch)).toBeTrue();
  });

  test("does not mistake the file headers for content", () => {
    expect(
      patchHasBothSides("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n context"),
    ).toBeFalse();
  });
});
