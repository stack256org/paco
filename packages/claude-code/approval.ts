import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The `PreToolUse` hook, and the settings that install it.
 *
 * Claude Code fires this hook before every tool call — including under
 * `bypassPermissions`, which is what makes it usable here. Paco runs on the
 * host with prompts bypassed because every other permission mode breaks the
 * product, so this hook is the only thing standing between the agent and the
 * operator's machine.
 */

/**
 * The hook, embedded as a string and written to disk on first use.
 *
 * It cannot be shipped as a file the app merely imports: Claude Code executes
 * it as its own Node process, so what it needs is a real path on disk. Getting
 * one from `import.meta.url` does not survive bundling — Turbopack rewrote the
 * URL and `fileURLToPath` threw during module evaluation, which left every
 * tool call silently unguarded.
 *
 * Writing it out sidesteps bundlers entirely and behaves identically in
 * development and production. `hook/pre-tool-use.mjs` is the readable copy and
 * the one to edit; `approval-hook-source.test.ts` fails if the two drift.
 */
export const HOOK_SOURCE =
  '#!/usr/bin/env node\n/**\n * `PreToolUse` hook: ask Paco whether this tool call may run.\n *\n * Claude Code spawns this once per tool call, hands it the call on stdin, and\n * blocks until it exits. That blocking is the whole mechanism \u2014 it is what\n * turns a static permission mode into a question the user can actually answer.\n *\n * Plain `.mjs` with no imports beyond Node\'s own: it runs from the CLI\'s\n * process, not from the bundled app, so it cannot rely on anything Next.js or\n * a bundler provides.\n *\n * Fails *open* on transport errors, and that is deliberate. If Paco is\n * unreachable the alternative is an agent that cannot do anything at all,\n * which turns a monitoring blip into a total outage. Refusals that matter come\n * from the policy and the user, both of which are reached over a healthy\n * connection; a dead connection is an operator problem, not a security\n * boundary. The one exception is an explicit deny, which is always honoured.\n */\n\nconst ENDPOINT = process.env.PACO_APPROVAL_URL;\nconst TOKEN = process.env.PACO_APPROVAL_TOKEN;\nconst CHAT_ID = process.env.PACO_APPROVAL_CHAT_ID;\n\n/** Longer than the server\'s own wait, so the server decides, not this script. */\nconst REQUEST_TIMEOUT_MS = 6 * 60 * 1000;\n\nfunction allow() {\n  process.stdout.write("{}\\n");\n  process.exit(0);\n}\n\nfunction deny(reason) {\n  // Concatenation rather than a template literal. This file is embedded as a\n  // string constant in `approval.ts`, and an interpolation placeholder inside\n  // that string reads as one that was meant to run.\n  process.stdout.write(\n    JSON.stringify({\n      hookSpecificOutput: {\n        hookEventName: "PreToolUse",\n        permissionDecision: "deny",\n        permissionDecisionReason: reason,\n      },\n    }) + "\\n",\n  );\n  process.exit(0);\n}\n\nasync function readStdin() {\n  const chunks = [];\n  for await (const chunk of process.stdin) {\n    chunks.push(chunk);\n  }\n  return Buffer.concat(chunks).toString("utf-8");\n}\n\nasync function main() {\n  if (!(ENDPOINT && TOKEN && CHAT_ID)) {\n    // Not wired up \u2014 behave as though the hook were not installed.\n    allow();\n    return;\n  }\n\n  let payload;\n  try {\n    payload = JSON.parse(await readStdin());\n  } catch {\n    allow();\n    return;\n  }\n\n  const response = await fetch(ENDPOINT, {\n    method: "POST",\n    headers: {\n      "Content-Type": "application/json",\n      Authorization: "Bearer " + TOKEN,\n    },\n    body: JSON.stringify({\n      chatId: CHAT_ID,\n      toolName: payload.tool_name,\n      toolInput: payload.tool_input,\n    }),\n    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),\n  });\n\n  if (!response.ok) {\n    allow();\n    return;\n  }\n\n  const decision = await response.json();\n  if (decision.outcome === "deny") {\n    deny(decision.reason ?? "Denied in Paco.");\n    return;\n  }\n\n  allow();\n}\n\nmain().catch(() => {\n  allow();\n});\n';

/**
 * Where the hook lives once written.
 *
 * Alongside the workspaces and the `gh` config, under Paco's own directory —
 * never inside the user's repository, which would put Paco's configuration in
 * their diff.
 */
/**
 * Install (or confirm) the hook at an exact path, atomically.
 *
 * `buildApprovalSettings()` runs once per gated `runAgentTurn` call, and
 * this server runs many turns at once — separate chats on separate
 * workflows, plus the N parallel candidate turns of a single design turn,
 * which fan out through one `Promise.all` and each carry the chat's own
 * approval settings (`RunDesignTurnParams.approval` in
 * `apps/web/lib/design/design-turn.ts`). Two calls overlapping is therefore
 * ordinary, not exotic. A plain `writeFileSync` to this fixed path let a
 * hook process spawned mid-write (by a *different* concurrent turn) read a
 * truncated or half-overwritten file and fail the tool call it was supposed
 * to gate.
 *
 * Two changes close that: the write is skipped entirely once the file
 * already matches `HOOK_SOURCE` — true for every call after the very
 * first, since the source only changes across a Paco upgrade — and when it
 * doesn't match, the new content goes to a sibling temp file first, with
 * `renameSync` swapping it into place. A rename within the same directory
 * is atomic on POSIX filesystems, so a concurrent reader always sees
 * either the complete old file or the complete new one, never a partial
 * write.
 *
 * Exported (rather than folded into `hookPath()`) so `HOOK_SOURCE`'s
 * atomic-install behavior can be tested against a throwaway path directly:
 * `os.homedir()` cannot be relied on to honor `process.env.HOME` across
 * every runtime this ships on (Bun's `homedir()` reads the OS user
 * database, not the environment), so a test needs some other way to reach
 * a throwaway target.
 */
export function installHookAt(target: string): void {
  const current = existsSync(target) ? readFileSync(target, "utf-8") : null;
  if (current !== HOOK_SOURCE) {
    const dir = dirname(target);
    const tempTarget = join(dir, `.pre-tool-use.mjs.${randomUUID()}.tmp`);
    try {
      writeFileSync(tempTarget, HOOK_SOURCE, "utf-8");
      renameSync(tempTarget, target);
    } catch (error) {
      // The rename is what makes this atomic, so a failure before it leaves
      // the real hook untouched — but it can leave the temp file behind, and
      // every call mints a fresh UUID, so nothing would ever reclaim it.
      // Best-effort: never let cleanup replace the error that actually
      // matters (a full disk, a permission problem) with its own.
      try {
        rmSync(tempTarget, { force: true });
      } catch {
        // Ignored on purpose — see above.
      }
      throw error;
    }
  }
  chmodSync(target, 0o755);
}

function hookPath(): string {
  const dir = join(homedir(), ".paco", "hooks");
  mkdirSync(dir, { recursive: true });

  const target = join(dir, "pre-tool-use.mjs");
  installHookAt(target);

  return target;
}

/**
 * Settings that route every tool call through Paco.
 *
 * The matcher is `*` on purpose. Filtering here would mean maintaining the
 * policy in two places — once as a matcher string and once in
 * `decideApproval` — and they would drift. The hook asks about everything and
 * the policy, which is tested, decides; a process per read-only call is cheap
 * next to a rule that silently stops matching.
 */
export function buildApprovalSettings(): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: hookPath() }],
        },
      ],
    },
  };
}
