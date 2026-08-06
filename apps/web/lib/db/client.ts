import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { postgresUrl } from "./url";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

/**
 * How many Postgres connections this pool may hold.
 *
 * `postgres()` defaults to 10. That is generous for one pool and ruinous for
 * ten, which is what a long development session produces — see the global
 * cache below. Six is enough for the app's concurrency while leaving headroom
 * under a stock `max_connections` of 100 for pg-boss, the workflow world, and
 * a psql session to debug with.
 */
const MAX_CONNECTIONS = 6;

/** Return a connection to the pool after this long unused. */
const IDLE_TIMEOUT_SECONDS = 20;

/**
 * The pool is cached on `globalThis`, not in a module-level variable.
 *
 * A module-level cache is only as long-lived as the module instance, and in
 * development Turbopack builds a fresh module graph on edit. Each new instance
 * opened its own pool while the old one kept its connections, so an afternoon
 * of edits ended in `FATAL: sorry, too many clients already` — the server
 * could not reach its own database, and every page returned "Failed to get
 * session". Hanging the pool off the global keeps exactly one across reloads.
 */
const globalForDb = globalThis as typeof globalThis & {
  __pacoDb?: DrizzleClient;
};

function createClient(): DrizzleClient {
  const client = postgres(postgresUrl(), {
    max: MAX_CONNECTIONS,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
  });

  return drizzle(client, { schema });
}

export const db = new Proxy({} as DrizzleClient, {
  get(_, prop) {
    globalForDb.__pacoDb ??= createClient();
    return Reflect.get(globalForDb.__pacoDb, prop);
  },
});
