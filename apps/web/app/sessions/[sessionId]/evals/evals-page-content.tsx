"use client";

import { AlertTriangle, ArrowLeft, Loader2, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "@/lib/toast";
import type { EvalRun, EvalScenario } from "./actions";
import { runAllEvalScenariosAction, runEvalScenarioAction } from "./actions";

interface EvalsPageContentProps {
  sessionId: string;
  initialScenarios: EvalScenario[];
  initialDiscoveryErrors: string[];
  initialHistory: EvalRun[];
}

interface EvalAssertionResult {
  kind: string;
  description: string;
  passed: boolean;
  message?: string;
}

interface EvalRunDetails {
  assertions: EvalAssertionResult[];
  harnessError?: string;
}

function detailsOf(run: EvalRun): EvalRunDetails {
  const details = run.details as EvalRunDetails | null;
  return details ?? { assertions: [] };
}

function statusBadgeClass(status: EvalRun["status"]): string {
  switch (status) {
    case "passed":
      return "badge badge-success";
    case "failed":
      return "badge badge-error";
    case "error":
      return "badge badge-warning";
    default:
      return "badge";
  }
}

function formatTimestamp(value: Date | string): string {
  return new Date(value).toLocaleString();
}

function AssertionBadges({ details }: { details: EvalRunDetails }) {
  if (details.harnessError) {
    return (
      <span className="text-sm text-base-content/70">
        {details.harnessError}
      </span>
    );
  }

  if (details.assertions.length === 0) {
    return <span className="text-sm text-base-content/50">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {details.assertions.map((assertion) => (
        <span
          className={`badge badge-sm ${assertion.passed ? "badge-success" : "badge-error"}`}
          key={assertion.description}
          title={assertion.message ?? assertion.description}
        >
          {assertion.kind}
        </span>
      ))}
    </div>
  );
}

function RosterSnapshotDetails({ run }: { run: EvalRun }) {
  return (
    <details className="collapse-arrow collapse border border-base-300 bg-base-100">
      <summary className="collapse-title text-sm">Roster snapshot</summary>
      <div className="collapse-content">
        <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(run.rosterSnapshot, null, 2)}
        </pre>
      </div>
    </details>
  );
}

function ScenarioCard({
  scenario,
  onRun,
  isRunning,
  disabled,
}: {
  scenario: EvalScenario;
  onRun: () => void;
  isRunning: boolean;
  disabled: boolean;
}) {
  return (
    <div className="card card-sm border border-base-300 bg-base-100">
      <div className="card-body">
        <h2 className="card-title text-base">{scenario.name}</h2>
        <p className="text-sm text-base-content/70">{scenario.prompt}</p>
        <p className="text-xs text-base-content/50">
          {scenario.assertions.length} assertion
          {scenario.assertions.length === 1 ? "" : "s"} · max{" "}
          {scenario.maxTurns} turns
        </p>
        <div className="card-actions justify-end">
          <button
            className="btn btn-sm"
            disabled={disabled}
            onClick={onRun}
            type="button"
          >
            {isRunning ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Play aria-hidden="true" className="size-4" />
            )}
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The interactive half of `/sessions/[sessionId]/evals`.
 *
 * Runs are awaited server actions that can take up to `EVAL_RUN_TIMEOUT_MS`
 * (10 minutes) to resolve — `runEvalScenario` runs a whole throwaway turn
 * before returning — so every "Run" affordance here disables itself and
 * shows a spinner for the duration rather than looking stuck.
 */
export function EvalsPageContent({
  sessionId,
  initialScenarios,
  initialDiscoveryErrors,
  initialHistory,
}: EvalsPageContentProps) {
  const [history, setHistory] = useState<EvalRun[]>(initialHistory);
  const [runningName, setRunningName] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);

  const anyRunInFlight = runningName !== null || runningAll;

  async function handleRun(scenario: EvalScenario) {
    setRunningName(scenario.name);
    try {
      const row = await runEvalScenarioAction(sessionId, scenario);
      setHistory((rows) => [row, ...rows]);
      if (row.status !== "passed") {
        toast.error(`"${scenario.name}" did not pass.`);
      }
    } catch {
      toast.error(`Failed to run "${scenario.name}".`);
    } finally {
      setRunningName(null);
    }
  }

  async function handleRunAll() {
    setRunningAll(true);
    try {
      const rows = await runAllEvalScenariosAction(sessionId, initialScenarios);
      setHistory((existing) => rows.toReversed().concat(existing));
    } catch {
      toast.error("Failed to run all scenarios.");
    } finally {
      setRunningAll(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      {/*
        The way back out.

        This route sits under the session layout but has no `chatId`, so the
        chat tab strip — which is what `EvalsTabLink` lives on, and the only
        in-app route back to a conversation — does not render here. Without
        this the page is somewhere you can get to and not leave, which is the
        same reachability bug over again in the other direction. `/sessions/
        <id>` redirects to the session's first chat.
      */}
      <Link
        className="flex w-fit items-center gap-2 text-sm text-base-content/60 transition-colors hover:text-base-content"
        href={`/sessions/${sessionId}`}
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to chats
      </Link>

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Evals</h1>
          <p className="mt-1 text-sm text-base-content/60">
            Repo-defined scenarios from <code>evals/*.json</code>, run in
            throwaway chats against the current roster.
          </p>
        </div>
        <button
          className="btn btn-sm"
          disabled={anyRunInFlight || initialScenarios.length === 0}
          onClick={() => void handleRunAll()}
          type="button"
        >
          {runningAll && (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          )}
          Run all
        </button>
      </div>

      {initialDiscoveryErrors.length > 0 && (
        <div className="alert alert-warning alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <div>
            <p className="font-medium">
              {initialDiscoveryErrors.length} scenario file
              {initialDiscoveryErrors.length === 1 ? "" : "s"} could not be
              read:
            </p>
            <ul className="mt-1 list-inside list-disc text-sm">
              {initialDiscoveryErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {initialScenarios.length === 0 ? (
        <p className="text-sm text-base-content/60">
          No eval scenarios found. Add one at{" "}
          <code>evals/&lt;name&gt;.json</code> in this session&apos;s repo.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {initialScenarios.map((scenario) => (
            <ScenarioCard
              disabled={anyRunInFlight}
              isRunning={runningName === scenario.name}
              key={scenario.name}
              onRun={() => void handleRun(scenario)}
              scenario={scenario}
            />
          ))}
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold">History</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-base-content/60">No eval runs yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-base-300">
            <table className="table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Assertions</th>
                  <th>Roster</th>
                </tr>
              </thead>
              <tbody>
                {history.map((run) => (
                  <tr key={run.id}>
                    <td>{run.scenarioName}</td>
                    <td>
                      <span className={statusBadgeClass(run.status)}>
                        {run.status}
                      </span>
                    </td>
                    <td className="text-sm text-base-content/70">
                      {formatTimestamp(run.startedAt)}
                    </td>
                    <td>
                      <AssertionBadges details={detailsOf(run)} />
                    </td>
                    <td>
                      <RosterSnapshotDetails run={run} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
