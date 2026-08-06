import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chats, sessions } from "@/lib/db/schema";
import type { PreviewChatOwner } from "./decide-access";

/**
 * Map a preview hostname's leading label back to the chat it belongs to.
 *
 * An indexed point lookup, not a scan. `chats.previewSlug` (schema.ts) is a
 * Postgres `GENERATED ALWAYS` column carrying exactly what `previewSlug()`
 * (`lib/preview/hostname.ts`) would compute from `id`, backed by a unique
 * index — so this is `WHERE preview_slug = $1`, not "recompute the slug for
 * every chat and compare," which is the only way this stays cheap on a busy
 * instance: this lookup runs on every single preview request Traefik
 * forwards here.
 *
 * `null` when nothing matches — an unrecognized slug, not an error. The
 * label set on a sandbox container (`previewLabels`) and this lookup are
 * built from the same `previewSlug()`, so in normal operation every label
 * Traefik acts on has a matching row; a miss means the two have drifted, and
 * the caller must treat that exactly like "no such preview" (see
 * `decidePreviewAccess`).
 */
export async function findChatOwnerByPreviewSlug(
  slug: string,
): Promise<PreviewChatOwner | null> {
  const [row] = await db
    .select({
      chatId: chats.id,
      ownerUserId: sessions.userId,
      visibility: chats.previewVisibility,
    })
    .from(chats)
    .innerJoin(sessions, eq(sessions.id, chats.sessionId))
    .where(eq(chats.previewSlug, slug))
    .limit(1);

  return row ?? null;
}
