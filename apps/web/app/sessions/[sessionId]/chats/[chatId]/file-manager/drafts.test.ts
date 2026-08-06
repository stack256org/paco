import { describe, expect, test } from "bun:test";
import {
  type DraftsByPath,
  dirtyDraftPaths,
  discardDraft,
  draftAt,
  moveDraft,
  NO_DRAFTS,
  setDraftText,
  startDraft,
} from "./drafts";

/** Two files being edited at once — the case that used to be impossible. */
function twoOpenEdits(): DraftsByPath {
  const withA = startDraft(NO_DRAFTS, "a.ts", "alpha");
  return startDraft(withA, "b.ts", "beta");
}

describe("draftAt", () => {
  test("finds the draft for one file", () => {
    expect(draftAt(twoOpenEdits(), "a.ts")).toEqual({
      path: "a.ts",
      base: "alpha",
      text: "alpha",
    });
  });

  test("is null for a file nobody is editing", () => {
    expect(draftAt(twoOpenEdits(), "c.ts")).toBeNull();
  });

  test("is null when no file is open", () => {
    expect(draftAt(twoOpenEdits(), null)).toBeNull();
  });
});

describe("startDraft", () => {
  test("starts from what the file holds, so nothing is changed yet", () => {
    const drafts = startDraft(NO_DRAFTS, "a.ts", "alpha");
    expect(dirtyDraftPaths(drafts)).toEqual([]);
  });

  test("leaves other files' drafts alone", () => {
    const drafts = startDraft(twoOpenEdits(), "c.ts", "gamma");
    expect(draftAt(drafts, "a.ts")?.text).toBe("alpha");
    expect(draftAt(drafts, "b.ts")?.text).toBe("beta");
  });
});

describe("setDraftText", () => {
  test("typing in one file does not touch another", () => {
    const drafts = setDraftText(twoOpenEdits(), "a.ts", "alpha edited");

    expect(draftAt(drafts, "a.ts")?.text).toBe("alpha edited");
    expect(draftAt(drafts, "b.ts")?.text).toBe("beta");
  });

  test("keeps the baseline, so the change can still be seen", () => {
    const drafts = setDraftText(twoOpenEdits(), "a.ts", "alpha edited");

    expect(draftAt(drafts, "a.ts")?.base).toBe("alpha");
    expect(dirtyDraftPaths(drafts)).toEqual(["a.ts"]);
  });

  test("typing back to the original text is not an unsaved change", () => {
    const edited = setDraftText(twoOpenEdits(), "a.ts", "alpha edited");
    expect(dirtyDraftPaths(setDraftText(edited, "a.ts", "alpha"))).toEqual([]);
  });

  test("ignores a file nobody pressed Edit on", () => {
    const drafts = twoOpenEdits();
    expect(setDraftText(drafts, "c.ts", "gamma")).toBe(drafts);
  });

  test("returns the same map when the text did not actually change", () => {
    const drafts = twoOpenEdits();
    expect(setDraftText(drafts, "a.ts", "alpha")).toBe(drafts);
  });
});

describe("discardDraft", () => {
  test("throws one file's work away and keeps the rest", () => {
    const drafts = discardDraft(twoOpenEdits(), "a.ts");

    expect(draftAt(drafts, "a.ts")).toBeNull();
    expect(draftAt(drafts, "b.ts")?.text).toBe("beta");
  });

  test("returns the same map for a file with no draft", () => {
    const drafts = twoOpenEdits();
    expect(discardDraft(drafts, "c.ts")).toBe(drafts);
  });
});

describe("moveDraft", () => {
  test("carries typed work to the file's new name", () => {
    const edited = setDraftText(twoOpenEdits(), "a.ts", "alpha edited");
    const drafts = moveDraft(edited, "a.ts", "alpha.ts");

    expect(draftAt(drafts, "a.ts")).toBeNull();
    expect(draftAt(drafts, "alpha.ts")).toEqual({
      path: "alpha.ts",
      base: "alpha",
      text: "alpha edited",
    });
    expect(dirtyDraftPaths(drafts)).toEqual(["alpha.ts"]);
  });

  test("does nothing for a file that was not being edited", () => {
    const drafts = twoOpenEdits();
    expect(moveDraft(drafts, "c.ts", "gamma.ts")).toBe(drafts);
  });

  test("does nothing when the name did not change", () => {
    const drafts = twoOpenEdits();
    expect(moveDraft(drafts, "a.ts", "a.ts")).toBe(drafts);
  });
});

describe("dirtyDraftPaths", () => {
  test("is empty when nothing has been typed", () => {
    expect(dirtyDraftPaths(NO_DRAFTS)).toEqual([]);
    expect(dirtyDraftPaths(twoOpenEdits())).toEqual([]);
  });

  test("reports a background file, not just the one on screen", () => {
    const edited = setDraftText(twoOpenEdits(), "b.ts", "beta edited");
    expect(dirtyDraftPaths(edited)).toEqual(["b.ts"]);
  });

  test("reports every unsaved file", () => {
    const first = setDraftText(twoOpenEdits(), "a.ts", "alpha edited");
    const both = setDraftText(first, "b.ts", "beta edited");
    expect([...dirtyDraftPaths(both)].sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("counts a whitespace-only difference", () => {
    const edited = setDraftText(twoOpenEdits(), "a.ts", "alpha ");
    expect(dirtyDraftPaths(edited)).toEqual(["a.ts"]);
  });
});

describe("switching between files", () => {
  /*
   * The bug this whole module exists for: typing in one file, looking at
   * another, and coming back to find your own words still there.
   */
  test("a draft survives another file being looked at and edited", () => {
    let drafts = startDraft(NO_DRAFTS, "a.ts", "alpha");
    drafts = setDraftText(drafts, "a.ts", "half-written sentence");

    drafts = startDraft(drafts, "b.ts", "beta");
    drafts = setDraftText(drafts, "b.ts", "beta edited");

    expect(draftAt(drafts, "a.ts")?.text).toBe("half-written sentence");
  });
});
