import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chats } from "@/lib/db/schema";

export type PreviewVisibility = "private" | "public";

/**
 * A chat's preview visibility, read straight off the `chats` row.
 *
 * The column is `NOT NULL DEFAULT 'private'`, so every row has one — this
 * never falls back on a missing chat's behalf.
 */
export async function getPreviewVisibility(
  chatId: string,
): Promise<PreviewVisibility> {
  const [row] = await db
    .select({ previewVisibility: chats.previewVisibility })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);

  return row?.previewVisibility ?? "private";
}

export async function setPreviewVisibility(
  chatId: string,
  visibility: PreviewVisibility,
): Promise<void> {
  await db
    .update(chats)
    .set({ previewVisibility: visibility, updatedAt: new Date() })
    .where(eq(chats.id, chatId));
}
