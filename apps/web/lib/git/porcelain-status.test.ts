import { describe, expect, test } from "bun:test";
import { parsePorcelainZ, pathsToTouch } from "./porcelain-status";

/** Build a `-z` record: `XY path` then, for a rename, the original path. */
function record(entry: string, extra?: string): string {
  return extra ? `${entry}\0${extra}\0` : `${entry}\0`;
}

describe("parsePorcelainZ", () => {
  test("reads the index column as staged and the worktree column as unstaged", () => {
    const parsed = parsePorcelainZ(
      record("M  staged.ts") + record(" M unstaged.ts"),
    );

    expect(parsed.staged).toEqual([{ path: "staged.ts", status: "M" }]);
    expect(parsed.unstaged).toEqual([{ path: "unstaged.ts", status: "M" }]);
  });

  test("lists a file that is staged and then modified again on both sides", () => {
    const parsed = parsePorcelainZ(record("MM both.ts"));

    expect(parsed.staged).toEqual([{ path: "both.ts", status: "M" }]);
    expect(parsed.unstaged).toEqual([{ path: "both.ts", status: "M" }]);
  });

  test("keeps a path containing a space intact", () => {
    // The reason for `-z`. Plain porcelain would quote this one.
    const parsed = parsePorcelainZ(record("?? my notes/read me.md"));

    expect(parsed.untracked).toEqual([
      { path: "my notes/read me.md", status: "A" },
    ]);
  });

  test("takes the original path from the extra field of a rename", () => {
    const parsed = parsePorcelainZ(record("R  new.ts", "old.ts"));

    expect(parsed.staged).toEqual([
      { path: "new.ts", status: "R", oldPath: "old.ts" },
    ]);
  });

  test("does not let a rename's extra field be read as its own record", () => {
    // The only place the record length varies. Treating `old.ts` as an entry
    // would produce a garbage row and shift every path after it.
    const parsed = parsePorcelainZ(
      record("R  new.ts", "old.ts") + record("A  added.ts"),
    );

    expect(parsed.staged).toEqual([
      { path: "new.ts", status: "R", oldPath: "old.ts" },
      { path: "added.ts", status: "A" },
    ]);
  });

  test("handles a copy the same way as a rename", () => {
    const parsed = parsePorcelainZ(record("C  copy.ts", "source.ts"));

    expect(parsed.staged).toEqual([
      { path: "copy.ts", status: "C", oldPath: "source.ts" },
    ]);
  });

  test("reports every conflict shape as unmerged, and never as staged", () => {
    // Committing one of these records the conflict markers, so it must never
    // read as work that is ready to go.
    for (const code of ["UU", "AA", "DD", "AU", "UA", "DU", "UD"]) {
      const parsed = parsePorcelainZ(record(`${code} clash.ts`));

      expect(parsed.staged).toEqual([]);
      expect(parsed.unstaged).toEqual([{ path: "clash.ts", status: "U" }]);
    }
  });

  test("calls a type change a modification, because that is what it is to a reader", () => {
    const parsed = parsePorcelainZ(record("T  link.ts"));

    expect(parsed.staged).toEqual([{ path: "link.ts", status: "M" }]);
  });

  test("drops an ignored entry rather than showing it as a change", () => {
    expect(parsePorcelainZ(record("!! build/out.js")).untracked).toEqual([]);
  });

  test("reads an empty status as nothing at all", () => {
    expect(parsePorcelainZ("")).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
    });
  });
});

describe("pathsToTouch", () => {
  test("adds the source of a staged rename", () => {
    // One row in the panel is two index entries; acting on the new name alone
    // leaves the deletion staged and the rename half-undone.
    const status = parsePorcelainZ(record("R  new.ts", "old.ts"));

    expect(pathsToTouch(["new.ts"], status).sort()).toEqual([
      "new.ts",
      "old.ts",
    ]);
  });

  test("leaves an ordinary path alone", () => {
    const status = parsePorcelainZ(record("M  plain.ts"));

    expect(pathsToTouch(["plain.ts"], status)).toEqual(["plain.ts"]);
  });

  test("does not repeat a path that was asked for twice", () => {
    const status = parsePorcelainZ(record("M  plain.ts"));

    expect(pathsToTouch(["plain.ts", "plain.ts"], status)).toEqual([
      "plain.ts",
    ]);
  });
});
