#!/usr/bin/env node
/**
 * `PreToolUse` hook: ask Paco whether this tool call may run.
 *
 * Claude Code spawns this once per tool call, hands it the call on stdin, and
 * blocks until it exits. That blocking is the whole mechanism — it is what
 * turns a static permission mode into a question the user can actually answer.
 *
 * Plain `.mjs` with no imports beyond Node's own: it runs from the CLI's
 * process, not from the bundled app, so it cannot rely on anything Next.js or
 * a bundler provides.
 *
 * Fails *open* on transport errors, and that is deliberate. If Paco is
 * unreachable the alternative is an agent that cannot do anything at all,
 * which turns a monitoring blip into a total outage. Refusals that matter come
 * from the policy and the user, both of which are reached over a healthy
 * connection; a dead connection is an operator problem, not a security
 * boundary. The one exception is an explicit deny, which is always honoured.
 */

const ENDPOINT = process.env.PACO_APPROVAL_URL;
const TOKEN = process.env.PACO_APPROVAL_TOKEN;
const CHAT_ID = process.env.PACO_APPROVAL_CHAT_ID;

/** Longer than the server's own wait, so the server decides, not this script. */
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000;

function allow() {
  process.stdout.write("{}\n");
  process.exit(0);
}

function deny(reason) {
  // Concatenation rather than a template literal. This file is embedded as a
  // string constant in `approval.ts`, and an interpolation placeholder inside
  // that string reads as one that was meant to run.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  if (!(ENDPOINT && TOKEN && CHAT_ID)) {
    // Not wired up — behave as though the hook were not installed.
    allow();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    allow();
    return;
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + TOKEN,
    },
    body: JSON.stringify({
      chatId: CHAT_ID,
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    allow();
    return;
  }

  const decision = await response.json();
  if (decision.outcome === "deny") {
    deny(decision.reason ?? "Denied in Paco.");
    return;
  }

  allow();
}

main().catch(() => {
  allow();
});
