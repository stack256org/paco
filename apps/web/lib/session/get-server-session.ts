import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "@/lib/auth/config";
import type { Session } from "./types";
import { extractUsername } from "./extract-username";

export const getServerSession = cache(
  async (): Promise<Session | undefined> => {
    const baSession = await auth.api.getSession({
      headers: await headers(),
    });

    if (!baSession?.user) {
      return undefined;
    }

    return {
      created: baSession.session.createdAt.getTime(),
      user: {
        id: baSession.user.id,
        username: extractUsername(baSession.user),
        email: baSession.user.email ?? undefined,
        name: baSession.user.name ?? undefined,
      },
    };
  },
);
