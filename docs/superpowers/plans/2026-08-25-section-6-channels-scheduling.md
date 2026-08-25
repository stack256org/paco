# Section 6: Channels + Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entry points beyond the browser — a first-party Slack channel plugin (mention the bot → task on the board → threaded replies) and cron schedules that fire tasks — both built ON the Section 2 plugin system, proving it.

**Architecture:** A channel does Eve's three jobs: normalize inbound to a message, own the address→session/task mapping, decide reply delivery. The Slack channel ships as a real plugin directory (`plugins/first-party/slack/` in the repo, installed from `local:` source) using `channels/` + `net:fetch` + `messages:post` + `events:subscribe` + `storage:kv`. Schedules are rows firing through pg-boss cron into task creation.

**Spec:** `docs/superpowers/specs/2026-08-25-paco-platform-design.md` (Section 6). Depends on Section 2 (plugin system) and Section 3 (tasks).

## Global Constraints

- Section 1 plan's Global Constraints + Section 2's security invariants apply verbatim. Zero-customer ruling. Nothing deferred.
- Channel plugin code runs ONLY in the plugin worker; Paco's core gains no Slack-specific code — the ONLY core additions are the generic webhook ingress route and the schedules feature.
- Inbound webhook ingress is authenticated per-plugin (shared-secret header) and rate-limited with the repo's existing rate-limit helper (`apps/web/lib/rate-limit.ts` — read it first).

---

### Task 1: Generic channel ingress + channel capability

**Files:**
- Modify: `packages/plugin-kit/capabilities.ts` — add `"channels:ingress"` to CAPABILITIES (a plugin with a `channels/` slot must request it; add the superRefine rule to the manifest schema + a manifest test).
- Modify: `packages/plugin-host/protocol.ts` + `host.ts` — new host→worker message `{kind:"ingress", requestId, channel, headers: Record<string,string>, body: unknown}` and worker→host reply `{kind:"ingress-result", requestId, status: number, body?: unknown}`; `PluginHost.deliverIngress(channel, headers, body, timeoutMs=10s)`.
- Modify: `packages/plugin-host/worker-entry.ts` — load `channels/*.ts` default exports `{ name?, handle(request: {headers, body}, api): Promise<{status, body?}> }`.
- Create: `apps/web/app/api/channels/[pluginId]/[channel]/route.ts` — POST only; auth: constant-time compare of header `x-paco-channel-secret` against a per-plugin secret (generated at install, stored on the plugins row — add `ingressSecret text` column via migration, shown once on the Plugins settings page after install/enable); rate-limited; looks up the running host, `deliverIngress`, mirrors {status, body}. Plugin not running → 503.
- Test: protocol/host tests (ingress round-trip, timeout → 504, ungranted channels:ingress → refused), route tests (bad secret 401, unknown plugin 404, happy path, rate limit).

**Steps (TDD)** → commit: `Add channel ingress through plugin workers`

---

### Task 2: Task-creation capability

**Files:**
- Modify: `packages/plugin-kit/capabilities.ts` — add `"tasks:create"`.
- Modify: `apps/web/lib/plugins/capability-handlers.ts` — handler: payload `{sessionId, title, goal, autoStart?: boolean}` zod-validated; creates a task (origin: extend tasks origin enum with "channel" — already in Section 3's enum) via the Section 3 helpers; autoStart → startTask; returns `{taskId, chatId?}`. Org scoping: the plugin acts within the instance's org — resolve the session's org and verify; reject unknown sessions.
- Test: handler tests (validation, unknown session, autoStart path mocked).

**Steps (TDD)** → commit: `Let plugins create tasks`

---

### Task 3: The Slack channel plugin (first-party, in-repo)

**Files:**
- Create: `plugins/first-party/slack/plugin.json` — capabilities: ["channels:ingress","net:fetch","messages:post","tasks:create","events:subscribe","storage:kv"], netDomains: ["slack.com"] (the Web API host — verify chat.postMessage's exact host and list precisely what is called).
- Create: `plugins/first-party/slack/channels/events.ts` — handles Slack Events API: url_verification challenge echo; signature verification (signing secret from kv, set via a one-time setup tool — see below) using the raw body per Slack's v0 signature scheme — the ingress payload must therefore carry the RAW body string: adjust Task 1's ingress message to include `rawBody: string` alongside parsed body, and do it in Task 1, not here; app_mention events → `api.tasks.create({sessionId: <mapped>, title: first 80 chars, goal: text minus the mention, autoStart: true})`, reply in thread via `api.fetch` chat.postMessage acknowledging with the task id; kv stores: `slack:signing-secret`, `slack:bot-token`, `slack:channel-map:<slackChannelId>` → sessionId, `slack:thread:<taskId>` → {channel, ts}.
- Create: `plugins/first-party/slack/tools/slack_setup.ts` — a model-facing tool (admin runs it from a chat): input {botToken, signingSecret, defaultSessionId, channelMap?}; writes kv; validates the token with auth.test via api.fetch; returns the webhook URL to paste into Slack's app config (constructed from an APP_URL passed as tool input — the worker has no env).
- Create: `plugins/first-party/slack/hooks/task-updates.ts` — events:subscribe hook: on `task/status` events for tasks with a stored thread, post threaded status updates; on `turn/end` for the task's chat, post the resultSummary when done.
- Test: `plugins/first-party/slack/slack.test.ts` — bun tests importing the channel/tool modules directly with a fake `api` object: challenge echo; BAD signature → 401; good signature (compute a real v0 signature in the test) → task created + threaded ack; setup tool validates+stores; task-update hook posts. Also an integration-shaped test through the REAL plugin host (fixture-install the plugin dir, deliverIngress with signed payload).
- Modify: install docs — `docs/plugins.md` (Create): how to install first-party plugins (`local:` source), the Slack app manifest steps (scopes: app_mentions:read, chat:write), where the webhook URL and secret go.

**Steps (TDD)** → commit: `Add the first-party Slack channel plugin`

---

### Task 4: Schedules

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — `schedules` table: id, organizationId FK, sessionId FK, name, cron (text, validated by pg-boss's cron parser or a zod regex — use whatever pg-boss exposes; read how the email job schedules), goal text, assignedAgent nullable, enabled bool default true, lastFiredAt nullable, createdBy. Migration (ONLY this).
- Create: `apps/web/lib/schedules/fire.ts` + `apps/web/lib/jobs/schedule-job.ts` — a pg-boss cron job every minute scanning enabled schedules whose cron matches now (use a proper cron matcher — if pg-boss can register per-schedule cron jobs directly, do that instead of scanning: read pg-boss's schedule API and pick the cleaner mechanism, document the choice); firing = create task (origin "schedule") + startTask + stamp lastFiredAt. Missed-window semantics: no catch-up — a fire happens only when the tick matches (document in code).
- Create: `apps/web/app/settings/schedules/page.tsx` + actions + nav entry — CRUD, org-member view/admin write (match the app's admin gating for writes), a "Run now" button (fires immediately through the same fire path), enabled toggle, last-fired display. daisyUI skill first.
- Test: fire tests (task created+started mocked, lastFiredAt stamped, disabled skipped), cron registration idempotence, actions tests (gating, validation — bad cron rejected with message).

**Steps (TDD)** → commit: `Add cron schedules that fire tasks`

---

## Final verification
- [ ] `pnpm run ci`.
- [ ] Manual smoke: install the Slack plugin from local source, run slack_setup from a chat, send a signed test event via curl, watch the task appear/start and the threaded ack; create a schedule "every minute" pointing at a test session, watch two consecutive fires, disable it.
