import {
  SIGN_IN_ERROR_CALLBACK_PATH,
  SIGN_IN_ERROR_PARAM,
} from "@/lib/auth/sign-in-failure-copy";

/**
 * Turns a refused magic-link verification into a page instead of JSON.
 *
 * A magic link is opened by clicking it in an email, so the browser is
 * navigating: whatever comes back is rendered as the whole document. When
 * better-auth refuses the verification it answers with a JSON body and no
 * `Location`, and this version of the magic-link plugin has no
 * `errorCallbackURL` to point somewhere friendlier. The person who clicked
 * therefore saw `{"code":"SIGNUP_DISABLED","message":…}` on a blank page —
 * which is an improvement on the empty 500 it used to be, and still not an
 * answer.
 *
 * So a failed *navigation* is converted into a redirect carrying the code, and
 * the landing page turns that code into a sentence. Two conditions keep this
 * narrow:
 *
 * - only when the response is not already a redirect, so any route that
 *   handles its own error routing is left alone;
 * - only when the request looks like a navigation (`Accept: text/html`), so
 *   `authClient` calls and anything else expecting JSON keep getting JSON with
 *   its original status. Rewriting those would break the caller's error
 *   handling to fix the browser's.
 */
export async function redirectAuthErrorsToLandingPage(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.ok || response.status >= 500) {
    return response;
  }

  // Already going somewhere — that route has an opinion; do not overrule it.
  if (response.headers.has("location")) {
    return response;
  }

  const wantsHtml = request.headers.get("accept")?.includes("text/html");
  if (!wantsHtml) {
    return response;
  }

  const code = await readErrorCode(response);
  if (!code) {
    return response;
  }

  const target = new URL(SIGN_IN_ERROR_CALLBACK_PATH, request.url);
  target.searchParams.set(SIGN_IN_ERROR_PARAM, code);

  return Response.redirect(target, 303);
}

/**
 * The error code from a better-auth JSON body, if there is one.
 *
 * The response is cloned because the original is still the return value on
 * every path that decides not to redirect, and a body can only be read once.
 */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();

    if (body && typeof body === "object" && "code" in body) {
      const code = (body as { code?: unknown }).code;
      return typeof code === "string" && code.length > 0 ? code : null;
    }
  } catch {
    // Not JSON, or an empty body. Either way there is no code to forward and
    // the original response is the honest thing to return.
  }

  return null;
}
