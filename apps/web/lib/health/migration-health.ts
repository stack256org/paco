import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getErrorCode } from "@/lib/db/error-code";
import journalFile from "../db/migrations/meta/_journal.json";

/**
 * Whether every migration the build ships with has actually been applied.
 *
 * Exists because Phase 4 found migrations being **silently skipped**: a
 * hand-written journal entry (`0005_backfill_organization_owner`) carried a
 * future timestamp, so drizzle's migrator — which decides what still needs
 * applying by comparing each journal entry's `when` against the newest
 * `created_at` it has already recorded — treated genuinely later migrations
 * as already applied. The build reported success; nothing was applied; the
 * failure surfaced later as unrelated runtime errors.
 *
 * `lib/db/migration-clamp.ts` (already merged) corrects that one specific
 * cause at migration time. This surfaces the *condition* on an ongoing
 * basis, so the next variant of it is visible on the health page instead of
 * mysterious in the logs.
 */
export type MigrationState = "in-sync" | "pending" | "out-of-order";

export type MigrationHealth = {
  state: MigrationState;
  applied: number;
  total: number;
  pendingTags: string[];
};

export type JournalEntry = {
  /** e.g. `"0007_wandering_zorak"` — the migration file's name, minus its extension. */
  tag: string;
  /** The journal's own timestamp for this migration. */
  when: number;
};

/**
 * Whether the journal's own `when` values increase monotonically in file
 * order.
 *
 * This is the *exact* Phase 4 shape, checked directly rather than inferred
 * from applied timestamps: a hand-written entry (`0005_backfill_organization_owner`)
 * carrying a `when` two days in the future, sitting before later, real
 * entries. The comparison below — "is any applied timestamp newer than the
 * journal's max?" — can miss that shape entirely: once the future-dated
 * entry has itself been recorded as applied, the recorded value *equals*
 * `max(journal)` rather than exceeding it, so nothing reads as out of order
 * and the state falls through to "pending". That reading is actively
 * misleading, because running `db:migrate:apply` from there reports success
 * and applies nothing — the migrator compares against that same inflated
 * value and keeps skipping the real entries after it. Checking the journal's
 * own ordering catches the hazard regardless of what has or has not been
 * applied yet.
 */
function isJournalMonotonic(journal: JournalEntry[]): boolean {
  for (let index = 1; index < journal.length; index++) {
    if (journal[index].when < journal[index - 1].when) {
      return false;
    }
  }
  return true;
}

/**
 * Pure comparison between the journal (what the build ships) and the set of
 * timestamps Postgres has recorded as applied, so it is testable without a
 * database.
 *
 * - `out-of-order`: either some applied timestamp is newer than every entry
 *   in the journal, or the journal itself is not monotonic (see
 *   `isJournalMonotonic`). Both are the same underlying hazard — the
 *   migrator's notion of "already applied" can stop lining up with "further
 *   along in the journal" — and either can make it silently skip real
 *   pending migrations between them.
 * - `pending`: otherwise, and the journal has an entry whose timestamp was
 *   never recorded as applied. An empty database (nothing recorded at all)
 *   falls in here too — it is not, and must not read as, "in sync".
 * - `in-sync`: every journal entry has a matching applied timestamp.
 */
export function compareMigrations(
  journal: JournalEntry[],
  appliedTimestamps: number[],
): MigrationHealth {
  const appliedSet = new Set(appliedTimestamps);
  const pendingTags = journal
    .filter((entry) => !appliedSet.has(entry.when))
    .map((entry) => entry.tag);

  const newestJournalWhen =
    journal.length > 0
      ? Math.max(...journal.map((entry) => entry.when))
      : Number.NEGATIVE_INFINITY;
  const outOfOrder =
    appliedTimestamps.some((timestamp) => timestamp > newestJournalWhen) ||
    !isJournalMonotonic(journal);

  let state: MigrationState;
  if (outOfOrder) {
    state = "out-of-order";
  } else if (pendingTags.length > 0) {
    state = "pending";
  } else {
    state = "in-sync";
  }

  return {
    state,
    applied: journal.length - pendingTags.length,
    total: journal.length,
    pendingTags,
  };
}

type JournalFile = {
  entries: Array<{ tag: string; when: number }>;
};

/**
 * A static import, not a runtime `fs.readFileSync` off a path built from
 * `import.meta.dirname` — that was this file's first draft, mirroring
 * `lib/db/migrate.ts`, and it broke the moment this module was actually
 * wired into a page: `lib/db/migrate.ts` runs as a plain Node/ESM script,
 * where `import.meta.dirname` is native and reliable, but this module is
 * bundled into a Next.js server action, where Turbopack does not carry that
 * property through and it comes back `undefined`. A static import is
 * resolved by the bundler at build time, so there is no path to get wrong.
 */
function readJournal(): JournalEntry[] {
  const parsed = journalFile as JournalFile;
  return parsed.entries.map((entry) => ({ tag: entry.tag, when: entry.when }));
}

/** Postgres error code for a relation that does not exist yet. */
const UNDEFINED_TABLE = "42P01";

/**
 * `drizzle-orm` wraps the underlying `postgres` driver error in a
 * `DrizzleQueryError`, which reports `error.code === undefined` at the top
 * level — the real SQLSTATE sits one level down, on `error.cause.code`.
 * Testing `error.code` directly, as this used to, means this guard never
 * fires against a live database: a fresh install's 42P01 propagates instead
 * of reading as "pending", and the card says "Unavailable — Postgres may be
 * unreachable" about a database it is talking to successfully.
 */
function isMissingTable(error: unknown): boolean {
  return getErrorCode(error) === UNDEFINED_TABLE;
}

/**
 * Tolerates the table not existing — that is a fresh database, before the
 * first migration has ever run, which is `pending`, not an error.
 */
async function readAppliedTimestamps(): Promise<number[]> {
  try {
    // Schema and table are fixed identifiers (matches `lib/db/migrate.ts`),
    // never interpolated data, so a literal query is safe here.
    const rows = await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations`,
    );
    return (rows as unknown as Array<{ created_at: string | number | null }>)
      .map((row) => (row.created_at === null ? null : Number(row.created_at)))
      .filter((value): value is number => value !== null);
  } catch (error) {
    if (isMissingTable(error)) {
      return [];
    }
    throw error;
  }
}

export async function readMigrationHealth(): Promise<MigrationHealth> {
  const journal = readJournal();
  const appliedTimestamps = await readAppliedTimestamps();
  return compareMigrations(journal, appliedTimestamps);
}
