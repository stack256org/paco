# Section 2: Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Third-party plugins as directories of Eve-style slots, running in sandboxed worker processes behind a typed capability API, with operator consent at install — plus MCP-server passthrough that finally opens `--mcp-config`.

**Architecture:** `@paco/plugin-kit` (manifest schema, capability vocabulary, slot discovery — pure, no I/O side effects beyond reads) and `@paco/plugin-host` (worker process per enabled plugin, JSON-line RPC over stdio, grant enforcement in the host). The web app owns the `plugins` DB table, the install/consent flow, a Plugins settings page, and the bridges: session-event fan-out to subscribed plugins, plugin-registered tools into the agent's MCP config, plugin skills into workspace skill discovery.

**Tech Stack:** TypeScript, node:child_process (worker isolation), Drizzle/Postgres, Bun tests, Zod v4, Next.js App Router + daisyUI (via the daisyui skill at .agents/skills/daisyui/SKILL.md).

**Spec:** `docs/superpowers/specs/2026-08-25-paco-platform-design.md` (Section 2)

## Global Constraints

- Everything from the Section 1 plan's Global Constraints applies verbatim (pnpm/bun/no-any/.ts-extensions-in-packages/@-alias-in-web/migrations-generated-and-committed/pnpm fix/no `pnpm run ci` per task/no Co-Authored-By).
- **Security invariants (spec Section 2, binding):** plugin code NEVER runs in the Next.js process; a plugin worker's environment contains NO ambient secrets (no APP_SECRET, no tokens, no POSTGRES_URL — build its env from scratch, do not inherit `process.env`); every capability call is checked against the plugin's granted list IN THE HOST before executing; `net:fetch` enforces its domain allowlist in the host; a crashed/hung plugin degrades (notice, drop subscriptions) and never fails a turn or request.
- Plugin ids: `^[a-z][a-z0-9-]{1,63}$`. Paco plugin API version: this plan ships `1`; manifests declare `pacoApi: 1`.
- Zero-customer ruling applies: no compat shims.
- UI work follows the daisyUI skill; UI files colocate under `apps/web/app/settings/plugins/`.

---

### Task 1: `@paco/plugin-kit` — manifest schema + capability vocabulary

**Files:**
- Create: `packages/plugin-kit/package.json` (mirror `@paco/agent-backend`'s package.json shape exactly: same scripts, `zod: "catalog:"` dependency, `@paco/tsconfig` devDependency, named main/exports for `./manifest.js`, `./capabilities.js`, `./discovery.js`, `./index.ts` main)
- Create: `packages/plugin-kit/tsconfig.json` (copy packages/agent-backend/tsconfig.json)
- Create: `packages/plugin-kit/capabilities.ts`
- Create: `packages/plugin-kit/manifest.ts`
- Create: `packages/plugin-kit/index.ts` (NAMED exports of every public symbol — this repo lints against `export *`)
- Test: `packages/plugin-kit/manifest.test.ts`

**Interfaces:**
- Produces (consumed by every later task):

```ts
// capabilities.ts
export const CAPABILITIES = [
  "events:subscribe",   // receive session events for chats in this instance
  "messages:post",      // post a user message into a chat
  "tools:register",     // contribute model-facing tools (bridged over MCP)
  "net:fetch",          // outbound HTTP to declared domains only
  "storage:kv",         // per-plugin key-value storage
  "ui:panel",           // contribute a sandboxed iframe panel
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const capabilitySchema: z.ZodType<Capability>; // z.enum(CAPABILITIES)

// manifest.ts
export const pluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  version: z.string().min(1),
  description: z.string().min(1),
  pacoApi: z.literal(1),
  capabilities: z.array(capabilitySchema).default([]),
  // required iff "net:fetch" is requested: exact hostnames, no wildcards
  netDomains: z.array(z.string().regex(/^[a-z0-9.-]+$/)).optional(),
  // MCP servers this plugin contributes (bridged to backends with mcp capability)
  mcpServers: z.record(z.string(), z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })).optional(),
}).superRefine(/* net:fetch requested but netDomains missing/empty → issue;
                 netDomains present without net:fetch → issue;
                 mcpServers present without tools:register → issue */);
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export function parsePluginManifest(json: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string };
```

**Steps (TDD):**
- [ ] Write `manifest.test.ts` covering: valid minimal manifest parses; bad name rejected (uppercase, leading digit, >64 chars); `pacoApi: 2` rejected; `net:fetch` without `netDomains` rejected with a message naming the rule; `netDomains` without `net:fetch` rejected; `mcpServers` without `tools:register` rejected; `parsePluginManifest` returns `{ok:false, error}` (never throws) on garbage input including non-objects.
- [ ] Run to fail, implement `capabilities.ts` + `manifest.ts` + named-export `index.ts`, run to pass.
- [ ] `pnpm install` (workspace link), `turbo typecheck --filter=@paco/plugin-kit`, `pnpm fix`.
- [ ] Commit: `Add @paco/plugin-kit with the plugin manifest schema`

---

### Task 2: Slot discovery

**Files:**
- Create: `packages/plugin-kit/discovery.ts`
- Test: `packages/plugin-kit/discovery.test.ts` (use a tmp dir fixture built with node:fs in the test, mirroring how packages/sandbox tests build fixtures if they do)

**Interfaces:**
- Consumes: Task 1's `parsePluginManifest`.
- Produces:

```ts
export interface PluginDescriptor {
  manifest: PluginManifest;
  rootDir: string;
  slots: {
    tools: string[];      // absolute paths of tools/*.ts|*.js files
    channels: string[];   // channels/*.ts|*.js
    skills: string[];     // skills/*/SKILL.md directories' SKILL.md paths
    agents: string[];     // agents/*.json files
    renderers: string[];  // renderers/*.html files (sandboxed iframe entries)
    hooks: string[];      // hooks/*.ts|*.js
  };
}
export function discoverPlugin(rootDir: string): Promise<{ ok: true; plugin: PluginDescriptor } | { ok: false; error: string }>;
```

Semantics: missing slot directories → empty arrays (not errors); a missing or invalid `plugin.json` at rootDir → `{ok:false}` with the manifest error; files are sorted alphabetically for determinism; non-matching extensions ignored; nothing is imported/executed — discovery only stats and reads the manifest (executing plugin code is exclusively the worker host's job).

**Steps (TDD):** failing tests (full plugin fixture with every slot populated; empty plugin with manifest only; missing manifest; invalid manifest; determinism of ordering) → implement → pass → `pnpm fix` → commit: `Add plugin slot discovery`

---

### Task 3: `plugins` table + grants model

**Files:**
- Modify: `apps/web/lib/db/schema.ts` (append after `sessionEvents`)
- Create: migration via `pnpm --dir apps/web db:generate` (must contain ONLY this table)
- Create: `apps/web/lib/db/plugins.ts`
- Test: `apps/web/lib/db/plugins.test.ts` (fully-mocked db client — mirror `apps/web/lib/db/session-events.test.ts`'s established pattern exactly)

**Interfaces:**

```ts
export const plugins = pgTable("plugins", {
  id: text("id").primaryKey(),                      // the manifest name
  source: text("source").notNull(),                 // "github:owner/repo#ref" or "local:<path>"
  version: text("version").notNull(),
  contentHash: text("content_hash").notNull(),      // sha256 over the installed tree
  manifest: jsonb("manifest").notNull(),            // the parsed manifest, verbatim
  grantedCapabilities: jsonb("granted_capabilities").notNull(), // Capability[] — subset of requested
  enabled: boolean("enabled").notNull().default(false),
  installedAt: timestamp("installed_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
// apps/web/lib/db/plugins.ts — helpers, each narrow and typed:
export async function listPlugins(): Promise<PluginRow[]>;
export async function getPlugin(id: string): Promise<PluginRow | undefined>;
export async function upsertPlugin(row: NewPluginRow): Promise<void>;
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void>;
export async function setPluginGrants(id: string, grants: Capability[]): Promise<void>; // validates subset of manifest.capabilities, throws on escalation
export async function removePlugin(id: string): Promise<void>;
```

**Steps (TDD):** failing tests (round-trip; setPluginGrants rejects a capability not in the manifest — the "no self-escalation" rule; enabled defaults false — install is consent-gated, enable is a second step) → schema + `db:generate` + inspect migration → helpers → pass → commit: `Add plugins table and grant helpers`

---

### Task 4: Plugin installer (fetch, hash, lock)

**Files:**
- Create: `apps/web/lib/plugins/install.ts`
- Create: `apps/web/lib/plugins/content-hash.ts`
- Test: `apps/web/lib/plugins/content-hash.test.ts`, `apps/web/lib/plugins/install.test.ts`

**Interfaces:**
- Consumes: `discoverPlugin` (plugin-kit), `upsertPlugin` (Task 3).
- Produces:

```ts
// content-hash.ts — deterministic sha256 of a directory tree:
// sorted relative paths; for each: path + "\0" + file bytes; skip .git/**; hex digest.
export async function hashDirectory(rootDir: string): Promise<string>;
// install.ts
export interface InstallSource { kind: "github"; repo: string; ref?: string } | { kind: "local"; path: string };
export async function installPlugin(source: InstallSource): Promise<
  | { ok: true; pluginId: string; requested: Capability[] }   // installed DISABLED with NO grants — consent happens in the UI
  | { ok: false; error: string }>;
```

Semantics: github source → `git clone --depth 1` (and `--branch <ref>` when given) of `https://github.com/<repo>` into `<pluginsDir>/<name>` via node:child_process **execFile** (never a shell; repo must match `^[\w.-]+\/[\w.-]+$` before use); pluginsDir comes from a `PACO_PLUGINS_DIR` env var defaulting to `<data dir>/plugins` — read how `apps/web/lib/sandbox/config.ts` resolves its data/workspace dirs and follow the same convention; clone to a temp dir first, `discoverPlugin` there, and only move into place + `upsertPlugin({enabled: false, grantedCapabilities: []})` when the manifest is valid; the recorded `contentHash` is `hashDirectory` of the final tree; a plugin id that already exists → update in place (zero-customer ruling: no version-migration ceremony). Local source: same flow minus clone (copy). Failure paths return `{ok:false}` — never throw, never leave a half-installed directory (clean the temp dir in `finally`).

**Steps (TDD):** content-hash tests first (known fixture tree → stable hex; permutation of file creation order → same hash; .git skipped) → install tests with `kind:"local"` fixtures (valid plugin installs disabled+ungranted; invalid manifest → ok:false and nothing on disk/db; re-install updates) — github path is covered by unit-testing the argv builder (exported for tests as `buildCloneArgs(repo, ref)`) rather than cloning in CI → implement → commit: `Add plugin installer with content hashing`

---

### Task 5: `@paco/plugin-host` — worker process + RPC + grant enforcement

**Files:**
- Create: `packages/plugin-host/package.json`, `tsconfig.json` (same shapes as plugin-kit; depends on `@paco/plugin-kit": "workspace:*"`)
- Create: `packages/plugin-host/protocol.ts` (RPC message schemas)
- Create: `packages/plugin-host/host.ts` (spawn/kill/dispatch, grant checks)
- Create: `packages/plugin-host/worker-entry.ts` (what runs inside the plugin process)
- Create: `packages/plugin-host/index.ts` (named exports; worker-entry NOT exported — it is a spawn target, referenced by path)
- Test: `packages/plugin-host/host.test.ts`

**Interfaces:**

```ts
// protocol.ts — every message zod-validated at BOTH ends:
export const hostToWorkerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: "init", pluginId: z.string(), grantedCapabilities: z.array(capabilitySchema), slots: /* PluginDescriptor.slots shape */ }),
  z.object({ kind: "event", id: z.number(), chatId: z.string(), event: z.unknown() }),        // session event fan-out
  z.object({ kind: "invoke-tool", callId: z.string(), tool: z.string(), input: z.unknown() }),
  z.object({ kind: "capability-result", requestId: z.string(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }),
  z.object({ kind: "shutdown" }),
]);
export const workerToHostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: "ready", tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })) }),
  z.object({ kind: "capability-request", requestId: z.string(), capability: capabilitySchema, payload: z.unknown() }),
  z.object({ kind: "tool-result", callId: z.string(), ok: z.boolean(), output: z.unknown().optional(), error: z.string().optional() }),
  z.object({ kind: "log", level: z.enum(["info", "warn", "error"]), message: z.string() }),
]);
// host.ts
export interface CapabilityHandlers {  // supplied by the web app (Task 6/7/8) — the host only enforces, never implements
  [K in Capability]?: (pluginId: string, payload: unknown) => Promise<unknown>;
}
export class PluginHost {
  constructor(opts: { descriptor: PluginDescriptor; grantedCapabilities: Capability[]; handlers: CapabilityHandlers; nodeExecutable?: string });
  start(): Promise<{ tools: RegisteredTool[] }>;   // spawns, sends init, awaits ready (10s timeout → error)
  deliverEvent(id: number, chatId: string, event: unknown): void;      // fire-and-forget; only if events:subscribe granted
  invokeTool(tool: string, input: unknown, timeoutMs?: number): Promise<ToolOutcome>; // default 30s timeout
  stop(): Promise<void>;                            // shutdown message, then SIGKILL after 3s
  readonly state: "starting" | "running" | "crashed" | "stopped";
  onCrash(cb: (error: string) => void): void;
}
```

**Binding security semantics (the review will check these verbatim):**
- Spawn via `child_process.spawn(nodeExecutable ?? process.execPath, [workerEntryPath], { env: MINIMAL, stdio: ["pipe","pipe","pipe"] })` where MINIMAL is built from scratch: `{ PATH: process.env.PATH ?? "", PACO_PLUGIN_ID: pluginId }` and NOTHING else. Never spread `process.env`.
- A `capability-request` for a capability not in `grantedCapabilities` → respond `{ok:false, error:"capability not granted: <cap>"}` AND emit a host-side warn log; never reach the handler.
- A `capability-request` for a granted capability with no handler wired → `{ok:false, error:"capability not available"}`.
- Malformed JSON or schema-invalid messages from the worker: count them; after 5, kill the worker and set state "crashed".
- Worker exit (any code) while state is "running" → "crashed", `onCrash` fires; the host NEVER throws into its embedder from a background failure.
- `worker-entry.ts` loads slot files with dynamic `import()`, registers `tools/*` default exports of shape `{ name, description, inputSchema, execute(input, api) }`, where `api` = capability proxy (`api.fetch`, `api.kv.get/set`, `api.postMessage`, …) that turns calls into `capability-request` messages and awaits `capability-result`.

**Steps (TDD):** host tests use a REAL spawned worker with fixture plugins written to a tmp dir (a tool that echoes; a tool that calls `api.kv.set`; a hook that requests an ungranted capability; a worker that emits garbage; a worker that exits mid-run). Cover: ready handshake + tool registration; tool invoke round-trip; grant enforcement (denied + logged); malformed-flood kill; crash detection; env minimality (fixture tool returns `Object.keys(process.env)` — assert exactly `["PATH","PACO_PLUGIN_ID"]` modulo ordering); stop() graceful then forced. Implement protocol → worker-entry → host. Commit: `Add sandboxed plugin host with capability RPC`

---

### Task 6: Capability handlers — events:subscribe, messages:post, storage:kv, net:fetch

**Files:**
- Create: `apps/web/lib/plugins/capability-handlers.ts`
- Create: `apps/web/lib/plugins/event-fanout.ts`
- Modify: `apps/web/lib/db/schema.ts` — `pluginKv` table: `pluginId text` + `key text` (composite PK), `value jsonb`, `updatedAt`; FK pluginId → plugins.id cascade. Generate migration (ONLY this table).
- Test: `apps/web/lib/plugins/capability-handlers.test.ts`, `apps/web/lib/plugins/event-fanout.test.ts`

**Interfaces:**
- Produces `buildCapabilityHandlers(pluginRow): CapabilityHandlers` wiring:
  - `storage:kv` → payload `{op:"get"|"set"|"delete"|"list", key?, value?}` against pluginKv, scoped to pluginId (cross-plugin reads impossible by construction — pluginId comes from the host, never the payload).
  - `net:fetch` → payload `{url, method?, headers?, body?}`; parse URL, hostname must be an EXACT member of `manifest.netDomains` (no subdomain matching — a domain grant for `api.linear.app` does not cover `evil.api.linear.app` or `linear.app`); http(s) only; 10s timeout via AbortSignal.timeout; response truncated to 1MB; returns `{status, headers: {...}, bodyText}`.
  - `messages:post` → payload `{chatId, text}`; validates the chat exists, then reuses the EXACT code path the chat API route uses for message submission (import the same function the route calls — read `apps/web/app/api/chat/route.ts` and extract/reuse, do not duplicate; if a turn is active this lands as steer/buffered exactly like a user message — Section 1 Task 9 behavior, for free).
  - `events:subscribe` handled by fan-out, not request/response:
- `event-fanout.ts`: `class SessionEventFanout { constructor(pollMs = 1000); register(host: PluginHost, chatFilter?: string[]): void; unregister(host): void; start(): void; stop(): void }` — polls `listSessionEvents` per active chat with afterId cursors (reuse `listUnconsumedSteerEvents`'s underlying helper), delivers via `host.deliverEvent`. Polling is the Section-1-consistent choice (the steer monitor polls too); LISTEN/NOTIFY is a later optimization, not this plan.
- **Consistency rule:** `net:fetch` enforcement lives in the HANDLER (web app) — but the HOST also refuses ungranted capabilities (Task 5). Both layers check; the handler's check is authoritative for domain-level rules.

**Steps (TDD):** handler tests (kv scoping: two plugin ids, no cross-reads; net:fetch exact-hostname rule incl. the evil-subdomain case, non-http scheme rejected, timeout path; messages:post reuses the route path — assert the same function is called via mock) → fan-out tests (cursor advance, two hosts different filters, stop cleans timers) → implement → commit: `Add plugin capability handlers and event fan-out`

---

### Task 7: MCP bridge — plugin tools reach the agent

**Files:**
- Create: `apps/web/lib/plugins/mcp-bridge.ts`
- Create: `apps/web/scripts/plugin-mcp-server.ts` (a standalone stdio MCP server the CLI spawns; speaks MCP protocol, forwards tool calls to Paco over HTTP)
- Create: `apps/web/app/api/internal/plugin-tools/route.ts` (internal endpoint the bridge server calls; bearer-token auth reusing the approval-token pattern — read `apps/web/lib/agent/approvals/token.ts` and mirror it)
- Modify: `packages/claude-code/options.ts` — add `mcpServers?: Record<string, { command: string; args: string[]; env: Record<string,string> }>` to ClaudeCodeOptions; `buildArgs` emits `--mcp-config <json>` (inline JSON, same rationale as `--settings`) when set. `--strict-mcp-config` STAYS — that is the reproducibility contract.
- Modify: `packages/claude-code/backend.ts` — capabilities() returns `mcp: true`; `ClaudeBackendOptions` carries mcpServers through.
- Modify: `apps/web/lib/agent/run-step.ts` — thread `mcpServers` from AgentCallOptions into backendOptions.
- Test: `packages/claude-code/options.test.ts` (extend: mcp-config arg emission), `apps/web/lib/plugins/mcp-bridge.test.ts`

**Interfaces:**

```ts
// mcp-bridge.ts
export function buildPluginMcpConfig(enabled: Array<{ id: string; manifest: PluginManifest; tools: RegisteredTool[] }>, opts: { internalUrl: string; token: string }):
  Record<string, { command: string; args: string[]; env: Record<string, string> }>;
// One entry "paco-plugins" running scripts/plugin-mcp-server.ts (via the bundled node) exposing every enabled plugin's registered tools,
// PLUS each manifest.mcpServers entry passed through verbatim namespaced as "<pluginId>-<name>".
```

The internal route: POST `{pluginId, tool, input}` → looks up the running PluginHost registry → `invokeTool` → returns `{ok, output|error}`. The plugin host registry is a module-level singleton in `apps/web/lib/plugins/registry.ts` (Create it here): `getPluginRegistry(): Map<string, PluginHost>` + `ensurePluginsStarted()` lazily starting hosts for enabled plugins (mirror how other lazy singletons in the app are built — grep for `globalThis` singletons in apps/web/lib and follow the pattern; the workflow/dev server restarts must not double-start).

**Steps (TDD):** options.test extension first (no mcpServers → no flag, unchanged argv; with → `--mcp-config` with exact JSON, `--strict-mcp-config` still present) → bridge config builder tests (namespacing, env carries token) → internal route test (auth required; unknown plugin 404; happy path calls invokeTool) → implement, including the standalone MCP server script (protocol: implement initialize/tools list/tools call over stdio JSON-RPC per MCP spec — keep it minimal, no SDK dependency; if an `@modelcontextprotocol/sdk` version is already in the lockfile, prefer it) → commit: `Bridge plugin tools to the agent over MCP`

---

### Task 8: Skills + agents slots into the chat environment

**Files:**
- Modify: `apps/web/lib/agent/chat-environment.ts` (where skills/agents for a chat are assembled — read it first; skill discovery currently comes from the workspace via @paco/sandbox)
- Create: `apps/web/lib/plugins/contributions.ts`
- Test: `apps/web/lib/plugins/contributions.test.ts`

**Interfaces:**

```ts
export async function pluginSkillContributions(): Promise<SkillMetadata[]>;  // every enabled plugin's skills/*/SKILL.md, parsed with the EXISTING parser (packages/sandbox skills types), path pointing into the plugin dir
export async function pluginAgentContributions(): Promise<Record<string, ClaudeAgentDefinition>>; // agents/*.json validated against a zod mirror of ClaudeAgentDefinition; invalid file → skipped with console.error, never fatal
```

Wire both into the chat environment: skills concat (plugin skills after workspace skills; name collisions → workspace wins, log a warn), agents merged into the roster passed to the backend (DEFAULT_AGENTS ∪ plugin agents; collisions → DEFAULT_AGENTS win). System prompt already lists skills (Section 1's system-prompt.ts) — plugin skills flow through the same list.

**Steps (TDD):** contribution tests with fixture plugin dirs (valid skill parsed; invalid frontmatter skipped; agent json validated; collision rules both directions) → wire → run the chat-environment tests → commit: `Surface plugin skills and agents in the chat environment`

---

### Task 9: Consent + management server actions

**Files:**
- Create: `apps/web/app/settings/plugins/actions.ts` ("use server" actions; auth-guard as other settings actions do — read `apps/web/app/settings/` siblings for the exact session/admin check helper and reuse it; plugin management is ADMIN-only, mirror how admin settings gate)
- Test: `apps/web/app/settings/plugins/actions.test.ts`

**Interfaces:**

```ts
export async function installPluginAction(input: { source: string }): Promise<{ ok: boolean; requested?: Capability[]; error?: string }>;
// source string forms: "owner/repo", "owner/repo#ref", "local:/abs/path" → parsed to InstallSource
export async function grantAndEnableAction(input: { pluginId: string; grants: Capability[] }): Promise<{ ok: boolean; error?: string }>;
// sets grants (subset validation via setPluginGrants), enables, starts the host via registry, returns first-start errors
export async function disablePluginAction(input: { pluginId: string }): Promise<{ ok: boolean }>; // stops host, sets enabled false
export async function removePluginAction(input: { pluginId: string }): Promise<{ ok: boolean }>;  // disable + rm -rf plugin dir + row
```

**Steps (TDD):** action tests (admin gate enforced — non-admin rejected; install→disabled+ungranted; grant subset rule; enable starts host (registry mocked); remove cleans dir+row) → implement → commit: `Add plugin management server actions`

---

### Task 10: Plugins settings page

**Files:**
- Create: `apps/web/app/settings/plugins/page.tsx`, `plugin-card.tsx`, `install-dialog.tsx`, `consent-dialog.tsx`, `loading.tsx`
- Modify: `apps/web/app/settings/layout.tsx` (add the Plugins nav entry — read how existing entries are declared)
- Test: component test colocated, following the pattern of existing settings section tests (e.g. `apps/web/app/settings/users/users-table.test.tsx`)

**Requirements:** Read `.agents/skills/daisyui/SKILL.md` BEFORE writing any JSX, and build with daisyUI components/tokens like the rest of the settings pages (read two sibling settings pages first and match their structure). The page lists installed plugins (name, version, source, enabled toggle, granted capabilities as badges, update/remove). Install flow: dialog takes `owner/repo[#ref]` → runs installPluginAction → CONSENT step renders the REQUESTED capabilities with a plain-language line per capability (write these six lines carefully — they are the security UX: e.g. `net:fetch` shows the exact domain list from the manifest) → user checks/unchecks grants → grantAndEnableAction. Enabled toggle calls disable/grantAndEnable. Errors surface inline (match existing settings error presentation).

**Steps:** failing component test (renders plugin rows from fixture data; consent dialog lists requested capabilities and the domain list; toggling calls the action) → implement page + components → `bun test` the colocated tests → commit: `Add the Plugins settings page with capability consent`

---

### Task 11: Renderers — sandboxed tool-call panels

**Files:**
- Create: `apps/web/app/api/plugins/renderer/[pluginId]/[file]/route.ts` (serves a plugin's `renderers/*.html` with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'` and `X-Frame-Options` removed only for same-origin embedding)
- Create: `apps/web/components/tool-call/renderers/plugin-renderer.tsx` (an `<iframe sandbox="allow-scripts">` pointing at that route, feeding the tool call payload via postMessage on load; height-clamped; no allow-same-origin — the iframe must NOT reach Paco's origin storage/cookies)
- Modify: `apps/web/app/lib/render-tool.tsx` — route a tool call whose name matches an enabled plugin's registered renderer (convention: renderer file named `<toolName>.html`) to PluginRenderer; otherwise unchanged fallback.
- Test: route test (unknown plugin 404; path traversal `..%2f` rejected — resolve and verify the file stays under the plugin's renderers dir; CSP header exact) + component test (iframe has sandbox attr WITHOUT allow-same-origin; postMessage payload shape).

**Steps:** TDD as above → commit: `Render plugin tool calls in sandboxed iframes`

---

### Task 12: Lifecycle integration + degradation notices

**Files:**
- Modify: `apps/web/lib/plugins/registry.ts` (from Task 7): `ensurePluginsStarted()` called from the chat workflow's sandbox-provisioning step (read `apps/web/app/workflows/sandbox-provisioning.ts` and add alongside, so plugins are up before the first turn) and instrumentation startup (`apps/web/instrumentation.ts` — read first; follow what it already does at boot).
- Crash → notice: on `onCrash`, append a `plugin/crashed`-shaped console.error AND insert a row via the existing health/notice mechanism IF one exists (read `apps/web/lib/health/` — if there is an operator-notice store, use it; otherwise log only and surface state on the Plugins page via `state` from the registry).
- Modify: `apps/web/app/settings/plugins/page.tsx` — show host state per plugin (running/crashed/stopped) from a `pluginStatusAction`.
- Test: registry test (double ensure → single start; crashed plugin restarts on next ensure with backoff of 3 attempts max then stays crashed).

**Steps:** TDD → commit: `Start plugin hosts with the app and surface crash state`

---

## Final verification
- [ ] `pnpm run ci` at repo root; fix everything it surfaces.
- [ ] Manual smoke per docs/contributing.md dev setup: install the fixture plugin from a local path, grant, enable, see its tool registered, run a chat turn that calls it, watch the renderer panel, kill the worker process manually and see crashed state surface.
