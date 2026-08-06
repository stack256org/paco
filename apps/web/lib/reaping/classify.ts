import { toContainerName } from "@paco/sandbox";
import {
  getPersistentSandboxName,
  getSessionSandboxName,
} from "@/lib/sandbox/utils";
import type {
  ClassifiedContainer,
  ClassifiedWorkspace,
  ContainerSnapshot,
  ReclaimPlan,
  ResourceOwnership,
  SessionResourceNames,
  StorageTotals,
  WorkspaceSnapshot,
} from "./types";

/**
 * Deciding which host resources still belong to something.
 *
 * Everything here is a pure function of two lists: what the database says
 * exists, and what the host actually has. That is the whole reason this is its
 * own module — the question "is this container an orphan?" is the part that
 * must never be wrong, and it can be tested exhaustively without Docker, a
 * filesystem, or a database.
 *
 * The mapping runs **forwards only**: a session row is turned into the names it
 * would produce, and a host resource is an orphan when its name is in no
 * session's set. The reverse — parsing `paco-sbx-session_abc` back into a
 * session id — looks equivalent and is not, because `toContainerName` replaces
 * characters it cannot use and is therefore lossy. Guessing wrong in that
 * direction deletes a live workspace.
 */

interface SessionRowLike {
  id: string;
  status: string | null;
  title?: string | null;
  sandboxState: unknown;
}

/**
 * The host names one session row could own.
 *
 * Two names, not one: the sandbox name Paco derives from the session id, and
 * whatever name the row's persisted state actually carries. They agree for
 * every session created by the current code, and they do not for rows written
 * before the naming settled — where trusting only the derived name would
 * declare a live workspace an orphan.
 */
export function sessionResourceNames(
  session: SessionRowLike,
): SessionResourceNames {
  const derived = getSessionSandboxName(session.id);
  const persisted = getPersistentSandboxName(session.sandboxState);

  const workspaceNames =
    persisted && persisted !== derived ? [derived, persisted] : [derived];

  return {
    sessionId: session.id,
    title: session.title ?? null,
    archived: session.status === "archived",
    containerNames: workspaceNames.map((name) => toContainerName(name)),
    workspaceNames,
  };
}

function indexBy(
  sessions: SessionResourceNames[],
  pick: (session: SessionResourceNames) => string[],
): Map<string, SessionResourceNames> {
  const index = new Map<string, SessionResourceNames>();
  for (const session of sessions) {
    for (const name of pick(session)) {
      // First writer wins. Two rows claiming one name is impossible for
      // generated ids, and if it ever happened, keeping the earlier owner is
      // the choice that leaves the resource owned rather than orphaned.
      if (!index.has(name)) {
        index.set(name, session);
      }
    }
  }
  return index;
}

function ownershipOf(owner: SessionResourceNames | undefined): {
  ownership: ResourceOwnership;
  sessionId: string | null;
  sessionTitle: string | null;
} {
  if (!owner) {
    return { ownership: "orphaned", sessionId: null, sessionTitle: null };
  }
  return {
    ownership: owner.archived ? "archived" : "live",
    sessionId: owner.sessionId,
    sessionTitle: owner.title,
  };
}

export function classifyContainers(
  containers: ContainerSnapshot[],
  sessions: SessionResourceNames[],
): ClassifiedContainer[] {
  const byName = indexBy(sessions, (session) => session.containerNames);

  return containers.map((container) => ({
    ...container,
    ...ownershipOf(byName.get(container.name)),
  }));
}

/**
 * Whether a directory might hold work that exists on no other machine.
 *
 * Deliberately pessimistic. A failed probe counts as "yes", because the
 * alternative is offering to delete a directory whose contents are unknown.
 *
 * The one case that answers "no" is the one worth knowing: a workspace with
 * nothing uncommitted and nothing unpushed is fully represented on its remote,
 * so the copy in front of the operator can say so honestly.
 *
 * A brand-new workspace answers "yes" — it carries the baseline `.gitignore`
 * uncommitted and one empty initial commit. That is technically true and costs
 * nothing: these directories are removed one at a time with their real numbers
 * on screen, never in bulk, so erring toward caution never hides anything.
 */
export function mayHoldUnsavedWork(snapshot: WorkspaceSnapshot): boolean {
  const work = snapshot.unsavedWork;
  if (!work) {
    return true;
  }
  return work.uncommittedFiles > 0 || work.unpushedCommits > 0;
}

export function classifyWorkspaces(
  workspaces: WorkspaceSnapshot[],
  sessions: SessionResourceNames[],
): ClassifiedWorkspace[] {
  const byName = indexBy(sessions, (session) => session.workspaceNames);

  return workspaces.map((workspace) => ({
    ...workspace,
    ...ownershipOf(byName.get(workspace.name)),
    mayHoldUnsavedWork: mayHoldUnsavedWork(workspace),
  }));
}

/**
 * Split what is classified into the actions an operator may take.
 *
 * An orphaned container is in the plan whether or not it is running: running is
 * precisely what makes it expensive, and nothing in the product can stop it.
 *
 * A running container owned by a live session is never in the plan — somebody
 * is working in it. A *stopped* one is, because it is hibernated, and waking a
 * session recreates the container from its name over the same directory.
 */
export function planReclaim(params: {
  containers: ClassifiedContainer[];
  workspaces: ClassifiedWorkspace[];
}): ReclaimPlan {
  return {
    orphanedContainers: params.containers.filter(
      (container) => container.ownership === "orphaned",
    ),
    stoppedContainers: params.containers.filter(
      (container) => container.ownership !== "orphaned" && !container.running,
    ),
    orphanedWorkspaces: params.workspaces.filter(
      (workspace) => workspace.ownership === "orphaned",
    ),
  };
}

function sumBy<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

export function summarize(params: {
  containers: ClassifiedContainer[];
  workspaces: ClassifiedWorkspace[];
  plan: ReclaimPlan;
}): StorageTotals {
  const { containers, workspaces, plan } = params;

  const orphanedWorkspaceBytes = sumBy(
    plan.orphanedWorkspaces,
    (workspace) => workspace.sizeBytes,
  );

  return {
    workspaceCount: workspaces.length,
    workspaceBytes: sumBy(workspaces, (workspace) => workspace.sizeBytes),
    containerCount: containers.length,
    runningContainerCount: containers.filter((container) => container.running)
      .length,
    containerWritableBytes: sumBy(
      containers,
      (container) => container.writableBytes,
    ),
    reclaimableBytes:
      sumBy(plan.orphanedContainers, (c) => c.writableBytes) +
      sumBy(plan.stoppedContainers, (c) => c.writableBytes) +
      orphanedWorkspaceBytes,
    orphanedWorkspaceCount: plan.orphanedWorkspaces.length,
    orphanedWorkspaceBytes,
    orphanedContainerCount: plan.orphanedContainers.length,
    unmeasuredWorkspaceCount: workspaces.filter((w) => !w.measured).length,
  };
}
