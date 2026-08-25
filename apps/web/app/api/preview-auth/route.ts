import type { NextRequest } from "next/server";
import { appUrl } from "@/lib/app-url";
import { findChatOwnerByPreviewSlug } from "@/lib/preview/authorize";
import {
  decideCandidatePreviewAccess,
  decidePreviewAccess,
} from "@/lib/preview/decide-access";
import {
  parsePreviewHostSlug,
  previewSlugFromHost,
} from "@/lib/preview/hostname";
import {
  PREVIEW_GRANT_CONSUME_PATH,
  PREVIEW_GRANT_COOKIE_NAME,
  PREVIEW_GRANT_ENDPOINT_PATH,
  PREVIEW_GRANT_MAX_AGE_SECONDS,
  verifyPreviewGrantToken,
} from "@/lib/preview/preview-grant";
import { getSessionFromReq } from "@/lib/session/server";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * nginx's `auth_request` target for a preview's server block.
 *
 * `previewServerBlock` (`lib/preview/nginx-config.ts`) points every
 * generated preview's `auth_request` at this endpoint over the loopback
 * (`127.0.0.1:<appPort>`, never the public origin), which is what makes
 * `X-Forwarded-Host` below trustworthy: the subrequest never leaves this
 * host, and nginx set the header itself from the connection it actually
 * received, rather than relaying whatever the client claimed. nginx's
 * `auth_request` module only understands three outcomes from this handler —
 * 2xx lets the request through, 401/403 deny it — so a denial's body is
 * always empty. See `decidePreviewAccess` for why "no such preview" and
 * "private, not yours" deliberately produce the identical response.
 *
 * One thing that mechanism swap did not carry over cleanly: this handler's
 * 302 responses (`redirectToGrant`, `consumeGrant`, below) are outside what
 * `auth_request` relays — nginx maps any subrequest status other than
 * 2xx/401/403 to a 500 of its own, dropping the response's `Location` (and,
 * for `consumeGrant`, `Set-Cookie`) entirely. See the task-345 report's
 * concerns for what that means for the redirect-to-grant flow.
 */
function deny(): Response {
  return new Response(null, { status: 401 });
}

function allow(): Response {
  return new Response(null, { status: 200 });
}

function hostWithoutPort(forwardedHost: string | null): string | null {
  const host = forwardedHost?.split(":")[0]?.trim();
  return host || null;
}

/**
 * Split Traefik's `X-Forwarded-Uri` (path + query of the *original* request)
 * into the two parts this handler needs separately.
 */
function parseForwardedUri(uri: string): { path: string; query: string } {
  try {
    const url = new URL(uri, "http://internal.invalid");
    return { path: url.pathname, query: url.search.slice(1) };
  } catch {
    return { path: "/", query: "" };
  }
}

/** Refuses anything that isn't a same-origin relative path — the one shape
 * safe to redirect a browser to without risking an open redirect. */
function isSafeReturnPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/**
 * Send the browser to Paco's own origin to prove ownership.
 *
 * This is the step that makes a private preview openable at all: the
 * browser is on the preview's own host right now, which never carries
 * Paco's session cookie (host-only, by design — see AGENTS.md). Paco's own
 * origin is where that cookie *is* sent. `host` and the original request's
 * full path travel along as query parameters so `/grant` can hand the
 * browser back to exactly where it was.
 */
function redirectToGrant(host: string, forwardedUri: string): Response {
  const target = new URL(PREVIEW_GRANT_ENDPOINT_PATH, appUrl().origin);
  target.searchParams.set("host", host);
  target.searchParams.set("returnTo", forwardedUri);
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString() },
  });
}

/**
 * Consume a one-trip grant token and hand the browser a cookie for it.
 *
 * Reached at `PREVIEW_GRANT_CONSUME_PATH` on the *preview* host itself,
 * after `/grant` (on Paco's own origin) has already checked session and
 * ownership and minted the token. This is the only place that token can
 * become a cookie: this response is relayed back to the browser as Traefik
 * relays every non-2xx forward-auth response — Location *and* Set-Cookie
 * included — and to the browser it looks exactly like a response from the
 * preview host it asked for, which is the only host a `Set-Cookie` header
 * from this response could legally be scoped to in the first place.
 */
function consumeGrant(params: {
  host: string;
  query: string;
  tlsEnabled: boolean;
}): Response {
  const search = new URLSearchParams(params.query);
  const grant = search.get("grant");
  const returnToRaw = search.get("returnTo") ?? "/";
  const returnTo = isSafeReturnPath(returnToRaw) ? returnToRaw : "/";

  if (!grant || !verifyPreviewGrantToken(grant, params.host)) {
    return deny();
  }

  const scheme = params.tlsEnabled ? "https" : "http";
  const location = `${scheme}://${params.host}${returnTo}`;
  const cookie = [
    `${PREVIEW_GRANT_COOKIE_NAME}=${grant}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PREVIEW_GRANT_MAX_AGE_SECONDS}`,
    ...(params.tlsEnabled ? ["Secure"] : []),
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": cookie },
  });
}

export async function GET(req: NextRequest) {
  const forwardedHost = hostWithoutPort(req.headers.get("x-forwarded-host"));
  if (!forwardedHost) {
    return deny();
  }

  const settings = await readInstanceSettings();
  const label = previewSlugFromHost(forwardedHost, settings.previewBaseDomain);
  if (!label) {
    return deny();
  }

  // A design-candidate host (`<chatSlug>-d<n>.<baseDomain>`) carries no
  // access rules of its own — see `parsePreviewHostSlug`'s doc comment —
  // so the chat lookup below always targets the BASE chat's slug, never
  // the candidate label itself. `candidateIndex` only ever picks which
  // `decidePreviewAccess`-flavored function makes the actual call, below.
  const { chatSlug, candidateIndex } = parsePreviewHostSlug(label);

  const forwardedUri = req.headers.get("x-forwarded-uri") ?? "/";
  const { path, query } = parseForwardedUri(forwardedUri);

  if (path === PREVIEW_GRANT_CONSUME_PATH) {
    return consumeGrant({
      host: forwardedHost,
      query,
      tlsEnabled: settings.tlsEnabled,
    });
  }

  let chat: Awaited<ReturnType<typeof findChatOwnerByPreviewSlug>>;
  try {
    chat = await findChatOwnerByPreviewSlug(chatSlug);
  } catch {
    // The auth check itself failing must fail closed, not leak a stack
    // trace to an unauthenticated caller or — worse — let a thrown error
    // read to Traefik as anything but a denial.
    return deny();
  }

  if (!chat) {
    return deny();
  }

  if (chat.visibility === "public") {
    return allow();
  }

  // A preview-scoped grant, bound to this exact host, stands in for the
  // session cookie the browser cannot carry here. Checked before the real
  // session so a grant survives even if the owner's Paco session itself
  // expires in the meantime.
  const grantCookie = req.cookies.get(PREVIEW_GRANT_COOKIE_NAME)?.value;
  if (verifyPreviewGrantToken(grantCookie, forwardedHost)) {
    return allow();
  }

  const session = await getSessionFromReq(req);
  const decideAccess =
    candidateIndex === null
      ? decidePreviewAccess
      : decideCandidatePreviewAccess;
  const decision = decideAccess({
    chat,
    requesterUserId: session?.user?.id,
  });
  if (decision === "allow") {
    return allow();
  }

  // A session that exists but belongs to someone else is a question this
  // handler can already answer: deny, the same flat way as an unknown host,
  // so probing cannot distinguish the two (see `decidePreviewAccess`).
  if (session) {
    return deny();
  }

  // No session at all is the common case for this preview's own owner —
  // Better Auth's cookie never reaches this hostname. Give them the one
  // path that can still authorize them, rather than a bare 401.
  return redirectToGrant(forwardedHost, forwardedUri);
}
