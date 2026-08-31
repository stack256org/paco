import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteGithubToken,
  getGithubConnection,
  getGithubToken,
  saveGithubToken,
} from "@/lib/db/github-tokens";
import { getSoleUserId } from "@/lib/db/users";
import { GhError, isGhMissing } from "@/lib/github/gh";
import { inspectToken, missingScopes } from "@/lib/github/gh-account";
import { isGhInstalled } from "@/lib/github/gh-installed";

/**
 * The user's GitHub credential.
 *
 * GET reports whether one is stored and what it can do; PUT verifies and
 * stores a new one; DELETE removes it. The token itself is never in a
 * response — the only direction it travels is in.
 */

export type GithubConnectionResponse = {
  connected: boolean;
  login: string | null;
  scopes: string[];
  /** Scopes Paco wants that this token does not advertise. */
  missingScopes: string[];
  connectedAt: string | null;
  /**
   * True when the `gh` CLI itself is missing, which no token can fix.
   *
   * Reported by GET as well as by a failed PUT. It used to come back only from
   * PUT, whose body is discarded into a toast, so the settings page's banner
   * for it — the one screen that explains the situation — could never render,
   * and a self-hosted install without the CLI looked like an ordinary
   * disconnected account right up until every action failed.
   */
  cliMissing?: boolean;
  /**
   * True when a token is stored but cannot be decrypted.
   *
   * Tokens are sealed with a key derived from `APP_SECRET`, so changing that
   * value leaves every stored token unreadable. Only the sealed blob is
   * affected — the login and scopes beside it are plain columns and still read
   * back fine, which is what made this so quiet: the page said "GitHub
   * connected as someone" while every push, every PR and every repo listing
   * failed with "Connect your GitHub account", pointing at a page that
   * insisted the account was already connected.
   */
  tokenUnreadable?: boolean;
};

const connectSchema = z.object({
  token: z.string().trim().min(1, "Paste a GitHub token"),
});

function disconnected(): GithubConnectionResponse {
  return {
    connected: false,
    login: null,
    scopes: [],
    missingScopes: [],
    connectedAt: null,
    cliMissing: !isGhInstalled(),
  };
}

export async function GET() {
  const connection = await getGithubConnection();
  if (!connection) {
    return NextResponse.json(disconnected() satisfies GithubConnectionResponse);
  }

  // Unsealing is the only way to know the stored token is still usable, and it
  // is a local decrypt — no network, no GitHub call.
  const tokenUnreadable = (await getGithubToken()) === null;

  return NextResponse.json({
    connected: true,
    login: connection.login,
    scopes: connection.scopes,
    missingScopes: missingScopes(connection.scopes),
    connectedAt: connection.connectedAt.toISOString(),
    tokenUnreadable,
    cliMissing: !isGhInstalled(),
  } satisfies GithubConnectionResponse);
}

export async function PUT(request: Request) {
  const parsed = connectSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { token } = parsed.data;

  // Verified before it is stored, so a typo or an expired token is rejected
  // here rather than surfacing later as an inexplicable failure to push.
  let account: Awaited<ReturnType<typeof inspectToken>>;
  try {
    account = await inspectToken(token);
  } catch (error) {
    if (isGhMissing(error)) {
      return NextResponse.json(
        { error: (error as Error).message, cliMissing: true },
        { status: 503 },
      );
    }
    if (error instanceof GhError) {
      return NextResponse.json(
        { error: "GitHub rejected that token. Check it and try again." },
        { status: 400 },
      );
    }
    throw error;
  }

  await saveGithubToken({
    userId: await getSoleUserId(),
    token,
    login: account.login,
    githubUserId: account.id,
    scopes: account.scopes,
  });

  return NextResponse.json({
    connected: true,
    login: account.login,
    scopes: account.scopes,
    missingScopes: missingScopes(account.scopes),
    connectedAt: new Date().toISOString(),
  } satisfies GithubConnectionResponse);
}

export async function DELETE() {
  await deleteGithubToken();

  return NextResponse.json(disconnected() satisfies GithubConnectionResponse);
}
