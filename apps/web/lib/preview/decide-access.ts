import type { PreviewVisibility } from "./visibility";

export type PreviewChatOwner = {
  chatId: string;
  ownerUserId: string;
  visibility: PreviewVisibility;
};

/**
 * Whether a request may open a chat's preview.
 *
 * Pure and total on purpose — no database, no `server-only` — which is what
 * makes it exhaustively testable: every case (no matching chat, public,
 * private with no session, private with the wrong session, private with the
 * owner's session) reduces to exactly one of two return values. That
 * reduction is deliberate, not an oversight. "No such preview", "private,
 * sign in", and "private, not yours" are each true, individually, but
 * returning them as distinguishable outcomes would hand an unauthenticated
 * caller a way to enumerate which preview slugs exist by probing hostnames.
 * `"deny"` is the one answer to "I do not know whose preview this is" and to
 * "I know whose it is, and it isn't yours."
 */
export function decidePreviewAccess(input: {
  chat: PreviewChatOwner | null;
  requesterUserId: string | undefined;
}): "allow" | "deny" {
  const { chat, requesterUserId } = input;

  if (!chat) {
    return "deny";
  }

  if (chat.visibility === "public") {
    return "allow";
  }

  return chat.ownerUserId === requesterUserId ? "allow" : "deny";
}
