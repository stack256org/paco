import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/admin/require-admin";
import { getGithubConnection } from "@/lib/db/github-tokens";
import { userExists } from "@/lib/db/users";
import { getSessionFromReq } from "@/lib/session/server";
import type { SessionUserInfo } from "@/lib/session/types";

const UNAUTHENTICATED: SessionUserInfo = { user: undefined };

export async function GET(req: NextRequest) {
  const session = await getSessionFromReq(req);

  if (!session?.user?.id) {
    return Response.json(UNAUTHENTICATED);
  }

  // run the user-existence check in parallel with the github queries
  // so there is zero added latency on the happy path.
  const [exists, connection, admin] = await Promise.all([
    userExists(session.user.id),
    getGithubConnection(session.user.id),
    isAdmin(session.user.id),
  ]);

  if (!exists) {
    return Response.json(UNAUTHENTICATED);
  }

  // One flag now, where there used to be three. An App could be linked to an
  // account but installed nowhere, or installed but with a stale OAuth link,
  // so the UI had to distinguish "linked", "installed", and "either". A token
  // is simply present or absent.
  const data: SessionUserInfo = {
    user: session.user,
    isAdmin: admin,
    hasGitHub: connection !== null,
    githubLogin: connection?.login ?? null,
  };

  return Response.json(data);
}
