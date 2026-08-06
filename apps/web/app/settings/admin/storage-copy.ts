import { formatBytes, pluralize } from "@/lib/reaping/format-bytes";
import type {
  ClassifiedContainer,
  ClassifiedWorkspace,
} from "@/lib/reaping/types";

/**
 * The sentences shown before something is removed.
 *
 * Kept apart from the component, and unit tested, because these are the words
 * somebody reads to decide. Each one has to say three things: what goes, what
 * stays, and — for anything irreversible — what it would cost to be wrong. A
 * dialog that describes consequences it does not have is worse than no dialog,
 * because being wrong once teaches people to skim the next one.
 */

export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
}

function nameList(names: string[], limit = 4): string {
  if (names.length <= limit) {
    return names.join(", ");
  }
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

export function orphanedContainersConfirm(
  containers: ClassifiedContainer[],
): ConfirmCopy {
  const bytes = containers.reduce(
    (total, container) => total + container.writableBytes,
    0,
  );

  return {
    title: `Remove ${pluralize(containers.length, "unclaimed container", "unclaimed containers")}?`,
    description: [
      `Paco removes ${nameList(containers.map((container) => container.name))}.`,
      `No workspace in Paco points at these any more, so nothing can reach them — they reclaim ${formatBytes(bytes)}.`,
      "Nothing on disk is deleted: the files these containers ran against live in your workspaces folder and are untouched.",
      "Only Paco's own paco-sbx- containers are removed. Everything else on this machine, including Paco's database, is left alone.",
    ].join(" "),
    confirmLabel: "Remove containers",
    busyLabel: "Removing…",
  };
}

export function stoppedContainersConfirm(
  containers: ClassifiedContainer[],
): ConfirmCopy {
  const bytes = containers.reduce(
    (total, container) => total + container.writableBytes,
    0,
  );

  return {
    title: `Remove ${pluralize(containers.length, "sleeping container", "sleeping containers")}?`,
    description: [
      `These ${containers.length === 1 ? "belongs" : "belong"} to workspaces that still exist and are currently stopped, and reclaim ${formatBytes(bytes)}.`,
      "No code is lost: a workspace's files live on disk, not in its container, and opening one builds a fresh container over the same files.",
      "The only cost is that the next start is slower while that happens.",
    ].join(" "),
    confirmLabel: "Remove containers",
    busyLabel: "Removing…",
  };
}

function unsavedWorkSentence(workspace: ClassifiedWorkspace): string {
  const work = workspace.unsavedWork;
  if (!work) {
    return "Paco could not read this folder's git history, so treat everything in it as unsaved.";
  }

  const parts: string[] = [];
  if (work.uncommittedFiles > 0) {
    parts.push(
      pluralize(work.uncommittedFiles, "uncommitted file", "uncommitted files"),
    );
  }
  if (work.unpushedCommits > 0) {
    parts.push(
      `${pluralize(work.unpushedCommits, "commit", "commits")} that ${work.hasRemote ? "were never pushed" : "exist on no remote, because none is configured"}`,
    );
  }

  if (parts.length === 0) {
    return "Everything committed here is already on a remote, so nothing unique is lost.";
  }

  return `It contains ${parts.join(" and ")} — that work exists nowhere else.`;
}

export function orphanedWorkspaceConfirm(
  workspace: ClassifiedWorkspace,
): ConfirmCopy {
  return {
    title: `Delete ${workspace.name} permanently?`,
    description: [
      `This deletes ${workspace.path} and everything inside it — ${formatBytes(workspace.sizeBytes)}.`,
      unsavedWorkSentence(workspace),
      "No session in Paco points at this folder, so there is no copy anywhere and this cannot be undone.",
      "Its container is removed with it. Every other workspace is untouched.",
    ].join(" "),
    confirmLabel: "Delete this workspace",
    busyLabel: "Deleting…",
  };
}
