/**
 * Server startup hooks.
 *
 * Two long-lived processes are started here because both poll Postgres and
 * cannot run on the edge runtime:
 *
 * - the Workflow SDK's world, which drives durable workflow runs
 * - the pg-boss workers, which deliver queued email out of band
 *
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { createWorld } = await import("@workflow/world-postgres");
  const { setWorld, getWorld } = await import("workflow/runtime");

  // Built explicitly rather than left to the SDK's own environment lookup,
  // which reads WORKFLOW_POSTGRES_URL and falls back to a `world` database
  // nobody here has. Paco has one database, so the workflow runtime, pg-boss
  // and Drizzle all take the same POSTGRES_URL and there is no second URL to
  // keep in step. Must run before any getWorld(), which this does: Next calls
  // register() before it serves a request.
  const { postgresUrl } = await import("@/lib/db/url");
  setWorld(createWorld({ connectionString: postgresUrl() }));
  await getWorld().start?.();

  const { startWorkers } = await import("@/lib/jobs/workers");
  await startWorkers();
}
