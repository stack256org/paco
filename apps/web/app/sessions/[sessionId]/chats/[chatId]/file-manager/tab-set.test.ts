import { describe, expect, test } from "bun:test";
import { closeTab, neighbourTab, openTab, renameTab } from "./tab-set";

describe("openTab", () => {
  test("adds a file at the end", () => {
    expect(openTab(["a.ts"], "b.ts")).toEqual(["a.ts", "b.ts"]);
  });

  test("opens the first file", () => {
    expect(openTab([], "a.ts")).toEqual(["a.ts"]);
  });

  test("never opens the same file twice", () => {
    expect(openTab(["a.ts", "b.ts"], "a.ts")).toEqual(["a.ts", "b.ts"]);
  });

  test("returns the same array when nothing changed, so state settles", () => {
    const paths = ["a.ts", "b.ts"];
    expect(openTab(paths, "b.ts")).toBe(paths);
  });

  test("treats two files with the same name in different folders as two", () => {
    expect(openTab(["src/index.ts"], "docs/index.ts")).toEqual([
      "src/index.ts",
      "docs/index.ts",
    ]);
  });
});

describe("closeTab", () => {
  test("removes the file", () => {
    expect(closeTab(["a.ts", "b.ts"], "a.ts")).toEqual(["b.ts"]);
  });

  test("leaves the others in the order they were opened", () => {
    expect(closeTab(["a.ts", "b.ts", "c.ts"], "b.ts")).toEqual([
      "a.ts",
      "c.ts",
    ]);
  });

  test("closing the last one empties the strip", () => {
    expect(closeTab(["a.ts"], "a.ts")).toEqual([]);
  });

  test("returns the same array for a file that was not open", () => {
    const paths = ["a.ts"];
    expect(closeTab(paths, "b.ts")).toBe(paths);
  });
});

describe("neighbourTab", () => {
  test("moves to the file on the right", () => {
    expect(neighbourTab(["a.ts", "b.ts", "c.ts"], "b.ts")).toBe("c.ts");
  });

  test("falls back to the left at the end of the strip", () => {
    expect(neighbourTab(["a.ts", "b.ts"], "b.ts")).toBe("a.ts");
  });

  test("has nowhere to go when it was the only file", () => {
    expect(neighbourTab(["a.ts"], "a.ts")).toBeNull();
  });

  test("has nowhere to go for a file that was not open", () => {
    expect(neighbourTab(["a.ts"], "b.ts")).toBeNull();
    expect(neighbourTab([], "a.ts")).toBeNull();
  });
});

describe("renameTab", () => {
  test("keeps the file where it is in the strip", () => {
    expect(renameTab(["a.ts", "b.ts", "c.ts"], "b.ts", "beta.ts")).toEqual([
      "a.ts",
      "beta.ts",
      "c.ts",
    ]);
  });

  test("follows a file that moved to another folder", () => {
    expect(renameTab(["src/a.ts"], "src/a.ts", "lib/a.ts")).toEqual([
      "lib/a.ts",
    ]);
  });

  test("ignores a file that is not open", () => {
    const paths = ["a.ts"];
    expect(renameTab(paths, "b.ts", "c.ts")).toBe(paths);
  });

  test("does not leave two tabs for one file", () => {
    expect(renameTab(["a.ts", "b.ts"], "a.ts", "b.ts")).toEqual(["b.ts"]);
  });
});
