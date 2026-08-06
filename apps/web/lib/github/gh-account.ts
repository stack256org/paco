import "server-only";

import { gh, GhError, ghJson } from "./gh";

/**
 * What a token turns out to be, once GitHub has been asked.
 *
 * Paco cannot tell a valid token from a revoked one, or a `repo`-scoped one
 * from a read-only one, by looking at it — every GitHub token is an opaque
 * string. So a token is verified when it is saved, and what comes back is
 * stored alongside it: the login is what the settings page shows, and the
 * scopes are what lets the UI say "this token cannot create repositories"
 * before the user tries and gets a confusing 403 later.
 */
export type GhAccount = {
  login: string;
  /** GitHub's numeric account id, used to build the commit address. */
  id: number | null;
  scopes: string[];
};

/** Scopes Paco needs for the things its buttons do. */
const REQUIRED_SCOPES = ["repo"] as const;

/**
 * Scopes that unlock optional behaviour.
 *
 * Absent ones are reported, not rejected: a token without `workflow` can still
 * create repositories and open pull requests, it just cannot push changes to
 * files under `.github/workflows`.
 */
const OPTIONAL_SCOPES = ["workflow", "read:org"] as const;

type GhUser = { login?: unknown; id?: unknown };

/**
 * Verify a token and report whose it is.
 *
 * The scopes come from GitHub's `x-oauth-scopes` response header rather than
 * any endpoint, because there is no API that reports a token's own scopes.
 * Fine-grained personal access tokens do not send that header at all, so an
 * empty list means "unknown", not "none" — which is why a missing scope is
 * surfaced as a warning rather than used to block the save.
 */
export async function inspectToken(token: string): Promise<GhAccount> {
  const user = await ghJson<GhUser>(["api", "user"], { token });

  if (typeof user.login !== "string" || user.login.length === 0) {
    throw new GhError(
      "GitHub did not return an account for this token",
      "failed",
      0,
      "",
    );
  }

  return {
    login: user.login,
    id: typeof user.id === "number" ? user.id : null,
    scopes: await readScopes(token),
  };
}

async function readScopes(token: string): Promise<string[]> {
  try {
    const { stdout } = await gh(["api", "user", "--include", "--silent"], {
      token,
    });

    const header = stdout
      .split("\n")
      .find((line) => line.toLowerCase().startsWith("x-oauth-scopes:"));

    if (!header) {
      // Fine-grained tokens omit the header entirely.
      return [];
    }

    return header
      .slice(header.indexOf(":") + 1)
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
  } catch {
    // The token already authenticated above; failing to read its scopes is not
    // a reason to reject it.
    return [];
  }
}

/**
 * Scopes Paco wants that this token does not advertise.
 *
 * Empty for a fine-grained token, which advertises nothing — see
 * {@link inspectToken}.
 */
export function missingScopes(scopes: string[]): string[] {
  if (scopes.length === 0) {
    return [];
  }

  return [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES].filter(
    (scope) => !scopes.includes(scope),
  );
}
