import "server-only";

import * as path from "node:path";
import { connectSandbox, type SandboxState } from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { candidateContainerPort } from "@/lib/preview/nginx-config";
import { stopProcessGroup } from "@/lib/sandbox/process-control";
import { canOperateOnSandbox } from "@/lib/sandbox/utils";

/**
 * Reclaiming the ports a design candidate's dev server holds.
 *
 * A candidate's dev server is started by the candidate's own agent turn, on
 * the strength of a sentence in its system prompt (`buildPortContractInstruction`
 * in `lib/design/design-turn.ts`) telling it to bind
 * `candidateContainerPort(n)` — 5173, 4321 or 8000. Nothing in Paco starts
 * it, so nothing in Paco had a pid for it, and nothing ever stopped it: the
 * worktree was `rm -rf`'d out from under a process that kept the port for the
 * lifetime of the container. The next design turn's candidate then could not
 * bind its own port, and showed as permanently unreachable with no error
 * anywhere.
 *
 * Those three ports are *also* legitimate targets for the chat's own dev
 * server — `DEFAULT_SANDBOX_PORTS` publishes all four and the dev-server route
 * deliberately adopts a server found on any of them. So "something is
 * listening on 5173" is nowhere near enough reason to kill it. The listener's
 * working directory is: a process whose cwd is inside `<workspace>/designs/`
 * is a candidate's dev server and nothing else, because that directory tree
 * exists for exactly one purpose. Every kill below is gated on that.
 */

/** How long the /proc probe may run inside the container. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The workspace-relative directory every candidate worktree lives under —
 * `designs/<chatId>/<n>/`, mirroring `lib/design/candidates.ts`.
 */
const DESIGNS_DIRNAME = "designs";

/** A process holding one of the candidate ports, and where it is running. */
export interface CandidateListener {
  pid: string;
  /** The listener's working directory, as `/proc/<pid>/cwd` resolves it. */
  cwd: string;
}

/**
 * Shell that prints the pid listening on `port` and that pid's working
 * directory, one per line.
 *
 * /proc rather than `ss` or `lsof`, neither of which is installed in the
 * sandbox image — the same lesson `app/api/sessions/[sessionId]/dev-server/route.ts`
 * records in `findPidOnPortScript`, whose socket-inode walk this mirrors. The
 * extra `readlink` is what makes the result safe to act on: without it there
 * is no way to tell a candidate's dev server from the chat's own.
 */
export function candidateListenerScript(port: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return [
    `inode=$(awk -v p=":${hex}" '$4=="0A" && $2 ~ p"$" {print $10; exit}' /proc/net/tcp /proc/net/tcp6 2>/dev/null)`,
    '[ -n "$inode" ] || exit 0',
    "for d in /proc/[0-9]*; do",
    '  if ls -l "$d/fd" 2>/dev/null | grep -q "socket:\\[$inode\\]"; then',
    '    basename "$d"',
    '    readlink "$d/cwd" 2>/dev/null',
    "    exit 0",
    "  fi",
    "done",
  ].join("; ");
}

/** Read the probe's two lines back, or `null` when nothing was listening. */
export function parseCandidateListener(
  stdout: string,
): CandidateListener | null {
  const [pidLine = "", cwdLine = ""] = stdout.split("\n");
  const pid = pidLine.trim();
  if (!/^[1-9][0-9]*$/.test(pid)) {
    return null;
  }
  return { pid, cwd: cwdLine.trim() };
}

/**
 * Whether a listener's working directory puts it inside this workspace's
 * candidate worktrees.
 *
 * `/proc/<pid>/cwd` gains a ` (deleted)` suffix once the directory it points
 * at has been unlinked, which is precisely the case that matters most here —
 * the worktree is already gone and the process is still holding the port — so
 * the suffix is stripped rather than allowed to defeat the match. The match
 * is on the `designs/` directory itself, not on one candidate's path, because
 * a dev server usually runs from a package subdirectory of the worktree.
 */
export function isCandidateWorktreeCwd(
  cwd: string,
  workspaceRoot: string,
): boolean {
  const resolved = cwd.replace(/ \(deleted\)$/, "").trim();
  if (!resolved) {
    return false;
  }
  const designsRoot = path.posix.join(workspaceRoot, DESIGNS_DIRNAME);
  return resolved === designsRoot || resolved.startsWith(`${designsRoot}/`);
}

/** What became of one candidate port. */
export type CandidateDevServerOutcome =
  /** The port was free, or nothing was listening on it. */
  | "idle"
  /** A candidate's dev server was there and is now gone. */
  | "stopped"
  /** Something was listening, but not from a candidate worktree — left alone. */
  | "not-ours"
  /** A candidate's dev server survived SIGKILL, or the probe failed. */
  | "failed";

type ConnectedSandbox = Awaited<ReturnType<typeof connectSandbox>>;

/**
 * Stop the dev servers holding `indexes`' candidate ports, if — and only if —
 * they are running out of this workspace's `designs/` tree.
 *
 * Never throws: this runs on cleanup paths (discarding candidates, deleting a
 * chat, the periodic reconciliation) where failing to reclaim a port is a much
 * smaller problem than failing the thing the user actually asked for.
 */
export async function stopCandidateDevServers(params: {
  sandbox: ConnectedSandbox;
  workspaceRoot: string;
  indexes: readonly (1 | 2 | 3)[];
}): Promise<Map<1 | 2 | 3, CandidateDevServerOutcome>> {
  const { sandbox, workspaceRoot, indexes } = params;
  const outcomes = new Map<1 | 2 | 3, CandidateDevServerOutcome>();

  for (const index of indexes) {
    const port = candidateContainerPort(index);
    try {
      const probe = await sandbox.exec(
        candidateListenerScript(port),
        workspaceRoot,
        PROBE_TIMEOUT_MS,
      );
      const listener = parseCandidateListener(probe.stdout);
      if (!listener) {
        outcomes.set(index, "idle");
        continue;
      }
      if (!isCandidateWorktreeCwd(listener.cwd, workspaceRoot)) {
        outcomes.set(index, "not-ours");
        continue;
      }

      const stopped = await stopProcessGroup({
        sandbox,
        pid: listener.pid,
        cwd: workspaceRoot,
        isStillRunning: async () => {
          const again = await sandbox.exec(
            candidateListenerScript(port),
            workspaceRoot,
            PROBE_TIMEOUT_MS,
          );
          return parseCandidateListener(again.stdout) !== null;
        },
      });
      outcomes.set(index, stopped ? "stopped" : "failed");
    } catch (error) {
      console.error(
        `Failed to stop the design candidate dev server on port ${port}:`,
        error,
      );
      outcomes.set(index, "failed");
    }
  }

  return outcomes;
}

/** Every candidate index, in the order candidates are created. */
export const CANDIDATE_INDEXES: readonly (1 | 2 | 3)[] = [1, 2, 3];

/**
 * The same thing, for a chat whose sandbox has to be resolved first.
 *
 * The database lookup is here rather than in `lib/design/candidates.ts`
 * (which is what calls this) on purpose: that module manages git worktrees on
 * the host filesystem and takes a workspace path, not a chat's row, and
 * giving it a Postgres dependency to reach a Docker container would put three
 * unrelated subsystems in one file. Callers that already hold a
 * `SandboxState` should use `stopCandidateDevServers` directly and skip the
 * two queries.
 *
 * Best-effort in every direction — a chat with no sandbox, an archived
 * session, or a Docker daemon that cannot be reached all resolve to "nothing
 * to stop" rather than an error.
 */
export async function stopCandidateDevServersForChat(params: {
  chatId: string;
  indexes?: readonly (1 | 2 | 3)[];
}): Promise<void> {
  const { chatId, indexes = CANDIDATE_INDEXES } = params;

  try {
    const { getChatById, getSessionById } = await import("@/lib/db/sessions");
    const chat = await getChatById(chatId);
    if (!chat) {
      return;
    }
    const session = await getSessionById(chat.sessionId);
    if (!session || !canOperateOnSandbox(session.sandboxState)) {
      return;
    }

    await stopCandidateDevServersForSandbox({
      sandboxState: session.sandboxState,
      indexes,
    });
  } catch (error) {
    console.error(
      `Failed to reclaim design candidate ports for chat ${chatId}:`,
      error,
    );
  }
}

/** Connect to one session's sandbox and stop the named candidate ports. */
export async function stopCandidateDevServersForSandbox(params: {
  sandboxState: SandboxState | null | undefined;
  indexes?: readonly (1 | 2 | 3)[];
}): Promise<Map<1 | 2 | 3, CandidateDevServerOutcome>> {
  const { sandboxState, indexes = CANDIDATE_INDEXES } = params;
  if (!canOperateOnSandbox(sandboxState)) {
    return new Map();
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    return await stopCandidateDevServers({
      sandbox,
      workspaceRoot: hostWorkspaceFor(sandboxState),
      indexes,
    });
  } catch (error) {
    console.error(
      "Failed to reach the sandbox to reclaim candidate ports:",
      error,
    );
    return new Map();
  }
}
