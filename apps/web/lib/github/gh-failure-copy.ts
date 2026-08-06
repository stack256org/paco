/**
 * Turn a `gh`/`git` failure into something a person can act on.
 *
 * `gh` writes for a terminal: `GraphQL: Resource not accessible by integration
 * (createPullRequest)` is a fine thing to read next to the command you just
 * typed, and a dead end in a toast. Everything here maps the handful of causes
 * that actually happen to a sentence about the user's situation. The raw text
 * still travels on the error for the log — it just does not reach the UI.
 *
 * Every message says the cause and then one action that can actually work. A
 * sentence that sends the user somewhere with no fix ("check your GitHub
 * connection") is worse than useless when the connection is fine.
 */

type GhFailureInput = {
  command: "gh" | "git";
  stderr: string;
  exitCode: number | null;
};

export const NO_WRITE_ACCESS =
  "Your GitHub account can't write to this repository. Ask the repository owner for write access, or reconnect GitHub in Settings with an account that has it.";

export const AUTH_EXPIRED =
  "GitHub no longer accepts your saved access. Reconnect GitHub in Settings, then try again.";

export const NOT_FOUND =
  "GitHub couldn't find that repository or branch. It may have been renamed or deleted, or your account may not be able to see it.";

export const NETWORK =
  "We couldn't reach GitHub. Check your internet connection, then try again.";

export const ALREADY_EXISTS =
  "That already exists on GitHub. Refresh the page to see the current state.";

export const PULL_REQUEST_EXISTS =
  "There's already a pull request open for these changes. Open it from the Changes panel instead of creating another.";

export const REPO_NAME_TAKEN =
  "You already have a repository with that name on GitHub. Pick a different name and try again.";

export const NOTHING_TO_PUBLISH =
  "There's nothing new to put in a pull request — this branch matches the main branch. Make a change and save it first.";

export const RATE_LIMITED =
  "GitHub is temporarily limiting how often Paco can talk to it. Wait a few minutes, then try again — nothing has been lost.";

export const ARCHIVED_REPO =
  "This repository is archived on GitHub, so nothing can be pushed to it. Unarchive it in the repository's settings on GitHub, or connect a different repository.";

export const SSO_REQUIRED =
  "Your organization on GitHub requires single sign-on, and this access token hasn't been approved for it yet. Open your token's settings on GitHub, authorize it for the organization, then try again.";

export const REJECTED_PUSH =
  "GitHub has newer changes on this branch than you do. Pull them in, then try again.";

export const GENERIC =
  "GitHub wouldn't complete that. Try again — if it keeps failing, check your GitHub connection in Settings.";

/**
 * Ordered, and the order is the whole design: `gh` reports several causes at
 * once and the first match wins, so a broad pattern placed early swallows the
 * specific one that would have told the user what to do.
 *
 * The rule for anyone editing this list: **every specific reading of a status
 * code goes above the generic reading of that status code.**
 *
 * GitHub answers with 403 for at least four unrelated things — a rate limit, an
 * archived repository, an unapproved single-sign-on token, and genuinely
 * missing write access. Only the last one is fixed by asking for permissions,
 * so the other three are matched first. Moving the write-access matcher above
 * them would tell someone whose token is fine to disconnect it and go beg the
 * repository owner for access, for a rate limit that clears itself in minutes.
 * That regression has happened once; don't reintroduce it.
 *
 * Network trouble stays at the top because a failed connection can echo any
 * wording at all, and "name already exists on this account" stays above the
 * general "already exists" for the same first-match reason.
 */
const MATCHERS: ReadonlyArray<{ test: RegExp; message: string }> = [
  {
    test: /could not resolve host|network is unreachable|connection (refused|reset|timed out)|operation timed out|temporary failure in name resolution|tls handshake/,
    message: NETWORK,
  },
  // --- The 403 family. These three run before the write-access matcher. ---
  {
    test: /rate limit|too many requests|abuse detection mechanism|http 429/,
    message: RATE_LIMITED,
  },
  {
    test: /repository was archived|repository is archived|archived so it is read-only/,
    message: ARCHIVED_REPO,
  },
  {
    // Narrow on purpose: a bare `saml` would also match a repository called
    // `acme/saml-service` in a "not found" message.
    test: /saml (enforcement|sso)|enforced saml|single sign-?on|grant your personal access token access to this organization/,
    message: SSO_REQUIRED,
  },
  {
    // `http 403` is what `gh` prints; `returned error: 403` is what git's HTTPS
    // transport prints for the identical condition.
    test: /permission to .* denied|write access|must have admin rights|resource not accessible|not authorized|forbidden|http 403|returned error: 403/,
    message: NO_WRITE_ACCESS,
  },
  // --- End of the 403 family. ---
  {
    test: /bad credentials|authentication failed|could not read username|requires authentication|token has expired|gh auth login|http 401/,
    message: AUTH_EXPIRED,
  },
  {
    test: /no commits between/,
    message: NOTHING_TO_PUBLISH,
  },
  {
    test: /name already exists on this account/,
    message: REPO_NAME_TAKEN,
  },
  {
    test: /a pull request (already exists|for branch)/,
    message: PULL_REQUEST_EXISTS,
  },
  {
    test: /already exists|reference already exists/,
    message: ALREADY_EXISTS,
  },
  {
    test: /\[rejected\]|non-fast-forward|fetch first|updates were rejected/,
    message: REJECTED_PUSH,
  },
  {
    test: /could not resolve to a|not found|no such remote|does not appear to be a git repository|couldn't find any pages|http 404/,
    message: NOT_FOUND,
  },
];

/** What the user reads. Never contains raw output, a command, or an exit code. */
export function ghFailureMessage(params: GhFailureInput): string {
  const haystack = params.stderr.toLowerCase();

  for (const matcher of MATCHERS) {
    if (matcher.test.test(haystack)) {
      return matcher.message;
    }
  }

  return GENERIC;
}

/** Copy for a call that ran out of time rather than failing outright. */
export const GH_TIMEOUT_MESSAGE =
  "GitHub took too long to answer, so we stopped waiting. Try again in a moment.";

/** Copy for output that was supposed to be structured and was not. */
export const GH_UNREADABLE_MESSAGE =
  "GitHub sent back something we couldn't read. Try again in a moment.";

/**
 * What the log gets: the command, its exit code and `gh`'s own first line.
 *
 * Kept as one string so it can ride along on the error as `cause` — the
 * message above is deliberately too vague to debug from.
 */
export function ghFailureDetail(
  params: GhFailureInput & { args: string[] },
): string {
  const firstLine = params.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("Usage:"));

  const reason = firstLine ?? `exited with code ${params.exitCode}`;
  return `${params.command} ${params.args[0] ?? ""}: ${reason.slice(0, 300)}`;
}
