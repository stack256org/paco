import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/config";
import { redirectAuthErrorsToLandingPage } from "../redirect-auth-errors";

const handler = toNextJsHandler(auth);

/*
 * GET is where magic links land, so a refusal here is read by a person in a
 * browser rather than by client code. It gets the wrapper; POST does not,
 * because those callers are `authClient` and want the JSON body and status.
 */
export async function GET(request: Request): Promise<Response> {
  const response = await handler.GET(request);
  return redirectAuthErrorsToLandingPage(request, response);
}

export const { POST } = handler;
