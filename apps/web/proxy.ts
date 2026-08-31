import { type NextRequest, NextResponse } from "next/server";

/**
 * Next's middleware entry point (renamed `proxy` in Next 16).
 *
 * Deliberately inert. It previously rewrote `/shared/:id` to a markdown
 * route for public share links; public sharing is gone, and the route it
 * rewrote to never existed in the first place. The file remains because
 * Next resolves it by convention and a future rewrite belongs here.
 *
 * `matcher: []` means this never runs — cheaper than matching every request
 * to do nothing.
 */
export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
