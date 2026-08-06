"use server";

import { getChatById, getSessionById } from "@/lib/db/sessions";
import {
  CHAT_NOT_FOUND,
  NOT_YOURS,
  SESSION_NOT_FOUND,
  SIGNED_OUT,
} from "@/lib/error-copy";
import { previewHostname } from "@/lib/preview/hostname";
import {
  setPreviewVisibility,
  type PreviewVisibility,
} from "@/lib/preview/visibility";
import { getServerSession } from "@/lib/session/get-server-session";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * The share control's authorization boundary.
 *
 * A chat has no `userId` of its own — ownership is the session it belongs
 * to — so this walks chat -> session -> the signed-in user, the same chain
 * `discardChanges` (`lib/git/actions/discard.ts`) uses for the same reason.
 * Every caller in this file goes through here first; nothing below reads or
 * writes a chat's preview visibility without it.
 */
async function requireChatOwnership(chatId: string) {
  const session = await getServerSession();
  if (!session?.user) {
    throw new Error(SIGNED_OUT);
  }

  const chat = await getChatById(chatId);
  if (!chat) {
    throw new Error(CHAT_NOT_FOUND);
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (sessionRecord.userId !== session.user.id) {
    throw new Error(NOT_YOURS);
  }

  return chat;
}

function isPreviewVisibility(value: unknown): value is PreviewVisibility {
  return value === "private" || value === "public";
}

export type PreviewShareState = {
  /** The full hostname this chat's preview would be reachable at, or `null`
   * when no preview base domain is configured — there is then nowhere to
   * route it and nothing to show a URL for. */
  hostname: string | null;
  /** Whether previews are served over TLS, so the control can pick a scheme. */
  tlsEnabled: boolean;
  visibility: PreviewVisibility;
};

/**
 * Everything the Preview tab's share control needs, for one chat.
 *
 * `chat.previewVisibility` comes straight off the row `getChatById` already
 * fetched for the ownership check, so this never issues the extra query
 * `getPreviewVisibility` would — the row read for authorization *is* the
 * data the control renders.
 */
export async function getPreviewShareState(
  chatId: string,
): Promise<PreviewShareState> {
  const chat = await requireChatOwnership(chatId);
  const settings = await readInstanceSettings();

  return {
    hostname: previewHostname(chat.id, settings.previewBaseDomain),
    tlsEnabled: settings.tlsEnabled,
    visibility: chat.previewVisibility,
  };
}

/**
 * Change who may open a chat's preview.
 *
 * The authorization check is the entire point of this function existing
 * separately from `setPreviewVisibility` (`lib/preview/visibility.ts`):
 * that function trusts its caller completely, so a server action wrapping
 * it without `requireChatOwnership` first would let anyone who can guess a
 * chat id flip a stranger's preview public.
 */
export async function updatePreviewVisibility(
  chatId: string,
  visibility: PreviewVisibility,
): Promise<{ success: boolean; error?: string }> {
  const chat = await requireChatOwnership(chatId);

  if (!isPreviewVisibility(visibility)) {
    return { success: false, error: "That isn't a visibility Paco knows." };
  }

  await setPreviewVisibility(chat.id, visibility);
  return { success: true };
}
