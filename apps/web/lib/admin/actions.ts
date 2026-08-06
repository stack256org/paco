"use server";

import { db } from "@/lib/db/client";
import { githubTokens } from "@/lib/db/schema";
import { requireAdmin } from "./require-admin";

// ---------------------------------------------------------------------------
// GitHub revocation helpers
// ---------------------------------------------------------------------------

/**
 * Delete every stored GitHub credential.
 *
 * The App version also revoked each OAuth token at GitHub before deleting it,
 * because those tokens were minted by Paco and would otherwise have outlived
 * it. A personal access token belongs to the user — it is theirs to revoke on
 * GitHub, and revoking it here would destroy a credential they may be using
 * elsewhere. Deleting Paco's copy is the whole of what Paco should do.
 */
export async function revokeAllGitHubTokens(): Promise<{
  success: boolean;
  error?: string;
  deletedConnections?: number;
}> {
  try {
    await requireAdmin();

    const deleted = await db
      .delete(githubTokens)
      .returning({ userId: githubTokens.userId });

    return { success: true, deletedConnections: deleted.length };
  } catch (error) {
    console.error("Failed to delete GitHub connections:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "We couldn't remove those GitHub connections. Try again.",
    };
  }
}
