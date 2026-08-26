import { Database } from "lucide-react";
import type { HealthMetric } from "@/lib/admin/health-actions";
import type { MigrationHealth } from "@/lib/health/migration-health";
import { HealthCard } from "./health-card";
import { HealthNotice, UnavailableNotice } from "./health-notice";

/**
 * Whether every migration this build ships with has actually been applied.
 *
 * Exists because Phase 4 lost time to migrations that were silently
 * skipped while the migrator reported success — a hand-written journal
 * entry with a future timestamp made the migrator treat genuinely later
 * migrations as already applied. When this is out of sync, the card names
 * exactly which migrations are pending and what to run, rather than leaving
 * an operator to `db:studio` in and guess.
 */
export function MigrationsCard({
  migrations,
}: {
  migrations: HealthMetric<MigrationHealth>;
}) {
  return (
    <HealthCard icon={Database} title="Migrations">
      {migrations.status === "unavailable" ? (
        <UnavailableNotice reason="migration state could not be read — Postgres may be unreachable." />
      ) : (
        <MigrationsBody migrations={migrations.data} />
      )}
    </HealthCard>
  );
}

function MigrationsBody({ migrations }: { migrations: MigrationHealth }) {
  return (
    <div className="space-y-4">
      <MigrationsHeadline migrations={migrations} />
      <p className="text-sm text-base-content/60">
        {migrations.applied} of {migrations.total} migrations applied.
      </p>
    </div>
  );
}

function MigrationsHeadline({ migrations }: { migrations: MigrationHealth }) {
  const pendingList = migrations.pendingTags.map((tag) => (
    <code
      className="rounded bg-base-200 px-1 py-0.5 text-xs wrap-anywhere"
      key={tag}
    >
      {tag}
    </code>
  ));

  if (migrations.state === "out-of-order") {
    return (
      <HealthNotice tone="error">
        <span className="block">
          Migration history is out of order — either Postgres has recorded a
          migration as applied with a timestamp newer than every entry in this
          build&apos;s journal, or the journal itself has an entry recorded
          earlier than one that precedes it. Either shape can make the migrator
          silently skip real pending migrations between them.
        </span>
        {pendingList.length > 0 ? (
          <span className="mt-2 flex flex-wrap items-center gap-1">
            Pending by name: {pendingList}
          </span>
        ) : null}
        <span className="mt-2 block">
          Do not run a migration blindly — compare{" "}
          <code className="rounded bg-base-200 px-1 py-0.5 text-xs wrap-anywhere">
            drizzle.__drizzle_migrations
          </code>{" "}
          against{" "}
          <code className="rounded bg-base-200 px-1 py-0.5 text-xs wrap-anywhere">
            lib/db/migrations/meta/_journal.json
          </code>{" "}
          before deciding what to run.
        </span>
      </HealthNotice>
    );
  }

  if (migrations.state === "pending") {
    return (
      <HealthNotice tone="warning">
        <span className="flex flex-wrap items-center gap-1">
          {pendingList.length} migration
          {pendingList.length === 1 ? "" : "s"} not applied yet: {pendingList}
        </span>
        <span className="mt-2 block">
          Run{" "}
          <code className="rounded bg-base-200 px-1 py-0.5 text-xs wrap-anywhere">
            pnpm --dir apps/web db:migrate:apply
          </code>
          , or redeploy — migrations also run automatically during{" "}
          <code className="rounded bg-base-200 px-1 py-0.5 text-xs wrap-anywhere">
            pnpm build
          </code>
          .
        </span>
      </HealthNotice>
    );
  }

  return <p className="text-sm text-base-content/60">Schema is up to date.</p>;
}
