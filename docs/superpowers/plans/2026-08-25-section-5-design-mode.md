# Section 5: Design Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A design mode inside a chat: the designer agent produces 2–3 candidate screens as real running code on throwaway branches, the preview pane shows them side by side, the user picks and annotates by clicking elements in the live preview, and the winner merges onto the chat's branch as the executor's spec.

**Architecture:** Candidates are worktrees (`design/<chatId>/<n>` branches) created from the chat's branch — the existing session-repo + worktree + published-preview machinery, multiplied. A design turn asks the designer roster agent for N variants (one turn per candidate, parallel workflow steps). The preview iframe gains an injected inspector script (served by Paco, injected only for design-mode candidate previews via the existing preview routing) that maps clicks to a CSS-selector + nearest `data`/source hint and posts them to the parent. Annotations become the next design-iteration prompt. Accept = merge candidate branch into the chat branch (fast-forward or ordinary merge), delete all candidate worktrees/branches.

**Tech Stack:** existing worktree/git helpers (`packages/sandbox` git.ts), nginx preview infra, Next.js + daisyUI skill, Workflow SDK steps.

**Spec:** `docs/superpowers/specs/2026-08-25-paco-platform-design.md` (Section 5). Depends on Section 3 (designer roster entry) — REQUIRED; Section 2 optional (plugin design tooling flows in automatically if present).

## Global Constraints

- Section 1 plan's Global Constraints apply verbatim. Zero-customer ruling. Nothing deferred.
- Design mode invariants: candidate branches/worktrees are ALWAYS cleaned up (accept, cancel, or chat deletion — all three paths); a candidate preview is access-controlled exactly like the chat's preview (same decide-access path — no new exposure); the inspector script is injected ONLY into design-candidate previews, never ordinary previews.
- Branch naming: `design/<chatId>/<n>` (n = 1..3). Worktree dirs: siblings of chat worktrees under the session workspace `designs/<chatId>/<n>/` — verify against the Section 1 workspace layout doc comment (repo/ + chats/ siblings) and place `designs/` beside `chats/`.

---

### Task 1: Candidate worktree lifecycle

**Files:**
- Create: `apps/web/lib/design/candidates.ts`
- Modify: `packages/sandbox` git helpers ONLY if a needed primitive (create worktree from a given base branch; delete worktree+branch) is missing — read `packages/sandbox/git.ts` first; reuse everything that exists.
- Test: `apps/web/lib/design/candidates.test.ts` (mirror how sandbox git tests build throwaway repos)

**Interfaces:**

```ts
export interface DesignCandidate { index: 1|2|3; branch: string; worktreeDir: string; }
export async function createCandidates(params: { sessionWorkspace: string; chatId: string; baseBranch: string; count: 2|3 }): Promise<DesignCandidate[]>;
export async function removeCandidates(params: { sessionWorkspace: string; chatId: string }): Promise<void>; // idempotent; prunes worktrees + deletes design/<chatId>/* branches; safe when none exist
export async function acceptCandidate(params: { sessionWorkspace: string; chatId: string; index: number; chatBranch: string }): Promise<{ok:true} | {ok:false; error:string}>;
// merge design/<chatId>/<index> into chatBranch inside the CHAT's worktree (git merge --no-ff -m "Adopt design candidate <index>");
// dirty chat worktree → {ok:false, error naming it}; on success calls removeCandidates.
```

**Steps (TDD):** real-git tests (create 3 from base; dirs exist on the declared paths; remove idempotent incl. half-removed state; accept merges the candidate's commit onto the chat branch and cleans up; accept with dirty chat worktree refuses) → implement → commit: `Add design candidate worktree lifecycle`

---

### Task 2: Design turn — N parallel designer variants

**Files:**
- Create: `apps/web/lib/design/design-turn.ts`
- Modify: `apps/web/app/workflows/chat.ts` — a design-mode branch in the workflow: when the turn is flagged design (Task 4 wires the flag through the send path), run createCandidates then N parallel steps, each `runAgentTurn` with cwd = that candidate's worktree, the designer agent's definition applied (systemPrompt framing: "You are producing DESIGN CANDIDATE <n> of <count>. Take a distinct visual direction from the other candidates: candidate 1 = closest to the existing design language; 2 = bolder restructure; 3 = experimental. Implement the request as real, running UI in this worktree. Commit your work."), maxTurns capped at 40.
- Test: `design-turn.test.ts` (runAgentTurn + candidates mocked; workflow test extension)

**Semantics:** each candidate turn commits in ITS worktree (the designer prompt says commit; enforce with a post-turn `git add -A && git commit -m "Design candidate <n>"` in the candidate worktree when dirty — read how checkpointing commits in `chat-checkpoint.ts` and reuse its helper). A failed candidate turn does not fail the design turn: candidates that errored are reported as failed in the stream and excluded; the design turn fails only if ALL candidates fail. Stream progress to the client as data chunks (`data-design-progress` UIMessage data part with {candidate, status}) so the UI can show per-candidate progress live.

**Steps (TDD):** parallel fan-out; one-fails-two-survive; all-fail → turn error; dirty-worktree auto-commit; progress chunks emitted → implement → commit: `Run design turns as parallel candidate variants`

---

### Task 3: Candidate previews + inspector injection

**Files:**
- Modify: `apps/web/lib/preview/hostname.ts` + `nginx-config.ts` + `decide-access.ts` — candidate preview hostnames: the existing chat preview slug convention extended with `-d<n>` suffix (read previewSlug generation + the forward-auth mapping FIRST; the candidate hostname maps back to the chat's access rules; the container serves candidates the same way it serves the chat — ports: candidate n publishes on the chat's preview port convention; read how ports are assigned per chat in the sandbox docker config and extend for up to 3 candidate ports).
- Create: `apps/web/public/design-inspector.js` (plain JS, no build step): on click (when armed via postMessage {type:"paco-inspect-arm"}), preventDefault, compute a robust CSS selector (id > data-testid > tag.nth-of-type chain, max depth 6) + innerText first 80 chars + bounding rect, postMessage to parent {type:"paco-inspect-click", selector, text, rect}. Also highlights hover targets when armed (outline via injected style).
- Create: `apps/web/app/api/preview-inspector/route.ts` — serves the script (it must load from the PREVIEW origin to avoid cross-origin script blocking: instead inject via nginx `sub_filter` appending `<script src="/__paco/design-inspector.js">` before `</body>` for candidate hostnames ONLY, plus an nginx location serving that path — extend nginx-config.ts templates; read them fully first).
- Test: nginx-config test extension (candidate server block contains sub_filter + location; ordinary chat block does NOT), decide-access test (candidate hostname inherits chat access), inspector script unit test in jsdom-style if the repo has one — else a small pure-function test for the selector builder extracted into `selector.ts` shared by the script via copy-with-comment (script stays dependency-free; the tested module is the source of truth, a build-check test asserts the two stay in sync by string comparison of the function body).

**Steps (TDD)** → commit: `Publish design candidate previews with a click inspector`

---

### Task 4: Design mode UI — toggle, side-by-side, annotate, accept

**Files:**
- Create: `apps/web/components/design-mode/design-panel.tsx`, `candidate-frame.tsx`, `annotation-chip.tsx`, `design-mode-context.tsx`
- Modify: the chat composer (find the composer component the sessions chat page renders — model/effort selectors live near it) — add a Design toggle (visible always; active state stored per-chat in the DB? No — per-message: the send payload gains `mode: "design" | undefined`; the API/workflow thread it through — modify the chat send API route schema + workflow options), and the chat page layout to render DesignPanel when the current turn is a design turn (detect from the streamed `data-design-progress` parts and a `data-design-ready` part carrying candidate preview URLs).
- Test: component tests for the panel (renders N frames from fixture data; annotation chips collect clicks; accept button calls action), API schema test (mode accepted).

**Requirements (daisyUI skill first, match app chrome):** side-by-side iframes (2-3 columns, responsive stack on narrow), each frame: candidate label, per-candidate status while generating (from progress parts), the iframe (src = candidate preview URL) armed for inspection via postMessage; clicks append annotation chips under the frame ("<selector-short>: <note>" — clicking a chip lets the user type the note in an inline input, exactly like the existing inline-question-input pattern — read that component). Two actions per the flow: "Iterate" (sends a new design-mode message composed from the chips: "On candidate <n>: <selector> (<text excerpt>) — <note>. ..." targeting refinement of a CHOSEN candidate — radio-select which candidate iterates; iteration replaces that candidate's content by running the designer again in the SAME candidate worktree) and "Accept candidate <n>" → `acceptDesignAction` → acceptCandidate + a normal chat message announcing adoption + candidates cleaned; the panel closes.
- Server actions in `apps/web/app/sessions/[sessionId]/chats/[chatId]/design-actions.ts` (quote bracketed paths in git commands): acceptDesignAction, cancelDesignAction (removeCandidates), both org-membership-gated like other chat actions (find the existing chat action guard).
- Cleanup wiring: chat deletion/archival path also calls removeCandidates (find where chats are deleted/archived — the reaping lib — and add).

**Steps (TDD):** actions tests (accept merges via mocked candidates lib + posts message; cancel cleans; guards) → panel component tests → composer toggle test → implement → commit: `Add the design mode UI`

---

## Final verification
- [ ] `pnpm run ci`.
- [ ] Manual smoke on a dev instance: toggle design on, ask for a landing page, watch 3 candidates stream, click elements + annotate, iterate candidate 2, accept it, confirm the chat branch got the merge and candidates are gone (git worktree list clean).
