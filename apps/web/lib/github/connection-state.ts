/**
 * What is wrong with a user's GitHub connection, as one value.
 *
 * This was two overlapping booleans — `connected` and a `reconnectRequired`
 * computed as `!connected` — evaluated in an order that made the second win.
 * A user who had never connected GitHub was told their connection "needs to be
 * refreshed", and the branch that would have explained the real situation was
 * unreachable. Two booleans describe four combinations, of which only three
 * exist, and nothing stopped the impossible one being rendered.
 *
 * One value, one message, checked in the order in which the causes actually
 * block each other: a missing CLI cannot be fixed by connecting, and an
 * unreadable token cannot be fixed by adding scopes.
 */

import {
  GH_CLI_MISSING,
  GITHUB_ACCESS_EXPIRED,
  GITHUB_NEVER_CONNECTED,
  GITHUB_TOKEN_UNREADABLE,
} from "@/lib/error-copy";

export type GithubConnectionState =
  /** The answer has not arrived yet. Say nothing rather than guess. */
  | "checking"
  /** A token is stored, readable, and carries every scope Paco needs. */
  | "connected"
  /** No token has ever been stored for this user. */
  | "not-connected"
  /** A token is stored but no longer does what Paco needs it to do. */
  | "reconnect-required"
  /** A token is stored but cannot be decrypted — `APP_SECRET` changed. */
  | "token-unreadable"
  /** GitHub's CLI is absent, which no token can fix. */
  | "cli-missing";

/**
 * The parts of `GET /api/github/connection` this derivation reads.
 *
 * Declared structurally rather than imported from the route so the derivation
 * — the part that was wrong, and so the part worth testing — carries no
 * dependency on a server module.
 */
export type GithubConnectionFacts = {
  connected: boolean;
  missingScopes: string[];
  cliMissing?: boolean;
  tokenUnreadable?: boolean;
};

export function githubConnectionState(
  facts: GithubConnectionFacts | undefined,
): GithubConnectionState {
  // `undefined` covers both "still loading" and "the request failed". Neither
  // is evidence about the account, and the old code read both as "not
  // connected" and told people to reconnect on first paint.
  if (!facts) {
    return "checking";
  }
  if (facts.cliMissing === true) {
    return "cli-missing";
  }
  if (!facts.connected) {
    return "not-connected";
  }
  if (facts.tokenUnreadable === true) {
    return "token-unreadable";
  }
  if (facts.missingScopes.length > 0) {
    return "reconnect-required";
  }
  return "connected";
}

export type GithubConnectionAdvice = {
  /** Which alert colour carries the message. Never the only signal. */
  tone: "warning" | "error";
  /** The cause, in words that name no field, status code, or command. */
  message: string;
  /** The one thing that fixes it, or `null` when no link can. */
  action: { label: string; href: string } | null;
};

const CONNECTIONS_HREF = "/settings/connections";

/** The message and next action for a state, or `null` when there is nothing to say. */
export function githubConnectionAdvice(
  state: GithubConnectionState,
): GithubConnectionAdvice | null {
  switch (state) {
    case "checking":
    case "connected":
      return null;
    case "not-connected":
      return {
        tone: "warning",
        message: GITHUB_NEVER_CONNECTED,
        action: { label: "Connect GitHub", href: CONNECTIONS_HREF },
      };
    case "reconnect-required":
      return {
        tone: "warning",
        message: GITHUB_ACCESS_EXPIRED,
        action: { label: "Reconnect GitHub", href: CONNECTIONS_HREF },
      };
    case "token-unreadable":
      return {
        tone: "error",
        message: GITHUB_TOKEN_UNREADABLE,
        action: { label: "Connect again", href: CONNECTIONS_HREF },
      };
    case "cli-missing":
      // Deliberately no link: the fix is on the machine, not in Settings, and
      // sending someone to a page that cannot help is how the old copy failed.
      return { tone: "error", message: GH_CLI_MISSING, action: null };
    default:
      return null;
  }
}
