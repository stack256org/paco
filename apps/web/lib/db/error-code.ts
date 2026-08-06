/**
 * The Postgres SQLSTATE behind a thrown error, if there is one.
 *
 * `drizzle-orm` wraps the underlying `postgres` driver error one level down:
 * a `DrizzleQueryError` reports `error.code === undefined` at the top level
 * and carries the real SQLSTATE on `error.cause.code`. This file used to be
 * three separate, slightly different `(error as { code }).code === "..."`
 * checks — in `lib/db/migrate.ts`, `lib/health/migration-health.ts`, and
 * `lib/health/queue-health.ts` — and only the first one recursed into
 * `.cause`. The other two tested the wrapper's own `undefined` and never
 * fired against a live database, so a missing-table guard that was supposed
 * to read as "fresh database, nothing applied yet" instead let the raw error
 * propagate. Recursing into `.cause` here, once, is what makes the check
 * work against both the raw driver error and drizzle's wrapper around it.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const current = error as { code?: unknown; cause?: unknown };
  if (typeof current.code === "string") {
    return current.code;
  }

  return getErrorCode(current.cause);
}
