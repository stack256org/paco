import { describe, expect, test } from "bun:test";
import { forceMergeConfirm } from "./force-merge-confirm-copy";

describe("forceMergeConfirm", () => {
  test("asks the question as its title and names the action on the button", () => {
    const confirm = forceMergeConfirm({
      baseBranch: "main",
      deleteBranch: false,
    });

    expect(confirm.title).toBe("Merge without passing checks?");
    expect(confirm.confirmLabel).toBe("Merge anyway");
    expect(confirm.confirmLabel).not.toBe("OK");
    expect(confirm.destructive).toBe(true);
  });

  test("names the branch the work lands on", () => {
    const confirm = forceMergeConfirm({
      baseBranch: "release",
      deleteBranch: false,
    });

    expect(confirm.description).toContain("the release branch");
  });

  test("falls back to the main branch when GitHub has not said which", () => {
    const confirm = forceMergeConfirm({
      baseBranch: null,
      deleteBranch: false,
    });

    expect(confirm.description).toContain("the main branch");
  });

  test("warns about the branch deletion only when it will happen", () => {
    const deleting = forceMergeConfirm({
      baseBranch: "main",
      deleteBranch: true,
    });
    const keeping = forceMergeConfirm({
      baseBranch: "main",
      deleteBranch: false,
    });

    expect(deleting.description).toContain("is deleted");
    expect(keeping.description).not.toContain("is deleted");
  });

  test("says the workspace is archived, which the button does not", () => {
    // The consequence people are actually surprised by: merging ends the
    // workspace and moves them somewhere else.
    const confirm = forceMergeConfirm({
      baseBranch: "main",
      deleteBranch: true,
    });

    expect(confirm.description).toContain("archives this workspace");
  });

  test("says what is at stake rather than that it cannot be undone", () => {
    const confirm = forceMergeConfirm({
      baseBranch: "main",
      deleteBranch: true,
    });

    expect(confirm.description).not.toContain("cannot be undone");
    expect(confirm.description).toContain("have not passed");
  });
});
