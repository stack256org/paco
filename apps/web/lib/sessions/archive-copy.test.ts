import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_COPY,
  archiveConfirmBody,
  archivedWorkspaceNotice,
  archivedWorkspacePhase,
  restoreFailureMessage,
} from "./archive-copy";

describe("archiveConfirmBody", () => {
  test("names the workspace being archived", () => {
    expect(archiveConfirmBody("Lisbon")).toContain('"Lisbon"');
  });

  test("promises nothing is deleted, and points at where to get it back", () => {
    const body = archiveConfirmBody("Lisbon");

    expect(body).toContain("Nothing is deleted");
    // The old copy sent people to an "Archive list" that did not exist. It has
    // to name the section that does.
    expect(body).toContain(`"${ARCHIVE_COPY.sectionTitle}"`);
  });

  test("warns before the click that the running app does not come back", () => {
    expect(archiveConfirmBody("Lisbon")).toContain("Start preview");
  });
});

describe("archivedWorkspacePhase", () => {
  test("is settling while the container is still recorded as running", () => {
    expect(archivedWorkspacePhase({ hasRuntimeSandboxState: true })).toBe(
      "settling",
    );
  });

  test("is restorable once the container record is gone", () => {
    expect(archivedWorkspacePhase({ hasRuntimeSandboxState: false })).toBe(
      "restorable",
    );
  });
});

describe("archivedWorkspaceNotice", () => {
  test("offers restore when the workspace has settled", () => {
    const notice = archivedWorkspaceNotice("restorable");

    expect(notice.actionDisabled).toBe(false);
    expect(notice.actionLabel).toBe(ARCHIVE_COPY.restoreAction);
    expect(notice.detail).toContain("still here");
    expect(notice.detail).toContain("Start preview");
  });

  test("withholds restore, and says why, while still closing down", () => {
    const notice = archivedWorkspaceNotice("settling");

    expect(notice.actionDisabled).toBe(true);
    expect(notice.headline).toContain("closing down");
    expect(notice.detail).toContain("few seconds");
  });
});

describe("restoreFailureMessage", () => {
  test("prefers the server's own wording", () => {
    const message = restoreFailureMessage(
      new Error("This workspace is still going to sleep."),
    );

    expect(message).toBe("This workspace is still going to sleep.");
  });

  test("reads a message off a plain object", () => {
    expect(restoreFailureMessage({ message: "Nope." })).toBe("Nope.");
  });

  test("falls back when there is nothing readable to show", () => {
    expect(restoreFailureMessage(new Error("   "))).toBe(
      ARCHIVE_COPY.restoreFailedFallback,
    );
    expect(restoreFailureMessage(undefined)).toBe(
      ARCHIVE_COPY.restoreFailedFallback,
    );
    expect(restoreFailureMessage({ status: 500 })).toBe(
      ARCHIVE_COPY.restoreFailedFallback,
    );
  });
});
