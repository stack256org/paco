"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { DockerCard } from "./docker-card";
import { HealthCardSkeleton } from "./health-card";
import { MigrationsCard } from "./migrations-card";
import { QueueCard } from "./queue-card";
import { SpendCard } from "./spend-card";
import { StorageCard } from "./storage-card";
import { useInstanceHealth } from "./use-instance-health";

/**
 * The grid of cards, and the one control on the page that isn't inside a
 * card: "Check again". Nothing here writes anything — see the module doc on
 * `page.tsx`.
 */
export function HealthPageContent() {
  const { health, isLoading, error, refresh } = useInstanceHealth();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Instance health</h1>
          <p className="mt-1 text-sm text-base-content/60">
            Queue, migrations, spend, disk and containers — read-only.
          </p>
        </div>
        <button
          className="btn btn-sm btn-ghost"
          disabled={isLoading}
          onClick={() => void refresh()}
          type="button"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {isLoading ? "Checking…" : "Check again"}
        </button>
      </div>

      {error ? (
        <div className="alert alert-error alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {isLoading && !health ? (
        <div className="grid gap-4 md:grid-cols-2">
          <HealthCardSkeleton />
          <HealthCardSkeleton />
          <HealthCardSkeleton />
          <HealthCardSkeleton />
        </div>
      ) : null}

      {health ? (
        <div className="grid gap-4 md:grid-cols-2">
          <DockerCard docker={health.docker} />
          <QueueCard queue={health.queue} />
          <MigrationsCard migrations={health.migrations} />
          <SpendCard spend={health.spend} />
          <StorageCard />
        </div>
      ) : null}
    </>
  );
}
