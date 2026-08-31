import { timingSafeEqual } from "node:crypto";
import { decideApproval } from "@paco/claude-code";
import { z } from "zod";
import { requestApproval } from "@/lib/agent/approvals/store";
import { approvalToken } from "@/lib/agent/approvals/token";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import { NOT_YOURS } from "@/lib/error-copy";

/**
 * The endpoint the `PreToolUse` hook blocks on.
 *
 * Internal: called by a process Paco spawned, on this machine, not by a
 * browser. There is no user session to authenticate against — the hook runs
 * inside the Claude Code process — so it carries a bearer token minted at
 * startup and passed to the CLI through its environment. Without that check
 * anything able to reach localhost could approve the agent's actions, or
 * enumerate what it is about to do.
 *
 * The request is held open until the user answers. That is the point: the CLI
 * is blocked on this response, which is what makes the approval meaningful
 * rather than advisory.
 *
 * ## Every path out of here fails closed
 *
 * This route used to answer `{outcome:"allow"}` in three situations that were
 * not decisions at all: a body the schema rejected, a chat that could not be
 * found, and a session with no `sandboxState`. The last one is the one that
 * mattered, because it is a state the product reaches normally — a sandbox
 * that has not provisioned yet, one whose provisioning failed, one that was
 * reaped — and in it *every* tool call ran ungated, with nothing written down
 * anywhere to say so.
 *
 * The hook on the other side already fails open on transport errors by
 * design, which is defensible only if this side never adds a second one: two
 * fail-open paths in series mean the gate is open whenever either end is
 * unhappy. So the rules here are:
 *
 * - **Unreadable request** → `deny`. The agent chooses `toolInput`, so a shape
 *   the parser chokes on must not be a way past the policy.
 * - **Unknown chat** → `deny`. There is no chat to raise a card in, so asking
 *   would only strand the agent until the approval timeout answers `deny`
 *   anyway.
 * - **Unknown workspace** → run the policy with no worktree. Nothing can then
 *   be shown to stay inside one, so every path-bearing call asks the user
 *   while reads still run — the gate closes without becoming a wall.
 * - **Database or code failure** → `deny`, as a 200. A 500 here reads to the
 *   hook as a transport error, which is an allow.
 */

/** Slightly under the hook's own timeout, so this side decides. */
export const maxDuration = 330;

const bodySchema = z.object({
  chatId: z.string().min(1),
  toolName: z.string().min(1),
  // Deliberately `unknown` rather than a record: the agent chooses this value,
  // and a schema that can *reject* it turns "send something malformed" into a
  // way past the policy. Anything that is not a plain object is normalised to
  // no input, which the policy already fails closed on.
  toolInput: z.unknown().optional(),
});

function toolInputOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const input: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    input[key] = entry;
  }
  return input;
}

/** Constant-time comparison — a `!==` leaks the token one byte at a time
 * through response timing. Same shape as `lib/plugins/tools-token.ts`. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** What the user needs to see to judge the call, without the noise. */
function describeCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    return input.command;
  }

  const filePath = input.file_path ?? input.filePath ?? input.path;
  if (typeof filePath === "string") {
    return filePath;
  }

  return JSON.stringify(input).slice(0, 400);
}

/**
 * Refuse the call, in the one shape the hook honours.
 *
 * A 200 on purpose: the hook treats any non-2xx as a transport problem and
 * allows the call, so a refusal delivered as an error status is not a refusal.
 */
function denied(reason: string): Response {
  return Response.json({
    outcome: "deny",
    reason: `Not approved in Paco: ${reason}.`,
  });
}

/** Said in the prompt *and* in the server log, because a gate that quietly
 * degrades is the thing this route was getting wrong. */
const NO_WORKSPACE_REASON =
  "cannot be checked against this chat's workspace, because Paco cannot locate one right now — the sandbox may still be starting, or may have stopped";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (
    authorization === null ||
    !safeEqual(authorization, `Bearer ${approvalToken()}`)
  ) {
    return Response.json({ error: NOT_YOURS }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return denied(
      "the approval hook sent a request Paco could not read, so it could not tell what was about to run",
    );
  }

  const { chatId, toolName } = parsed.data;
  const toolInput = toolInputOf(parsed.data.toolInput);

  try {
    const chat = await getChatById(chatId);
    if (!chat) {
      return denied(
        "this chat no longer exists, so Paco cannot tell which workspace the call belongs to",
      );
    }

    const session = await getSessionById(chat.sessionId);
    const sandboxState = session?.sandboxState ?? null;
    if (sandboxState === null) {
      console.warn(
        `[approvals] chat ${chatId}: no sandbox state, so ${toolName} is being judged with no workspace boundary`,
      );
    }

    // With no sandbox there is no worktree, and `decideApproval` treats a path
    // it cannot place as outside — so this degrades to "ask about anything
    // that touches a path" rather than to "allow".
    const worktree = sandboxState ? hostChatWorktree(sandboxState, chatId) : "";

    const decision = decideApproval(
      { name: toolName, input: toolInput },
      worktree,
    );

    if (decision.kind === "allow") {
      return Response.json({ outcome: "allow" });
    }

    const reason = sandboxState
      ? decision.reason
      : `${decision.reason} — it ${NO_WORKSPACE_REASON}`;

    const outcome = await requestApproval({
      chatId,
      toolName,
      reason,
      detail: describeCall(toolName, toolInput),
    });

    return Response.json({
      outcome,
      ...(outcome === "deny"
        ? { reason: `Not approved in Paco: ${reason}.` }
        : {}),
    });
  } catch (error) {
    // A throw here reaches the hook as a 500, and the hook allows on those.
    // The failure has to be turned into an answer, and the only safe answer
    // is no.
    console.error(`[approvals] chat ${chatId}: ${toolName} refused —`, error);
    return denied(
      "Paco could not reach the state it needs to judge this call, so it refused rather than guess",
    );
  }
}
