import { describe, expect, test } from "bun:test";
import {
  checkEntryName,
  fileContentKey,
  fileName,
  hasUnsavedChanges,
  joinPath,
  parentDirectory,
  renamedPath,
} from "./paths";

describe("parentDirectory", () => {
  test("returns the enclosing folder", () => {
    expect(parentDirectory("src/lib/utils.ts")).toBe("src/lib");
  });

  test("returns the root for a top-level file", () => {
    expect(parentDirectory("README.md")).toBe("");
  });

  test("ignores the trailing slash on directory entries", () => {
    expect(parentDirectory("src/lib/")).toBe("src");
  });

  test("returns the root for the root", () => {
    expect(parentDirectory("")).toBe("");
    expect(parentDirectory("/")).toBe("");
  });
});

describe("fileName", () => {
  test("returns the last segment", () => {
    expect(fileName("src/lib/utils.ts")).toBe("utils.ts");
    expect(fileName("README.md")).toBe("README.md");
  });

  test("names a directory without its trailing slash", () => {
    expect(fileName("src/lib/")).toBe("lib");
  });
});

describe("joinPath", () => {
  test("joins a folder and a name", () => {
    expect(joinPath("src", "index.ts")).toBe("src/index.ts");
  });

  test("treats an empty folder as the root", () => {
    expect(joinPath("", "index.ts")).toBe("index.ts");
  });

  test("does not double up separators", () => {
    expect(joinPath("src/", "/index.ts")).toBe("src/index.ts");
    expect(joinPath("src/lib/", "sub/index.ts")).toBe("src/lib/sub/index.ts");
  });

  test("tolerates an empty name", () => {
    expect(joinPath("src", "")).toBe("src");
  });
});

describe("renamedPath", () => {
  test("keeps the entry in its folder", () => {
    expect(renamedPath("src/lib/utils.ts", "helpers.ts")).toBe(
      "src/lib/helpers.ts",
    );
  });

  test("keeps a top-level entry at the top level", () => {
    expect(renamedPath("README.md", "READ-ME.md")).toBe("READ-ME.md");
  });

  test("lets a typed sub-path move the entry deeper", () => {
    expect(renamedPath("src/utils.ts", "lib/utils.ts")).toBe(
      "src/lib/utils.ts",
    );
  });
});

describe("hasUnsavedChanges", () => {
  test("is false before anything is loaded or edited", () => {
    expect(hasUnsavedChanges(null, null)).toBe(false);
    expect(hasUnsavedChanges("a", null)).toBe(false);
    expect(hasUnsavedChanges(null, "a")).toBe(false);
  });

  test("is false while the draft matches disk", () => {
    expect(hasUnsavedChanges("hello", "hello")).toBe(false);
  });

  test("is true for any difference, including whitespace only", () => {
    expect(hasUnsavedChanges("hello", "hello ")).toBe(true);
    expect(hasUnsavedChanges("hello", "")).toBe(true);
  });
});

describe("checkEntryName", () => {
  test("accepts an ordinary name and trims it", () => {
    expect(checkEntryName("  notes.md  ")).toEqual({
      ok: true,
      name: "notes.md",
    });
  });

  test("accepts a sub-path", () => {
    expect(checkEntryName("notes/today.md")).toEqual({
      ok: true,
      name: "notes/today.md",
    });
  });

  test("strips surrounding slashes rather than rejecting them", () => {
    expect(checkEntryName("/notes.md/")).toEqual({
      ok: true,
      name: "notes.md",
    });
  });

  test("rejects an empty name", () => {
    const result = checkEntryName("   ");
    expect(result.ok).toBe(false);
  });

  test("rejects dot segments", () => {
    expect(checkEntryName("..").ok).toBe(false);
    expect(checkEntryName("../secrets").ok).toBe(false);
    expect(checkEntryName("src/./x").ok).toBe(false);
  });

  test("rejects the reserved history folder in any position or case", () => {
    expect(checkEntryName(".git").ok).toBe(false);
    expect(checkEntryName(".GIT/config").ok).toBe(false);
    expect(checkEntryName("src/.git/hooks").ok).toBe(false);
  });

  test("rejects doubled separators", () => {
    expect(checkEntryName("src//index.ts").ok).toBe(false);
  });

  test("allows a plain space inside a name", () => {
    expect(checkEntryName("my notes.md")).toEqual({
      ok: true,
      name: "my notes.md",
    });
  });

  test("rejects characters that cannot appear in a name", () => {
    expect(checkEntryName("bad\u0000name").ok).toBe(false);
    expect(checkEntryName("bad\nname").ok).toBe(false);
    expect(checkEntryName("bad\\name").ok).toBe(false);
  });

  test("rejects a trailing space, which is invisible and confusing", () => {
    expect(checkEntryName("notes .md").ok).toBe(true);
    expect(checkEntryName("notes/folder /file.md").ok).toBe(false);
  });

  test("rejects an over-long name", () => {
    expect(checkEntryName("a".repeat(256)).ok).toBe(false);
    expect(checkEntryName("a".repeat(255)).ok).toBe(true);
  });

  test("explains itself without jargon", () => {
    const result = checkEntryName("");
    if (result.ok) throw new Error("expected a rejection");
    expect(result.message).not.toMatch(/path|segment|invalid|400/i);
  });
});

describe("fileContentKey", () => {
  test("is null when no file is open, so SWR does not fetch", () => {
    expect(fileContentKey("s1", "c1", null)).toBeNull();
  });

  test("encodes the path and chat", () => {
    expect(fileContentKey("s1", "c1", "src/a b.ts")).toBe(
      "/api/sessions/s1/files/content?path=src%2Fa+b.ts&chatId=c1",
    );
  });

  test("is stable for the same file, so one cache entry is shared", () => {
    expect(fileContentKey("s1", "c1", "a.ts")).toBe(
      fileContentKey("s1", "c1", "a.ts"),
    );
  });
});
