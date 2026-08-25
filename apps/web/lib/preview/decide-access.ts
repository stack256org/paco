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

/**
 * Whether a request may open a design candidate's preview.
 *
 * A thin, deliberately trivial wrapper over `decidePreviewAccess` — a
 * candidate is a throwaway branch of one chat, not a principal with
 * visibility of its own (there is no `visibility` column on a design
 * candidate anywhere in the schema, only on `chats`), so its preview must
 * open under exactly the rules its owning chat already has. This function
 * exists so that invariant is enforced by the type signature — the caller
 * hands it the same `PreviewChatOwner` it would resolve for the chat's own
 * preview, never anything candidate-specific — rather than by every future
 * caller remembering to resolve a candidate hostname back to its chat
 * before calling `decidePreviewAccess` directly.
 *
 * `hostname.ts`'s `parsePreviewHostSlug` is what strips a candidate host's
 * `-d<n>` suffix down to the `chatSlug` this function's `chat` argument is
 * looked up by; `candidateIndex` never reaches here at all, which is the
 * point — it has no bearing on whether the request is allowed.
 */
export function decideCandidatePreviewAccess(input: {
  chat: PreviewChatOwner | null;
  requesterUserId: string | undefined;
}): "allow" | "deny" {
  return decidePreviewAccess(input);
}
