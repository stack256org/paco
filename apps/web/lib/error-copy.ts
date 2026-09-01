/**
 * The words a user reads when something fails.
 *
 * Shared rather than written per route so the same situation reads the same
 * way everywhere: a person who sees "This workspace is asleep" on the diff tab
 * and something else on the files tab has to work out whether those are the
 * same problem. Each line says what happened and what to do about it, and
 * nothing here names an HTTP status, an internal field, or a command.
 */

export const NOT_YOURS =
  "That request didn't match the chat or session it named. Reload the page and try again.";

export const SESSION_NOT_FOUND =
  "We couldn't find that session. It may have been deleted.";

export const CHAT_NOT_FOUND =
  "We couldn't find that chat. It may have been deleted.";

/** No workspace has been started for this session yet. */
export const WORKSPACE_NOT_STARTED =
  "Your workspace hasn't started yet. Start it, then try again.";

/** A workspace exists but has been paused to save resources. */
export const WORKSPACE_ASLEEP =
  "This workspace is asleep. Choose Resume to wake it, then reload.";

export const WORKSPACE_UNREACHABLE =
  "We couldn't reach your workspace. Reload the page — if that doesn't help, resume the workspace.";

/**
 * A request the browser sent that the server could not read at all.
 *
 * Nothing the user typed causes this, so the copy points at the one thing that
 * can help rather than pretending they made a mistake.
 */
export const BAD_REQUEST =
  "Something went wrong sending that request. Reload the page and try again.";

/**
 * A file the browser named that the server could not resolve.
 *
 * Almost always a file list the user is looking at that no longer matches the
 * workspace, so the copy points at the reload that fixes it rather than at the
 * path itself.
 */
export const BAD_FILE_SELECTION =
  "We couldn't tell which file you meant. Reload the page and try again.";

export const GITHUB_NOT_CONNECTED =
  "Connect your GitHub account in Settings, then try again.";

/**
 * The four ways a GitHub connection can be unusable, said apart.
 *
 * They used to collapse into one sentence — "Your GitHub connection needs to be
 * refreshed" — which is only true for one of them. Someone who had never
 * connected an account was told to refresh a connection they never had, and
 * "refresh" describes no action they could take.
 */
export const GITHUB_NEVER_CONNECTED =
  "Paco can save your work on this computer, but it needs a GitHub account to put it somewhere safe online.";

export const GITHUB_ACCESS_EXPIRED =
  "The access Paco saved for your GitHub account no longer covers everything it needs, so sending work to GitHub will fail. Connect the account again to fix it.";

export const GITHUB_TOKEN_UNREADABLE =
  "Paco can't unlock the GitHub access it saved for you, because this installation's secret key has changed since you connected. Nothing will reach GitHub until you connect the account again.";

export const GH_CLI_MISSING =
  "Paco talks to GitHub through GitHub's own command-line tool, and it isn't installed on this computer. Install it from cli.github.com, then restart Paco.";

/**
 * Fallback copy for a failed request that carried no message of its own.
 *
 * The alternative is `Response.statusText`, which is written for proxies, not
 * people: a user who lost their session reads "Unauthorized" and a user who
 * hit a crash reads "Internal Server Error", both rendered as body copy in the
 * middle of the page.
 */
export function httpErrorMessage(status: number): string {
  if (status === 403) {
    return NOT_YOURS;
  }
  if (status === 404) {
    return "We couldn't find that. It may have been deleted.";
  }
  if (status === 409) {
    return "Something else changed this while you were working. Reload and try again.";
  }
  if (status === 413) {
    return "That's too large to send. Try a smaller file.";
  }
  if (status === 429) {
    return "You're going a little fast. Wait a moment, then try again.";
  }
  if (status >= 500) {
    return "Something went wrong on our side. Try again in a moment.";
  }
  return "That didn't work. Try again.";
}
