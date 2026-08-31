import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getErrorCode } from "./error-code.ts";
import { computeMigrationClamps } from "./migration-clamp.ts";

/**
 * Load `.env` when run outside Next.js.
 *
 * `next build` injects the file automatically, but this script also runs on its
 * own (`pnpm db:migrate:apply`), where nothing has populated process.env yet.
 */
function loadEnvFile(): void {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) {
      continue;
    }
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      if (key && process.env[key] === undefined) {
        process.env[key] = (rawValue ?? "").trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

loadEnvFile();

/**
 * Resolved from this file, not the working directory.
 *
 * `pnpm build` runs it from `apps/web`, so a relative path worked there and
 * nowhere else — the production image invokes it from the repository root and
 * got "Can't find meta/_journal.json", which reads like missing files rather
 * than a wrong starting point.
 */
const MIGRATIONS_FOLDER = join(import.meta.dirname, "migrations");
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

const LEGACY_IGNORABLE_ERROR_CODES = new Set([
  "42P01", // undefined_table
  "42P06", // duplicate_schema
  "42P07", // duplicate_table / duplicate_relation
  "42701", // duplicate_column
  "42703", // undefined_column
  "42710", // duplicate_object
]);

type MigrationFile = {
  sql: string[];
  bps: boolean;
  folderMillis: number;
  hash: string;
};

type ErrorWithCause = {
  code?: string;
  message?: string;
  cause?: unknown;
};

const url = process.env.POSTGRES_URL;
if (!url) {
  /*
   * Loud, and a failure.
   *
   * This used to print "skipping" and exit 0, so a misplaced .env produced a
   * migration step that reported success and an app that failed later at
   * sign-in, with nothing connecting the two. A setup step that cannot do its
   * job has not succeeded.
   */
  console.error(
    "POSTGRES_URL is not set, so there is no database to migrate.\n" +
      "Copy apps/web/.env.example to apps/web/.env and set POSTGRES_URL to your\n" +
      "Postgres connection string, then run this again.",
  );
  process.exit(1);
}

// The durable workflow runtime keeps its own tables and reads its own variable
// to find them. Paco has one database, so point it at ours rather than asking
// an operator to set a second URL that must match the first — and overwrite
// rather than default, so a stale value left in an environment cannot send the
// workflow tables to a different database than the one the app reads.
process.env.WORKFLOW_POSTGRES_URL = url;

const client = postgres(url, { max: 1 });
const db = drizzle(client);

function getErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  const current = error as ErrorWithCause;
  if (typeof current.message === "string") {
    return current.message;
  }

  if (current.cause) {
    return getErrorMessage(current.cause);
  }

  return "Unknown database error";
}

function isIgnorableLegacyError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code ? LEGACY_IGNORABLE_ERROR_CODES.has(code) : false;
}

async function ensureMigrationsTable(): Promise<void> {
  await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

/**
 * Correct any migration record whose `created_at` outruns the current
 * journal, so it can no longer make a later, real migration look already
 * applied. See `migration-clamp.ts` for the bug this closes and why the
 * fix has to touch the database, not just the journal file.
 *
 * A no-op on a healthy ledger — the common case, every run. Tolerates the
 * table not existing (a fresh database, before `ensureMigrationsTable` has
 * run) by returning quietly rather than throwing, and swallows a missing or
 * unreadable journal the same way: either means there is nothing yet to
 * compare records against.
 */
async function clampFutureDatedMigrationRecords(): Promise<void> {
  let journal: Array<{ hash: string; when: number }>;
  try {
    const migrations = readMigrationFiles({
      migrationsFolder: MIGRATIONS_FOLDER,
    }) as MigrationFile[];
    journal = migrations.map((migration) => ({
      hash: migration.hash,
      when: migration.folderMillis,
    }));
  } catch {
    return;
  }

  let rows: Array<{
    id: number;
    hash: string;
    created_at: string | number | null;
  }>;
  try {
    rows = (await client.unsafe(`
      SELECT id, hash, created_at
      FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
    `)) as Array<{
      id: number;
      hash: string;
      created_at: string | number | null;
    }>;
  } catch (error) {
    if (isIgnorableLegacyError(error)) {
      return;
    }
    throw error;
  }

  const clamps = computeMigrationClamps(
    rows.map((row) => ({
      id: row.id,
      hash: row.hash,
      createdAt: row.created_at === null ? null : Number(row.created_at),
    })),
    journal,
  );

  for (const clamp of clamps) {
    console.log(
      `Migration ${clamp.hash} was recorded at ${clamp.from}, later than every entry in the current journal — correcting it to ${clamp.to} (see 7bd724c) so later migrations are not silently skipped.`,
    );
    await client.unsafe(
      `UPDATE "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" SET created_at = $1 WHERE id = $2`,
      [clamp.to, clamp.id],
    );
  }
}

async function hasRecordedMigrations(): Promise<boolean> {
  const rows = await client.unsafe(`
    SELECT 1
    FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
    LIMIT 1
  `);

  return rows.length > 0;
}

async function hasLegacySchemaWithoutHistory(): Promise<boolean> {
  // Probes for "chats", not "accounts": "accounts" was dropped in migration
  // 0018 (auth removal), so a post-0018 database that somehow lost its
  // `drizzle.__drizzle_migrations` rows would probe negative forever and
  // fall through to a fresh `migrate()` run that hard-fails on tables that
  // already exist. "chats" has existed since migration 0000 and nothing
  // drops it, so it stays a valid signal for "schema already applied" on
  // both old and current databases.
  const rows = (await client.unsafe(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'chats'
    ) AS has_chats
  `)) as Array<{ has_chats?: boolean }>;

  return rows[0]?.has_chats === true;
}

async function reconcileLegacySchema(): Promise<void> {
  console.log(
    "Detected existing schema without migration history. Reconciling migration records…",
  );

  const migrations = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  }) as MigrationFile[];

  for (const migration of migrations) {
    for (const statement of migration.sql) {
      const sql = statement.trim();
      if (!sql) {
        continue;
      }

      try {
        await client.unsafe(sql);
      } catch (error) {
        if (isIgnorableLegacyError(error)) {
          console.log(
            `Skipping already-applied statement (${getErrorCode(error)}): ${getErrorMessage(error)}`,
          );
          continue;
        }

        throw error;
      }
    }

    await client.unsafe(
      `
        INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ("hash", "created_at")
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" WHERE created_at = $2
        )
      `,
      [migration.hash, migration.folderMillis],
    );
  }

  console.log("Legacy migration reconciliation complete");
}

try {
  await ensureMigrationsTable();
  await clampFutureDatedMigrationRecords();

  const migrationsRecorded = await hasRecordedMigrations();
  if (!migrationsRecorded && (await hasLegacySchemaWithoutHistory())) {
    await reconcileLegacySchema();
  }

  console.log("Running database migrations…");
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied successfully");
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
} finally {
  await client.end();
}
