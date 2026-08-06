import { db } from "./client";
import { sessions } from "./schema";

/**
 * Every session row, reduced to the fields that say which host resources it
 * owns.
 *
 * Deliberately not scoped to a user. This backs the orphan check, and the
 * question there is "does *any* row claim this container?" — a per-user view
 * would report another operator's live workspace as an orphan and offer it for
 * deletion. Only an administrator can reach the caller.
 */
export async function listSessionResourceRows(): Promise<
  {
    id: string;
    title: string;
    status: string;
    sandboxState: unknown;
  }[]
> {
  return db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      sandboxState: sessions.sandboxState,
    })
    .from(sessions);
}
