# Sandbox lifecycle

A sandbox is a Docker container per session. Nothing outside Paco will ever stop
one, so Paco reclaims them itself: idle containers hibernate, and a hard bound
catches anything that slips through.

Hibernation is just `docker stop`. There is no snapshot step — the workspace is
a real directory on the host, so the filesystem survives the container and
resuming means starting a new container over the same directory.

## Timeouts

| Constant | Value | Purpose |
|---|---|---|
| `SANDBOX_INACTIVITY_TIMEOUT_MS` | 30 minutes | Idle window before hibernating |
| `DEFAULT_SANDBOX_TIMEOUT_MS` | 5 hours less 30s | Outer bound before the container is reclaimed |
| `EXTEND_TIMEOUT_DURATION_MS` | 20 minutes | Granted by an explicit extend |

All in `lib/sandbox/config.ts`. The 30-second subtraction reserves room for the
sandbox's before-stop hooks, so they run rather than being cut off at the
deadline.

## State machine

```text
   ┌──────────────┐
   │ provisioning │
   └──────┬───────┘
          │ container created, lifecycle run started
          ▼
   ┌────────────────────────┐
   │        active          │◀──── user activity refreshes
   │ lastActivityAt = now   │      lastActivityAt and hibernateAfter
   │ hibernateAfter = now+I │
   │ sandboxExpiresAt = T+H │
   └───────────┬────────────┘
               │ now >= min(hibernateAfter, sandboxExpiresAt - buffer)
               ▼
   ┌───────────────┐      ┌────────────┐
   │  hibernating  │─────▶│ hibernated │
   │ stops sandbox │      │  (paused)  │
   └───────────────┘      └─────┬──────┘
                                │ user resumes
                                └──────────▶ provisioning
```

Where **I** is the inactivity timeout and **H** the hard timeout. Reaching the
hard bound while still active hibernates exactly like going idle; the user
resumes if they want it back. That is simpler than rolling the container over,
and in practice the idle path fires first almost every time.

## The workflow

Each session keeps at most one durable workflow run.
`kickSandboxLifecycleWorkflow()` starts one only when no run is active; the run
claims a lease in `sessions.lifecycleRunId` and rechecks it before every sleep,
so a superseded run exits instead of racing the one that replaced it.

Each iteration:

1. Read the session and verify the lease.
2. `wakeAtMs = min(hibernateAfter, sandboxExpiresAt - buffer)`.
3. Durably sleep until then — it survives restarts and cold starts.
4. Re-read and decide: hibernate, or `not-due-yet` and loop with fresh state.
5. Exit and clear `lifecycleRunId` once hibernated or no longer operable.

Activity refreshes deliberately do *not* start a run. They only move the
timestamps; the sleeping run reads them when it next wakes. Otherwise every
message would start a workflow.

### Two guards before it stops anything

Hibernation is destructive from the user's point of view — an agent mid-task
would lose its container — so `evaluateSandboxLifecycle` re-checks after every
step that could have taken time:

- an active stream for the session, checked both before connecting and again
  after, since connecting is slow enough for a turn to start;
- whether the lifecycle timestamps moved while it was connecting, which means
  the user came back and the run is no longer due.

Any of those restores the active state and returns `skipped`.

## What starts a run

| Event | Reason | Source |
|---|---|---|
| Sandbox created | `sandbox-created` | `POST /api/sandbox`, and provisioning |
| Manual extend | `timeout-extended` | `POST /api/sandbox/extend` |
| Poll finds an overdue sandbox | `status-check-overdue` | `GET /api/sandbox/status` |

## Activity tracking

`lastActivityAt` and `hibernateAfter` are refreshed:

- at chat start, so a long agent turn cannot hibernate underneath itself;
- at chat finish, resetting the window after each interaction;
- on create and extend;
- on textarea focus, via `POST /api/sandbox/activity`, throttled to once every
  five minutes — composing a long message is not idleness.

They are *not* refreshed by reconnect probes or status polls. Both happen on
every page load, and letting them count as activity would mean a tab left open
never hibernates.

## Safety nets

1. **Status endpoint.** The client polls `GET /api/sandbox/status` every 15s;
   if a sandbox is overdue and the lifecycle has not acted, it kicks a run. A
   kick with a run already active is ignored.
2. **Retry on `not-due-yet`.** Recompute and loop rather than exiting.
3. **Inline fallback.** If `start(workflow)` fails — the workflow SDK is not
   always available in development — `evaluateSandboxLifecycle()` runs
   synchronously instead.
4. **Stale lease guard.** A lease overdue by more than two minutes is cleared so
   a fresh run can take over.

## Client-side sync

The client polls status every 15s and derives what it shows from the server's
lifecycle state, with the local `createdAt + timeout` only driving the
countdown. A forced sync fires the moment a chat finishes (`streaming → ready`),
which closes the window where the server has hibernated but the UI still says
active.

## Reclaiming: when a resource stops belonging to anything

Hibernation stops a container; it never deletes one, and it never touches the
workspace directory. That is correct for a session that still exists, and it is
how the workspace leaked: `destroy()` was called from nowhere, `DELETE
/api/sessions/[sessionId]` removed only the row, and a database reset left every
container running and every worktree on disk with nothing able to reach them.

Two resources, treated differently on purpose:

| | Container | Workspace directory |
|---|---|---|
| Holds | nothing — the workspace is bind-mounted | the user's code, possibly unpushed |
| Removing it costs | a slower next start | everything in it, permanently |
| Reclaimed | in groups, one confirmation | one at a time, each naming its size and its unsaved work |

The policy is **report always, reclaim only on an explicit action**. Nothing is
deleted on a timer. `apps/web/app/settings/admin` shows the measured inventory —
`du` per directory, Docker's writable-layer size per container — and the
reclaim actions are behind `useDestructiveConfirm`.

Deleting a session is the one path that reaps without a separate step, because
deleting a workspace is what the word means. It refuses with a 409 when the
worktree holds uncommitted or unpushed work, unless the caller passes `?force=1`.

Two rules the code enforces rather than assumes:

- **Only `paco-sbx-*` containers and directories directly under the workspace
  root.** A self-hosted install shares its daemon with everything else the
  operator runs, including Paco's own `paco-pg`.
- **Names map forwards only.** A session row is turned into the names it would
  produce; a container name is never parsed back into a session id, because
  `toContainerName` is lossy and guessing wrong deletes live work.

| File | Purpose |
|---|---|
| `lib/reaping/classify.ts` | Pure orphan detection and the reclaim plan |
| `lib/reaping/inventory.ts` | Sessions + Docker + disk, gathered |
| `lib/reaping/reclaim.ts` | The destructive half; groups, never client-supplied lists |
| `lib/reaping/delete-session.ts` | Session delete, resources first, row last |
| `packages/sandbox/docker/reap.ts` | Listing and guarded removal of `paco-sbx-*` |

## Key files

| File | Purpose |
|---|---|
| `lib/sandbox/lifecycle.ts` | Evaluation logic, state builders, types |
| `lib/sandbox/lifecycle-kick.ts` | Starting a run, with the inline fallback |
| `lib/sandbox/config.ts` | Timeout constants |
| `app/workflows/sandbox-lifecycle.ts` | The durable workflow |
| `app/api/sandbox/status/route.ts` | DB-backed status polling |
| `app/api/sandbox/reconnect/route.ts` | Connectivity probe |
| `app/api/chat/route.ts` | Activity refresh at start and finish |
