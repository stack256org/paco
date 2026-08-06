/**
 * The windows the operator can pick between, and the trailing window the
 * spend report uses when nothing more specific has been asked for.
 *
 * Kept out of `lib/admin/health-actions.ts` on purpose: that file has
 * `"use server"` at the top, and Next.js only allows a `"use server"` file to
 * export async functions — a plain constant export breaks the build. This
 * lets the server action, its input validation, and the client's window
 * selector all share the same numbers without any of them re-declaring their
 * own copy that could drift from the others.
 */
export const SPEND_WINDOW_OPTIONS = [7, 30, 90] as const;

export const DEFAULT_SPEND_WINDOW_DAYS: (typeof SPEND_WINDOW_OPTIONS)[number] = 30;
