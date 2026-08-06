/**
 * The one Postgres connection string.
 *
 * Everything that talks to Postgres uses it: Drizzle, pg-boss, and the Workflow
 * SDK's world. They previously read three separate variables
 * (`POSTGRES_URL`, `JOBS_POSTGRES_URL`, `WORKFLOW_POSTGRES_URL`), which is three
 * chances to point a subsystem at the wrong database — and the workflow one
 * failed especially badly, because the SDK's own default is a `world` database
 * that does not exist here, so durable runs silently went nowhere.
 *
 * Paco is one app with one database. If a deployment ever needs to split them,
 * that is a deliberate change here rather than a variable nobody set correctly.
 */
export function postgresUrl(): string {
  const url = process.env.POSTGRES_URL?.trim();

  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. It is the connection string for Paco's database — see apps/web/.env.example.",
    );
  }

  return url;
}
