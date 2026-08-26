import type { DiffFile } from "@/app/api/sessions/[sessionId]/diff/route";

/**
 * What is left of the old diff file list.
 *
 * The list itself is gone: the Changes tab is a source-control panel now
 * (`source-control-panel.tsx`), with staged and unstaged sections backed by
 * git's real index, and it reads `getWorkingTreeStatus` rather than the
 * branch-wide diff route this file was built on. Nothing rendered this
 * component any more.
 *
 * The predicate stays because `git-panel.tsx` still uses it to decide whether
 * the branch diff it fetches contains anything uncommitted — a different
 * question, over a different data source, and not this rewrite's to answer.
 */
export function isUncommittedFile(file: DiffFile): boolean {
  return file.stagingStatus === "unstaged" || file.stagingStatus === "partial";
}
