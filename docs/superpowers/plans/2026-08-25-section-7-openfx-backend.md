# Section 7: OpenFX Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@paco/openfx-backend` — the second `AgentBackend`, driving the OpenFX binary over ACP, passing the Section 1 conformance suite, selectable per-chat, with BYO endpoint/key model settings. This is the proof the seam is real and the exit from single-vendor dependency.

**Architecture:** OpenFX (../openfx in the workspace, also installable from apt.stack256.org) ships an ACP server mode. The backend spawns `openfx` in ACP mode per turn (or connects to a persistent process per chat — decide in Task 1 from OpenFX's actual ACP lifecycle docs), translates ACP session updates into `UIMessageChunk`s, maps ACP permission requests onto Paco's approval flow (the same decideApproval policy — approvals stay backend-agnostic), and reports capabilities honestly: `{id:"openfx", resume: <per ACP docs>, steering: "restart", mcp: true-if-ACP-exposes-it-else-false, effort: false-unless-supported, subagents: false-unless-supported}`.

**Spec:** `docs/superpowers/specs/2026-08-25-paco-platform-design.md` (Section 7). Depends on Section 1. Model config: OpenFX is model-agnostic (Vercel AI Gateway et al.) — Paco stores per-org OpenFX provider config (endpoint/key) encrypted with the existing secret-box (`apps/web/lib/crypto/secret-box.ts`).

> **Correction, recorded after implementation.** This plan promised a
> "BYO endpoint" for OpenFX in its Goal and Spec lines below. That is NOT
> delivered, and cannot be as written: the OpenFX binary's ACP protocol has
> no wire field for an endpoint override — `buildOpenFxBackendConfig` has
> nowhere to put it. The setting is stored and the input is rendered
> permanently disabled with a caption saying so, rather than silently
> accepting a value that goes nowhere. The API key and binary path DO work.
> Left in the plan rather than edited out, because the plan is the record of
> what was intended; this note is the record of what shipped.

## Global Constraints

- Section 1 plan's Global Constraints apply. Zero-customer ruling. Nothing deferred.
- **Definition of done for the backend: `runBackendConformance` passes against it** (with a stub ACP server fixture — a small Node script speaking enough ACP over stdio, mirroring how packages/claude-code tests stub the CLI).
- RESEARCH-FIRST RULE: Task 1 is a reading task producing a written protocol map from the ACTUAL OpenFX source in `/Users/rbonweb/Desktop/stack256-workspace/openfx` (docs/, sdk/, src/ — ACP server implementation). Every later task cites that map, not assumptions. If OpenFX's ACP support turns out to be absent or unusable in the checked-out version, STOP and report — do not fake a protocol.

---

### Task 1: Protocol map (research, written artifact)

**Files:**
- Create: `packages/openfx-backend/PROTOCOL.md`

Read /Users/rbonweb/Desktop/stack256-workspace/openfx: README, docs/, `rg -l "acp|ACP" src sdk docs`, the ACP server entry point, message schemas, session lifecycle (new/load/resume), update/permission/cancel messages, how a turn ends, how text/tool-call updates stream, auth/provider env vars, exact CLI invocation for ACP mode. Write PROTOCOL.md: invocation line, JSON framing, message catalog with real field names (cite file:line in the openfx repo), lifecycle sequence diagram (text), resume semantics, permission-request flow, cancellation, and a "gaps/risks" section. NO code in this task.
Commit: `Map the OpenFX ACP protocol`

### Task 2: Package + transport + stub fixture

**Files:** `packages/openfx-backend/{package.json,tsconfig.json,acp-client.ts,index.ts}` (shapes mirror @paco/agent-backend; dependency on it workspace:*), `test/stub-acp-server.ts` fixture, `acp-client.test.ts`.
`AcpClient`: spawn per PROTOCOL.md, newline/framed JSON per the real framing, request/response correlation, update subscription, cancel, kill; errors surfaced as typed AcpError. Tests against the stub (which replays scripted PROTOCOL.md-accurate messages; slow-mode for cancellation tests).
Commit: `Add the OpenFX ACP transport`

### Task 3: Chunk mapping

**Files:** `packages/openfx-backend/chunk-mapper.ts` + test.
Map ACP updates → UIMessageChunks mirroring what `packages/claude-code/ui-stream.ts` produces for equivalent content (read it first; text-start/delta/end, tool input/output lifecycle, reasoning if ACP surfaces it). Table-driven tests: each ACP update kind → exact chunk sequence.
Commit: `Map ACP updates to UI message chunks`

### Task 4: `OpenFxBackend` implements AgentBackend + conformance

**Files:** `packages/openfx-backend/backend.ts` + `backend.test.ts`.
`startTurn`: AcpClient session per TurnContext (resumeToken per PROTOCOL.md), chunks generator through the mapper, result from the terminal ACP message (usage: map what ACP reports; absent fields → zeros), interrupt → ACP cancel then kill → result rejects AbortError, steer → cancel + resolve steered (same "restart" semantics as ClaudeCodeBackend), abandonment finally-guard (the amended CONTRACT), capabilities per PROTOCOL.md findings. `runBackendConformance("OpenFxBackend", ...)` with the stub — must pass. Plus targeted tests: permission-request → the backend surfaces it as an `approval/requested`-shaped event on a callback option and blocks until the supplied decision hook answers (wire the SAME decideApproval-driven flow run-step uses — read how the claude PreToolUse hook round-trips and mirror the seam, not the mechanism).
Commit: `Implement the OpenFX agent backend`

### Task 5: Selection + settings

**Files:** Modify `apps/web/lib/db/schema.ts` (chats.backend text enum ["claude-code","openfx"] notNull default "claude-code" — migration ONLY this), run-step/backend factory (`apps/web/lib/agent/backend-factory.ts` Create: returns the chat's backend instance; openfx config — endpoint/key/binary path — from a new org-scoped encrypted settings row using secret-box + instanceSettings patterns), model settings page gains an OpenFX section (BYO endpoint/key, test-connection button calling a cheap ACP handshake), chat composer's model selector gains the backend dimension ONLY if the UI pattern makes it natural — otherwise a per-chat setting in the chat's settings surface; match existing UI conventions (read model-selector-compact + new-session-dialog first). Capability-driven UI: effort selector hidden when the chat's backend reports effort:false (thread capabilities to the client via the chat bootstrap payload).
Tests: factory (unknown → claude default), settings encryption round-trip, capability-hiding component test.
Commit: `Make the agent backend selectable per chat`

## Final verification
- [ ] `pnpm run ci`; conformance suite green for FakeBackend, ClaudeCodeBackend, OpenFxBackend.
- [ ] Manual: point OpenFX settings at a real provider, run a chat turn end-to-end on the openfx backend, interrupt mid-turn, steer mid-turn.
