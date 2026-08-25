/**
 * Server startup hooks.
 *
 * Two long-lived processes are started here because both poll Postgres and
 * cannot run on the edge runtime:
 *
 * - the Workflow SDK's world, which drives durable workflow runs
 * - the pg-boss workers, which deliver queued email, fire cron
 *   schedules (`lib/db/schema.ts`'s `schedules` table), and run the daily
 *   reflection job (`lib/memory/reflect.ts`) out of band
 *
 * A third thing is started here too: every enabled plugin's worker host
 * (`ensurePluginsStarted`, `lib/plugins/registry.ts`) — so a plugin with
 * `events:subscribe` is already registered with the session-event fan-out,
 * and one with `tools:register` is already running, by the time the first
 * request or turn needs it, rather than paying that startup cost inline on
 * whichever turn happens to ask first. `ensurePluginsStarted` never throws
 * (see its own doc comment), so a plugin failing to start here can never
 * take server boot down with it.
 *
 * And a fourth: the preview reconciliation sweep
 * (`lib/preview/reconcile-job.ts`), which keeps nginx's generated preview
 * routing in step with what is actually running and reclaims the ports and
 * worktrees design candidates leave behind. An in-process timer rather than a
 * pg-boss job, because everything it reconciles is state on THIS host — see
 * its own doc comment. Nothing here awaits it: it schedules itself and
 * swallows its own failures.
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

  const { startScheduleJob } = await import("@/lib/jobs/schedule-job");
  await startScheduleJob();

  const { startReflectionJob } = await import("@/lib/jobs/reflection-job");
  await startReflectionJob();

  const { ensurePluginsStarted } = await import("@/lib/plugins/registry");
  await ensurePluginsStarted();

  const { startPreviewReconciliation } =
    await import("@/lib/preview/reconcile-job");
  startPreviewReconciliation();
}
