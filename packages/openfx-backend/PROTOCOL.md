# OpenFX ACP protocol map

Source read: `/Users/rbonweb/Desktop/stack256-workspace/openfx`, checked out at
commit `984941b` (`src/acp` last touched at `16f0bcc7`). Every claim below cites
`openfx/<path>:<line>`. Where the source doesn't say something, this document
says "not found" rather than guessing.

## 1. Invocation

The ACP server is a CLI subcommand of the single `openfx` binary, run over its
own stdio — there is no separate daemon and no network listener.

```
openfx acp [--model <id>] [--log-file <path>]
```

- Subcommand recognized in `openfx/src/core/cli/cli_surface.zig:474` (`.acp`
  variant) and dispatched at `openfx/src/core/cli/cli_surface.zig:912-951`.
- Flags parsed by `parseAcpArgs` (`openfx/src/core/cli/cli_surface.zig:3222-3236`):
  only `--model` and `--log-file` are recognized; anything else is a usage
  error (`openfx/src/core/cli/cli_surface.zig:913-916`, usage string at :914).
  **No `--port`, `--socket`, or transport flag exists** — stdio is the only
  transport.
- The subcommand hands off to `acp_server.run(alloc, cfg)`
  (`openfx/src/main.zig:3419-3420`), which is `openfx/src/acp/server.zig:646-648`
  and always wires `jsonrpc.Reader.init()` / `jsonrpc.Writer.init()`, i.e. real
  stdin/stdout (`openfx/src/acp/jsonrpc.zig:163-164` reads via `read(2)` on
  `STDIN_FILENO`; `openfx/src/acp/jsonrpc.zig:196` writes via
  `std.Io.File.stdout()`).
- **Working directory is bound once, at `initialize` time, from the process's
  own cwd** — there is no per-session or per-request cwd parameter anywhere in
  `session/new` (confirmed by reading `mcp_servers.parse`, the only params
  reader in `handleNewSession`, `openfx/src/acp/sessions.zig:128-142`) or in
  `parseAcpArgs`. `state.workspace_root` is set once in `handleInitialize`
  (`openfx/src/acp/server.zig:1300,1342`) from
  `loadConfiguredStartupState`/`app_lifecycle.loadStartupState`
  (`openfx/src/acp/server.zig:1290-1300`), which resolves the workspace from
  the process's actual working directory, not a protocol field. **Consequence
  for Task 2/4: one `openfx acp` process serves exactly one workspace root —
  Paco must `cwd`-launch a process per chat worktree, not multiplex chats
  through one long-lived server.**
- The session store itself is workspace-scoped: `handleNewSession` opens
  `session_store.Store.init(alloc, state.workspace_root)`
  (`openfx/src/acp/sessions.zig:169`, same call for resume at
  `openfx/src/acp/sessions.zig:524`), and `resumeForExternalPrompt` takes
  `workspace_root` as an explicit parameter
  (`openfx/src/core/subagent/resume_admission.zig:191-213`). So a session id
  is only resumable from a process launched with the **same** cwd that created
  it.

### Provider / credential environment variables

- `OPENFX_MODEL` — process-wide model override, read at config-load time
  (`openfx/src/core/config/config_runtime.zig:442-444`); same override class
  as `--model`.
- `VERCEL_OIDC_TOKEN`, `AI_GATEWAY_API_KEY` — Vercel AI Gateway credentials,
  read via `loadEnvCredential` (`openfx/src/core/auth/credentials.zig:413-414`,
  `465-474`).
- `OLLAMA_API_KEY` — read at `openfx/src/core/auth/ollama_key.zig:75`.
- `OPENFX_SECRET_STORE=keychain` / `OPENFX_DISABLE_KEYCHAIN=1` — select the
  macOS Keychain vs. the default `~/.openfx` file-mode-0600 secret store
  (`openfx/src/core/hosts/native_keychain.zig:67,87`).
- `HOME` — read pervasively to locate `~/.openfx` (e.g.
  `openfx/src/core/auth/credentials.zig:487`,
  `openfx/src/acp/sessions.zig:597` session-usage init); must be set for the
  ACP process to find its profile.
- ChatGPT/Codex and Grok OAuth sessions are file-based
  (`~/.openfx/chatgpt-auth.json`, `~/.openfx/grok-auth.json` per
  `openfx/README.md`) — not env vars; if Paco wants a Gateway-only backend it
  should force `credential_override`/`AI_GATEWAY_API_KEY` rather than rely on
  interactive `openfx login`.
- `cfg.credential_override` (an `acp_runner.Config` field,
  `openfx/src/core/cli/acp_runner.zig:49`) lets an embedder inject a Gateway
  API key directly, consumed at `openfx/src/acp/server.zig:1359-1364` — but
  this is a Zig struct field on the **embedded SDK config**, not something
  reachable from the `openfx acp` CLI's flags (`parseAcpArgs` only exposes
  `--model`/`--log-file`). Reaching it from a spawned CLI process means going
  through the plain env vars above instead.

## 2. Framing

Newline-delimited JSON-RPC 2.0 over stdio. Not Content-Length-header framing
(no such code exists anywhere in `openfx/src/acp/jsonrpc.zig`).

- Inbound: `Reader.readLine` accumulates bytes from raw `read(2)` until a
  `\n` (`openfx/src/acp/jsonrpc.zig:220-232` `findNewline`), then
  `jsonrpc.parseMessage` parses that one line as one JSON value
  (`openfx/src/acp/jsonrpc.zig:63-105`).
- A single line/frame is capped at `frame_resource_byte_limit = 8 * 1024 *
  1024` bytes (`openfx/src/acp/jsonrpc.zig:130`); an oversized frame is
  drained and reported as a `-32000` `"Request frame too large"` error, not a
  parse error (`openfx/src/acp/jsonrpc.zig:31`,
  `openfx/src/acp/server.zig:681-687`).
- Outbound: `Writer.writeFrame` serializes one JSON object per call and always
  appends a single trailing `\n` (`openfx/src/acp/jsonrpc.zig:296,306,313,321`
  — one call site per frame kind: response/error/notification/request).
- Standard JSON-RPC 2.0 envelope: `{"jsonrpc":"2.0", ...}` is written on every
  outbound frame (`openfx/src/acp/jsonrpc.zig:296` etc.) but is **not**
  required or checked on inbound messages — `parseMessage` never reads a
  `"jsonrpc"` key (`openfx/src/acp/jsonrpc.zig:63-105`).
- Request ids are integer, string, or null (`openfx/src/acp/jsonrpc.zig:39-43`).
- Error codes: `parse_error=-32700`, `invalid_request=-32600`,
  `method_not_found=-32601`, `invalid_params=-32602`,
  `internal_error=-32603`, plus the OpenFX-specific
  `request_frame_too_large=-32000` (`openfx/src/acp/jsonrpc.zig:30-37`).

## 3. Message catalog

Method dispatch table: `openfx/src/acp/server.zig:56-90` (`AcpMethod.parse`,
`waitsForActivePrompt`). All request methods below are client→server unless
noted; `session/update` and `session/request_permission` are server→client.

| Method | Direction | Params (real field names) | Result / notes | Cite |
|---|---|---|---|---|
| `initialize` | req | `protocolVersion` (int), `clientCapabilities.fs.{readTextFile,writeTextFile}` (bool), `clientCapabilities.terminal` (bool), elicitation caps | `{protocolVersion:1, agentCapabilities:{loadSession:true, promptCapabilities:{image:false,audio:false,embeddedContext:true}, mcpCapabilities:{http:true,sse:true}, sessionCapabilities:{list:{},resume:{},close:{}}}, agentInfo:{name:"fx",title:"fx",version}, authMethods:[]}` | params: `server.zig:1252-1281`; response: `types.zig:180-192` |
| `session/new` | req | `mcpServers: McpServer[]` (optional; empty if omitted) | `{sessionId, configOptions:[provider?,model,mode], modes:{currentModeId, availableModes}}`, then a `session/update` `available_commands_update` notification | request: `sessions.zig:128-240`; mcpServers parse: `mcp_servers.zig:70-93`; response: `sessions.zig:246-278` |
| `session/load` | req | `sessionId`, `mcpServers?` | Replays full history as `session/update` notifications, then `{configOptions, modes}` (**no `sessionId` in the response body**) | `sessions.zig:415-417,422-509,689-716` |
| `session/resume` | req | `sessionId`, `mcpServers?` | Same as `load` but does **not** replay history (`RestoreKind.reconnect`) | `sessions.zig:419,406-413` |
| `session/close` | req | `sessionId` | `{}` on success; error if `sessionId` doesn't match the active session | `server.zig:1475-1520` |
| `session/list` | req | — | `[{sessionId, cwd}, ...]` | `sessions.zig:892-925` |
| `session/remove` | req | `sessionId` | **WASM build only** — the native dispatch table has no case for it and returns `method_not_found` | `server.zig:1128-1145` (native switch omits `.session_remove`); wasm impl at `sessions.zig:397-405` |
| `session/prompt` | req | `sessionId`, `prompt: ContentBlock[]` where block `type` is `"text"` (`text`), `"resource"` (`resource.uri`, `resource.text`), or `"image"` (**rejected**: `error.UnsupportedPromptImage`); optional `_meta.fx.continueRecovery` | `{stopReason}` — one of `end_turn, max_output_tokens, max_model_turns, refused, cancelled` — resolved only after the turn's `session/update` stream completes | parse: `prompt.zig:811-900`; response: `types.zig:61-77,194-198`; dispatch/threading: `server.zig:1148-1178` |
| `session/cancel` | notif or req | `sessionId` (ignored — cancels whatever session is active) | Sets a cancel flag read by the running turn; if sent as a request, responds `null` immediately (does not wait for the turn to actually stop) | `server.zig:1078-1086` (notification path), `1101-1104` (request path), `1461-1467` (`handleCancel`) |
| `session/set_config_option` | req | `configId` (string), `value` (string) — only `"model"`, `"provider"`, `"mode"` are recognized | `configOptions`-shaped payload, or error; unsupported `configId` values are silently accepted or rejected depending on branch (no catch-all "unknown configId" case was found) | branches at `server.zig:1551` (`model`), `+108` (`provider`), `+226` (`mode`) relative to `handleSetConfigOption` starting at `server.zig:1524` |
| `session/set_mode` | req | `modeId` (string) | `null`; sets `session.mode` **and** `session.permission_mode` from the mode registry entry | `server.zig:1857-1878` |
| `session/update` | notif (server→client) | `{sessionId, update: {...}}` | Envelope for every streamed event below | `types.zig:121-127` |
| ↳ `agent_message_chunk` | — | `content:{type:"text",text}` | Incremental assistant text (see §4) | `types.zig:129-133` |
| ↳ `user_message_chunk` | — | `content:{type:"text",text}` | Used when replaying history on `session/load` | `types.zig:135-139` |
| ↳ `tool_call` | — | `toolCallId,title,kind,status:"pending"` | `kind` ∈ `read,edit,delete,move,search,execute,think,fetch,other` | `types.zig:79-103,141-151` |
| ↳ `tool_call_update` | — | `toolCallId,status,content?,command_result?` | `status` ∈ `pending,in_progress,completed,failed` | `types.zig:105-119,153-178` |
| ↳ `available_commands_update` | — | `availableCommands: [...]` | Slash-command catalog | `types.zig:200-204` |
| ↳ `session_info_update` (model recovery) | — | `_meta.fx.modelResponseRecovery:{state,kind,cause?,action?,requiredAction?,attempt?,attemptLimit?,delaySeconds?,durable,message}` | Provider-outage/backoff status, **not** a token-usage report | `types.zig:11-59` |
| `session/request_permission` | req (server→client) | `sessionId, toolCall:{toolCallId,title,kind,status:"pending",rawInput}, options:[{optionId,name,kind}]` | Client answers with a normal JSON-RPC response (see §5) | `prompt.zig:1299-1349` |
| `elicitation/complete` | notif (server→client) | `{elicitationId}` | MCP elicitation completion signal | `server.zig:1040-1048` |

No method or notification carries token counts or cost anywhere in this
table — see §6.

## 4. Lifecycle

```
client                              openfx acp (spawned with cwd = workspace)
  |--- initialize -------------------->|  (binds workspace_root, resolves credential)
  |<-- {agentCapabilities,...} --------|
  |--- session/new {mcpServers} ------>|  (creates on-disk session, starts MCP servers)
  |<-- {sessionId, configOptions, ...}-|
  |<-- session/update available_commands_update
  |--- session/prompt {sessionId, ---->|  (spawns a worker thread; only one
  |     prompt:[...]}                  |   in-flight prompt per session --
  |                                     |   a second session/prompt while one
  |                                     |   is active gets invalid_request
  |                                     |   "Prompt already in progress")
  |<-- session/update agent_message_chunk (repeated, streamed per markdown-
  |                                        normalized provider chunk)
  |<-- session/update tool_call (pending)
  |<-- session/request_permission ---->|  (see §5; only if policy can't auto-decide)
  |<-- decision (JSON-RPC response) ---|
  |<-- session/update tool_call_update (in_progress / completed / failed)
  |<-- {stopReason:"end_turn"} --------|  (this is the session/prompt RESPONSE)
```

- The client knows a turn ended when the **response to its `session/prompt`
  request** arrives, carrying `stopReason` — not by watching for the last
  `session/update` (`server.zig:1194-1204` `publishPromptOutcome`).
- Only one prompt may be active per session; `session/prompt`,
  `session/set_config_option`, `session/list` sent while one is in flight get
  `invalid_request` `"Prompt already in progress"`
  (`server.zig:1105-1110`, `waitsForActivePrompt` table at `server.zig:78-90`).
- **Resume**: sessions are **not** per-process. `session/new` durably writes
  session state under the workspace-scoped session store
  (`sessions.zig:154-179`); a brand-new `openfx acp` process launched with the
  **same cwd** can reattach via `session/load` (replays history) or
  `session/resume` (does not) using only the `sessionId` string
  (`sessions.zig:406-509`). There is no separate "resume token" — the
  `sessionId` itself is the durable handle. This is real persistence, not an
  in-memory map: `resumeForExternalPrompt` reads from
  `session_store.Store` on disk (`openfx/src/core/subagent/resume_admission.zig:191-217`).
- Ending the connection: no explicit "shutdown" RPC exists. The read loop
  exits on stdin EOF (`server.zig:679-683`, `reader.readLine` returning
  `null`) or on an internal unrecoverable-persistence error that sets
  `state.terminate_connection` (`server.zig:1611-1617,1737-1740` — both are
  disk-write failure paths, not a designed shutdown handshake). A client is
  expected to close stdin and/or kill the process.

## 5. Permission flow

- The server does **not** ask the client for every tool call. Each active
  session carries a `permission_mode` (`ask` / `auto` / `yolo`, per
  `openfx/docs/stability.md`), and a rule/auto-classifier layer
  (`openfx/src/core/tooling/tool_admission.zig:1157-1230`,
  `permission_auto_classifier.Provider` fields on `acp_runner.Config` at
  `openfx/src/core/cli/acp_runner.zig:44-47`) decides many calls internally
  before ever reaching the wire. **A policy can auto-answer**: in `auto` or
  `yolo` mode (or for any tool without a permission contract, see
  `requestPermissionOutcomeResolved`'s `ordinaryPermissionOutcome(.once)`
  fast path at `openfx/src/core/tooling/tool_admission.zig:1205-1212`), no
  `session/request_permission` round-trip happens at all.
- When the internal policy can't decide, the server sends a real JSON-RPC
  **request** (not a notification) to the client:
  `session/request_permission` with
  `{sessionId, toolCall:{toolCallId,title,kind,status:"pending",rawInput},
  options:[{optionId:"allow_once",...},{optionId:"allow_always",...},
  {optionId:"reject_once",...}]}` (`openfx/src/acp/prompt.zig:1299-1349`,
  option construction at `prompt.zig:1332-1336`).
- The client's response is an ordinary JSON-RPC result:
  `{"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}` or
  `{"outcome":{"outcome":"cancelled"}}`
  (`openfx/src/acp/jsonrpc.zig` test fixture, and parsed by
  `parsePermissionDecision`, `openfx/src/acp/server.zig:846-859`). `optionId`
  maps to `once` / `always` / `deny`; `outcome:"cancelled"` and any
  unrecognized shape are treated as `deny`
  (`openfx/src/acp/server.zig:855,858-859`).
- `session/set_mode {modeId}` lets the client switch the active mode, which
  changes `session.permission_mode` server-side
  (`openfx/src/acp/server.zig:1857-1878,1882-1886`, test proving the
  mode→permission_mode mapping at `server.zig:1887-1926`). This is how a
  client-side policy (e.g. Paco's `decideApproval`) could pre-select "never
  ask" behavior for a whole turn, as an alternative to answering each
  `session/request_permission` individually.

## 6. Usage / cost

**Not found on the wire.** `session/prompt`'s response is exactly
`{"stopReason": "..."}` with no other fields
(`openfx/src/acp/types.zig:194-198`), and none of the `session/update` kinds
in §3 carry token or cost data (`session_info_update` carries provider-outage
recovery state, not usage — `openfx/src/acp/types.zig:11-59`). Internally the
binary tracks `total_cost`, `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` per generation
(`openfx/src/acp/prompt.zig:2728-2737`, test fixture) and persists
`total_input_tokens`/`total_output_tokens` into the on-disk session file
(`openfx/src/acp/sessions.zig:108-110,721-723`), but none of that is
serialized into any ACP request, response, or notification anywhere in
`src/acp/`. An `OpenFxBackend` has no ACP-native way to populate
`TurnResult.usage` or `.costUsd` — per the plan's own allowance, those fields
must report zeros.

## 7. Mapping to AgentBackend

| `TurnHandle`/`BackendCapabilities` clause | ACP mechanism | Notes |
|---|---|---|
| `chunks` (text) | `session/update` → `agent_message_chunk` | Real incremental deltas: the provider stream is fed through a markdown-normalizing chunker and re-emitted per resolved chunk (`openfx/src/core/agent/runtime/assistant_stream.zig:282-361`), not one shot at the end. Maps to `UIMessageChunk` text-start/delta/end the way `packages/claude-code/ui-stream.ts` does for its own streamed text (verify exact chunk boundaries in Task 3). |
| `chunks` (tool calls) | `tool_call` (pending) → `tool_call_update` (in_progress/completed/failed) | `kind` and `status` enums give real lifecycle state (`types.zig:79-119`); `rawInput`/`content`/`command_result` give arguments and output. |
| `chunks` (reasoning/thoughts) | **not found** | No `agent_thought_chunk` or equivalent kind exists anywhere in `src/acp/*.zig`. OpenFX's ACP surface does not expose model "thinking" separately from rendered text. |
| `result` (finishReason) | `session/prompt` response `stopReason` | `end_turn`→normal completion; `max_output_tokens`/`max_model_turns`→length-limited; `refused`→model refusal; `cancelled`→see interrupt row. (`types.zig:61-77`) |
| `interrupt()` → `AbortError` | `session/cancel` (notification), then kill the process | ACP itself does **not** signal cancellation as a JSON-RPC error — a cancelled turn still gets a normal `{"stopReason":"cancelled"}` response (`server.zig:1461-1467`, `types.zig:66,74`). The backend must treat `stopReason:"cancelled"` (or the process dying before responding) as the trigger to reject `result` with an `AbortError` itself; ACP gives no error object to rethrow. |
| `steer(text)` → `"restart"` | `session/cancel` + a fresh `session/prompt` with the new text | No ACP method injects text into a running prompt. `session_rt.history` isn't touched by cancel, so a same-session `session/prompt` right after cancel is the correct "restart" — same shape as `ClaudeCodeBackend`'s steering. |
| Abandonment ⇒ `interrupt()` | Same `session/cancel` + kill path, run as a `finally` guard | Killing the child process is safe because the session survives on disk (§4) and can be resumed later if the chat needs it, but Paco's contract treats abandonment as a hard interrupt, not a resume opportunity. |
| `capabilities().resume` | `session/load` / `session/resume` by `sessionId`, workspace-scoped | **`true`**, but only when the backend re-launches the process with the *same cwd* that created the session (`sessions.zig:169,524`; `resume_admission.zig:191-213`). The `resumeToken` in `TurnContext` should be OpenFX's `sessionId`. |
| `capabilities().mcp` | `session/new`/`session/resume` `mcpServers` array; stdio (`command`/`args`/`env`, absolute path required) and remote (`type:"http"`/`"sse"`, `url`/`headers`) transports | **`true`**. Parser and transport discriminant: `openfx/src/acp/mcp_servers.zig:177-193` (`type` field selects http/sse), `:195-221` (stdio, requires `std.fs.path.isAbsolute` command). `initialize`'s `mcpCapabilities:{http:true,sse:true}` (`types.zig:186`) only advertises the two remote transports even though stdio is also accepted — undocumented asymmetry, worth a defensive note in Task 2. |
| `capabilities().effort` | `session/set_config_option` | **`false`**. `configId` only recognizes `"model"`, `"provider"`, `"mode"` (`server.zig:1551,+108,+226`); reasoning effort (`types.ReasoningEffort`, default `.auto`) exists as internal per-session state (`sessions.zig:74-75,222,350...`) but has no ACP setter. |
| `capabilities().subagents` | Internal only, surfaced as ordinary `tool_call`/`tool_call_update` | **`true`** in the sense that the binary does run a subagent roster (`subagent_host`, wired at `openfx/src/acp/server.zig:506-522`, invoked from `prompt.zig:640-696`) — but ACP gives the client no dedicated method or `session/update` kind for subagent visibility; a subagent run is indistinguishable on the wire from any other tool call. Flag this caveat in the backend's own capability doc. |
| `capabilities().steering` | see `steer()` row | `"restart"`, matching `ClaudeCodeBackend`. |

## 8. Gaps & risks

1. **No usage/cost on the wire** (§6) — `TurnResult.usage`/`.costUsd` will be
   zeros for every OpenFX turn unless a future OpenFX release adds it.
2. **No reasoning/thought streaming** (§7) — any UI affordance for "thinking"
   text has nothing to render for this backend.
3. **Process-per-workspace binding, not stated in any doc** — `workspace_root`
   is fixed at `initialize` from process cwd (§1), and the session store is
   workspace-scoped (§1, §4). This is inferred from code, not documented
   anywhere in `README.md`, `llms.txt`, or `docs/stability.md`; it could
   change without notice.
4. **`docs/stability.md` never mentions ACP explicitly.** It calls out
   settings/config keys, session files, and the SDK (`libopenfx`, version
   `0.0.0`) as unstable-by-design (`openfx/docs/stability.md:14-22`), but says
   nothing about the ACP JSON-RPC surface itself — no promise it's stable,
   no promise it isn't. Treat every method/field name in this document as
   subject to change between OpenFX releases; **pin the OpenFX binary
   version** Paco spawns and re-verify this map before bumping it.
5. **`session/remove` is unreachable from a native build** (§3) — only the
   WASM code path implements it; the CLI's native dispatch returns
   `method_not_found`. Don't build `OpenFxBackend` features on it.
6. **Permission-cancel ambiguity**: a client cancelling a pending
   `session/request_permission` and a client explicitly rejecting are both
   reported as the same `deny` outcome server-side (§5) — no distinction is
   preserved for auditing.
7. **`session/set_config_option`'s unknown-`configId` behavior is
   inconsistent** across branches — some early-return with `invalid_params`,
   but the sequence of `if/else if` means an entirely unrecognized `configId`
   falls through without an obvious explicit final-else in the excerpt read;
   Task 2 should send a deliberately-bad `configId` against a live binary and
   confirm the exact error before relying on it.
8. **Binary/agent identity still says `"fx"`** — `agentInfo.name`/`title` are
   hardcoded to `"fx"` (`types.zig:188`), a leftover from the pre-rename fork;
   harmless, but don't pattern-match on it if OpenFX ever finishes renaming
   internals.
9. **Everything here was read from source, not exercised against a running
   `openfx acp` process** — Task 1 is a reading task per the plan's global
   constraints. Task 2's stub-server fixture is the first point this map gets
   checked against real bytes on the wire; if the checked-out `openfx`
   binary can't actually be built/run in this environment, Task 2 should
   flag that immediately rather than writing a fixture from guesswork.

### Verdict

**ACP is usable for a backend: YES.** The protocol is a real, working
newline-delimited JSON-RPC 2.0 surface over stdio, with a genuine session
lifecycle (new/load/resume/close), real incremental text and tool-call
streaming, and a permission-request round-trip that maps directly onto
Paco's existing `decideApproval`-driven approval flow (§5, §7). The honest
capability set is `{id:"openfx", resume:true, steering:"restart", mcp:true,
effort:false, subagents:true}` (subagents caveated per §7). The two real
costs are (a) no usage/cost reporting, so those fields are always zero, and
(b) the protocol carries no stability guarantee at all (§8.4) — this map
must be re-validated against the exact OpenFX binary version Paco ships.
