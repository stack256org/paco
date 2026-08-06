/**
 * Keeping, and cleaning up, whatever the dev server printed.
 *
 * The launch runs through `execDetached`, which is `docker exec -d` with the
 * host process's stdio discarded — so until now everything the app said went
 * nowhere. When it crashed, Paco had no way to tell the user *why*, only that
 * it had. Redirecting the launched command into a file under /tmp is the whole
 * fix: the log lives beside the pid file, outside the workspace, so it never
 * appears among the user's own changed files.
 *
 * Exit codes are still out of reach. The launch ends in `exec`, which replaces
 * the shell with the dev server so that the recorded pid *is* the server and
 * killing its process group kills the right thing. Nothing is left behind to
 * wait on it, and un-`exec`ing to capture a status would leave a shell that
 * outlives the crash — which the pid check would then read as "still running".
 * The last lines of output are what is available, and in practice they are the
 * more useful half anyway: a stack trace ends with the reason.
 */

/**
 * How much of the log to pull out of the container.
 *
 * Generous, because it is cheap and it is read at most a handful of times per
 * crash — the client trims again before showing anything.
 */
export const DEV_SERVER_LOG_TAIL_LINES = 20;
export const DEV_SERVER_LOG_MAX_CHARS = 2000;

/*
 * Escape sequences, written without a control character in the pattern source.
 *
 * Dev servers colour their output, and the raw bytes would reach the browser as
 * mojibake in the middle of the error the user is trying to read.
 */
const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const OSC_PATTERN = new RegExp(
  `${ESCAPE}\\][^${ESCAPE}\\u0007]*(?:\\u0007|${ESCAPE}\\\\)`,
  "g",
);

/**
 * Reduce raw captured output to something worth sending to the browser.
 *
 * Returns null rather than an empty string when there is nothing to show, so a
 * caller can leave the field off the response entirely instead of rendering an
 * empty "here is what it said" block.
 */
export function summarizeDevServerLog(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  const lines = raw
    .replaceAll(OSC_PATTERN, "")
    .replaceAll(ANSI_PATTERN, "")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return null;
  }

  const tail = lines.slice(-DEV_SERVER_LOG_TAIL_LINES).join("\n");

  // Keep the end: the last thing printed is the reason it stopped.
  return tail.length > DEV_SERVER_LOG_MAX_CHARS
    ? tail.slice(-DEV_SERVER_LOG_MAX_CHARS)
    : tail;
}
