import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { isFirstRun } from "@/lib/auth/first-run";
import { tokenCaptureMetadata } from "@/lib/auth/first-run-token-capture";
import { isClaimOriginAllowed } from "@/lib/http/origin-policy";
import { renameOrganization } from "@/lib/org/organization";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * Whether this installation has any account at all.
 *
 * Deliberately unauthenticated: the sign-in page has to know which of two
 * shapes to render before anyone has signed in, and the answer leaks nothing —
 * "nobody has claimed this instance" is obvious to anyone who can reach it and
 * see an empty sign-in form.
 */
export async function GET(): Promise<Response> {
  return Response.json({ firstRun: await isFirstRun() });
}

const registerSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  /** "Optional" means a blank string is fine; `renameOrganization` no-ops on one. */
  organizationName: z.string().trim().max(200).optional(),
});

/**
 * Claim a fresh installation.
 *
 * This is the security-critical endpoint of the whole phase: it is
 * unauthenticated, and it creates the account that becomes this instance's
 * owner. Nothing upstream guards it — Next only applies its own origin check to
 * Server Actions, not to plain route handlers, and passing `headers:
 * request.headers` to `auth.api.*` below (without also passing `request`) means
 * better-auth's `validateOrigin`/`formCsrfMiddleware` never run either, since
 * both early-return when `ctx.request` is unset.
 *
 * What guards it is `isFirstRun()`, not the origin check. The origin check is
 * conditional on purpose (see `isClaimOriginAllowed`): an instance with no
 * configured domain accepts any origin, because it has not been told its own
 * address and is in no position to judge anyone else's. Two stricter versions
 * of this check each locked operators out of their own fresh installs — one
 * comparing against an `APP_URL` a piped install never sets, one comparing
 * against a `Host` that any edge proxy rewrites — while protecting nothing:
 * during the window this covers the instance is unclaimed, and anyone who can
 * reach it can claim it from curl regardless of what a browser would send.
 *
 * Once a domain *is* configured the operator has stated the instance's
 * identity, and a cross-site page posting here with `enctype="text/plain"`
 * (CORS-safelisted, so no preflight) is refused.
 *
 * The `isFirstRun()` check below happens inside this request, right before
 * anything is created — never inferred from an earlier call to `GET` above,
 * which a caller could replay long after the instance was claimed. better-auth's
 * own `assertSignUpAllowed` hook re-checks `isFirstRun()` during account
 * creation, but that is the *same* predicate evaluated a moment later, not a
 * second, independent gate: it is not committed to a `users` row, so two
 * requests racing each other can both pass it. That race is harmless because
 * the window where it matters is exactly the window where the instance is
 * unclaimed, and anyone who can reach this route at all could claim the
 * instance anyway — which is the same reason the origin check does not try to
 * carry the weight here.
 *
 * The account is created and signed in through better-auth's own magic-link
 * plugin rather than by writing rows directly, so the existing hooks
 * (`assertSignUpAllowed`, `promoteFirstUserToAdmin`,
 * `ensureOrganizationWithOwner`) and better-auth's session/cookie format all
 * stay exactly what they are for every other sign-in. The only difference
 * from a normal magic-link sign-in is that no email is sent: `metadata`
 * carries a capture function (see `first-run-token-capture.ts`) that
 * `lib/auth/config.ts`'s `sendMagicLink` recognises, so the token comes back
 * to this handler directly instead of being queued as mail — SMTP is not
 * configured yet on a fresh install, and the first person here should not
 * have to go read `docker logs` to reach their own instance.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const { appDomain } = await readInstanceSettings();
  if (!isClaimOriginAllowed(origin, appDomain)) {
    console.warn(
      `[first-run] rejected: Origin ${origin ?? "(none)"} is not the configured domain (${appDomain}). Change it under Settings → Admin → Domain, or clear it to accept any address.`,
    );
    return Response.json(
      {
        error: `This instance only accepts requests from ${appDomain}. You are on a different address — open that one, or change the domain under Settings → Admin.`,
      },
      { status: 403 },
    );
  }

  const parsed = registerSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "That doesn't look right." },
      { status: 400 },
    );
  }

  if (!(await isFirstRun())) {
    return Response.json(
      {
        error:
          "This instance already has an account. Ask an administrator for an invitation.",
      },
      { status: 409 },
    );
  }

  const { email, organizationName } = parsed.data;

  let capturedToken: string | null = null;
  await auth.api.signInMagicLink({
    body: {
      email,
      metadata: tokenCaptureMetadata((token) => {
        capturedToken = token;
      }),
    },
    headers: request.headers,
  });

  if (!capturedToken) {
    return Response.json(
      { error: "Could not start sign-in. Try again." },
      { status: 500 },
    );
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await auth.api.magicLinkVerify({
      asResponse: true,
      headers: request.headers,
      query: { token: capturedToken },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not create the account. Try again.",
      },
      { status: 500 },
    );
  }

  if (!verifyResponse.ok) {
    return verifyResponse;
  }

  if (organizationName) {
    await renameOrganization(organizationName);
  }

  // Carries forward whatever `magicLinkVerify` set — the session cookie,
  // chiefly — while replacing its body: that endpoint's own JSON shape
  // (`{ token, user, session }`) is better-auth's internal detail, not a
  // contract this route wants to expose.
  return new Response(JSON.stringify({ success: true }), {
    headers: verifyResponse.headers,
    status: 200,
  });
}
