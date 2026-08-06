import { z } from "zod";

/**
 * What a client is allowed to change about a session.
 *
 * The handler used to *cast* the request body — `(await req.json()) as
 * UpdateSessionRequest` — and spread it into `updateSession`, which sets every
 * key that names a real column. A cast checks nothing at runtime, so the body
 * was whatever the caller wrote:
 *
 * - `PATCH {"userId": "<someone else>"}` handed the session to another account;
 * - `PATCH {"sandboxState": {"type":"docker","sandboxName":"session_<victim>"}}`
 *   pointed it at another user's workspace, after which `/files`, `/diff` and
 *   `/files/content` happily read that workspace — every one of those guards
 *   checks only that you own *your* row, and you still did.
 *
 * So this is an allow-list, and `strictObject` rejects anything not on it
 * rather than dropping it silently: a client sending a field this endpoint does
 * not support has a bug worth hearing about, and an attacker gets a 400 instead
 * of a partial success.
 *
 * The only fields any caller sends are `title` (rename) and `status` (archive
 * and unarchive) — see `hooks/use-sessions.ts` and the chat context. Everything
 * else about a session is derived server-side and has no business arriving in a
 * request body.
 */
export const updateSessionRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["running", "completed", "failed", "archived"]).optional(),
});

export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
