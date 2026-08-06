import type { DestructiveConfirmRequest } from "@/hooks/use-destructive-confirm";

/**
 * The question asked before merging a pull request whose checks have not
 * passed.
 *
 * It has to name three separate consequences, which is why it is built rather
 * than written out: the code lands on a branch other people build from, the
 * branch it came from may be deleted, and Paco then archives this workspace and
 * moves you somewhere else. That last one is the one nobody expects from a
 * button labelled "merge".
 */
export function forceMergeConfirm({
  baseBranch,
  deleteBranch,
}: {
  /** The branch the pull request lands on, e.g. "main". */
  baseBranch: string | null;
  /** Whether the source branch is deleted afterwards. */
  deleteBranch: boolean;
}): DestructiveConfirmRequest {
  const target = baseBranch ? `the ${baseBranch} branch` : "the main branch";

  const branchSentence = deleteBranch
    ? " The branch this work was done on is deleted straight afterwards, so there is no going back to it."
    : "";

  return {
    busyLabel: "Merging…",
    confirmLabel: "Merge anyway",
    description: `The automatic checks on this pull request have not passed — something in them is failing, still running, or blocked. Merging now puts this work into ${target} regardless, where everyone else on the project will get it and where anything that deploys from that branch will pick it up.${branchSentence} Paco then archives this workspace and takes you back to your list of workspaces. Taking a merge back means opening another pull request that undoes it.`,
    destructive: true,
    title: "Merge without passing checks?",
  };
}
