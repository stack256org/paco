import type { NextRequest } from "next/server";
import { findChatOwnerByPreviewSlug } from "@/lib/preview/authorize";
import {
  parsePreviewHostSlug,
  previewSlugFromHost,
} from "@/lib/preview/hostname";
import {
  createPreviewGrantToken,
  PREVIEW_GRANT_CONSUME_PATH,
} from "@/lib/preview/preview-grant";
import { getServerSession } from "@/lib/session/get-server-session";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * The half of the private-preview grant flow that runs on Paco's own
 * origin, where the real session cookie is sent.
 *
 * `/api/preview-auth` (Traefik's forward-auth target) redirects an
 * unauthenticated browser here with `host` naming the preview it tried to
 * open and `returnTo` naming where on that host it was headed. This handler
 * checks the signed-in user's session and chat ownership — the two things
 * that page could never check for itself — then redirects the browser back
 * to a special path on the preview host with a short-lived, host-bound
 * grant token attached. `route.ts`'s `consumeGrant` turns that token into a
 * cookie for the preview host once the browser arrives there.
 *
 * Every failure here is a plain, readable response rather than another
 * redirect: an operator or a confused owner reading this in their browser
 * is a better outcome than another hop that just denies again.
 */

/** Only a same-origin relative path is safe to redirect a browser to. */
function isSafeReturnPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

function respond(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const host = url.searchParams.get("host");
  const returnToRaw = url.searchParams.get("returnTo") ?? "/";
  const returnTo = isSafeReturnPath(returnToRaw) ? returnToRaw : "/";

  if (!host) {
    return respond(400, "Missing preview host.");
  }

  const settings = await readInstanceSettings();
  const label = previewSlugFromHost(host, settings.previewBaseDomain);
  if (!label) {
    return respond(400, "That isn't a preview hostname this instance knows.");
  }

  // A design-candidate host (`<chatSlug>-d<n>.<baseDomain>`) carries no
  // access rules of its own — `chats.previewSlug` is a generated column
  // that never carries the `-d<n>` suffix, so looking a candidate's raw
  // label up directly always misses. Stripping it down to the BASE chat's
  // slug first is what makes minting a grant for a candidate host possible
  // at all; the grant itself still binds to the full `host`, `-d<n>` and
  // all, unchanged below — see `createPreviewGrantToken`.
  const { chatSlug } = parsePreviewHostSlug(label);

  const session = await getServerSession();
  if (!session?.user) {
    return respond(
      401,
      "Sign in to Paco first, then open this preview link again.",
    );
  }

  const chat = await findChatOwnerByPreviewSlug(chatSlug);
  if (!chat) {
    return respond(404, "This preview no longer exists.");
  }

  const scheme = settings.tlsEnabled ? "https" : "http";

  // A chat that has since gone public needs no grant at all — the
  // forward-auth check already allows it unconditionally. Send the browser
  // straight back rather than minting a token that would go unused.
  if (chat.visibility === "public") {
    return Response.redirect(`${scheme}://${host}${returnTo}`, 302);
  }

  if (chat.ownerUserId !== session.user.id) {
    return respond(403, "This preview belongs to someone else.");
  }

  const { token } = createPreviewGrantToken(host);
  const consumeUrl = new URL(
    `${scheme}://${host}${PREVIEW_GRANT_CONSUME_PATH}`,
  );
  consumeUrl.searchParams.set("grant", token);
  consumeUrl.searchParams.set("returnTo", returnTo);

  return Response.redirect(consumeUrl.toString(), 302);
}
