import { getGithubToken } from "@/lib/db/github-tokens";
import { getSoleUserId } from "@/lib/db/users";
import { GhError, isGhMissing } from "@/lib/github/gh";
import { listOwners } from "@/lib/github/gh-repo";
import { GITHUB_NOT_CONNECTED } from "@/lib/error-copy";

/**
 * Accounts a new repository can be created under: the user, plus their orgs.
 *
 * The App version listed *installations*, which is a different question — it
 * answered "where has this app been installed", not "where can this person
 * create a repository". An org missing from that list meant installing the app
 * before anything could be done, which is the friction this migration removes.
 */
export async function GET() {
  const token = await getGithubToken(await getSoleUserId());
  if (!token) {
    return Response.json(
      { error: GITHUB_NOT_CONNECTED, owners: [] },
      { status: 400 },
    );
  }

  try {
    return Response.json({ owners: await listOwners(token) });
  } catch (error) {
    if (isGhMissing(error)) {
      return Response.json(
        { error: (error as Error).message, owners: [] },
        { status: 503 },
      );
    }
    if (error instanceof GhError) {
      return Response.json(
        { error: error.message, owners: [] },
        { status: 400 },
      );
    }

    console.error("Failed to list owners:", error);
    return Response.json(
      {
        error: "We couldn't load your GitHub accounts. Try again in a moment.",
        owners: [],
      },
      { status: 500 },
    );
  }
}
