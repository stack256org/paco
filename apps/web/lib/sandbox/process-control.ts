import "server-only";

import type { connectSandbox } from "@paco/sandbox";

type ConnectedSandbox = Awaited<ReturnType<typeof connectSandbox>>;

/**
 * Stopping a long-running process Paco started inside a sandbox.
 *
 * Two mistakes are easy here and both were live:
 *
 * Killing the pid instead of the process group. The pid Paco records is the
 * shell that `exec`s the real command, and that command usually has children —
 * `pnpm dev` runs `vite`, which runs esbuild; code-server runs an extension
 * host. Signalling only the leader left the children holding the port,
 * reparented to init, while the caller reported success. Starting again then
 * stacked another orphan on top; two dev servers were running by the time this
 * was found.
 *
 * Checking too early. `kill` returns as soon as the signal is queued, not when
 * the process is gone, so a liveness check on the next line still sees it.
 * Stopping the editor reported failure every time for exactly this reason —
 * the editor did stop, a fraction of a second after being declared unstoppable.
 *
 * So: signal the group, then poll the caller's own definition of "still there"
 * until it clears, escalating to SIGKILL partway through.
 */

const KILL_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_ESCALATE_AFTER = 6;

/**
 * Signal a process and every process in its group.
 *
 * `docker exec` gives each launched shell its own process group and children
 * inherit it, so the group is exactly this one service — never anything else in
 * the container. The leader is signalled separately in case it has already left
 * the group.
 */
export async function signalProcessGroup(
  sandbox: ConnectedSandbox,
  pid: string,
  signal: "TERM" | "KILL",
  cwd: string,
): Promise<void> {
  await sandbox.exec(
    [
      `pgid=$(ps -o pgid= -p ${pid} 2>/dev/null | tr -d ' ')`,
      `if [ -n "$pgid" ]; then kill -${signal} -"$pgid" 2>/dev/null; fi`,
      `kill -${signal} ${pid} 2>/dev/null`,
      "true",
    ].join("; "),
    cwd,
    KILL_TIMEOUT_MS,
  );
}

/**
 * Stop a process group and wait for it to actually be gone.
 *
 * `isStillRunning` is the caller's own check — the port still answering, the
 * pid still alive — because "gone" means different things depending on what is
 * being stopped. Returns whether it really stopped, so a caller never reports a
 * success the user can see is untrue.
 */
export async function stopProcessGroup(params: {
  sandbox: ConnectedSandbox;
  pid: string;
  cwd: string;
  isStillRunning: () => Promise<boolean>;
  attempts?: number;
  intervalMs?: number;
  escalateAfter?: number;
}): Promise<boolean> {
  const {
    sandbox,
    pid,
    cwd,
    isStillRunning,
    attempts = DEFAULT_POLL_ATTEMPTS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    escalateAfter = DEFAULT_ESCALATE_AFTER,
  } = params;

  // TERM first, so a server gets the chance to close its sockets.
  await signalProcessGroup(sandbox, pid, "TERM", cwd);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!(await isStillRunning())) {
      return true;
    }

    if (attempt === escalateAfter) {
      await signalProcessGroup(sandbox, pid, "KILL", cwd);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return !(await isStillRunning());
}
