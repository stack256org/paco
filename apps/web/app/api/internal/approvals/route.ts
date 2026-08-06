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
 */

/** Slightly under the hook's own timeout, so this side decides. */
export const maxDuration = 330;

const bodySchema = z.object({
  chatId: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()).default({}),
});

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

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${approvalToken()}`) {
    return Response.json({ error: NOT_YOURS }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // Allow rather than block: a request this endpoint cannot parse is a bug
    // in Paco, and a bug in Paco should not wedge the agent.
    return Response.json({ outcome: "allow" });
  }

  const { chatId, toolName, toolInput } = parsed.data;

  const chat = await getChatById(chatId);
  const session = chat ? await getSessionById(chat.sessionId) : null;
  if (!(chat && session?.sandboxState)) {
    return Response.json({ outcome: "allow" });
  }

  const decision = decideApproval(
    { name: toolName, input: toolInput },
    hostChatWorktree(session.sandboxState, chatId),
  );

  if (decision.kind === "allow") {
    return Response.json({ outcome: "allow" });
  }

  const outcome = await requestApproval({
    chatId,
    toolName,
    reason: decision.reason,
    detail: describeCall(toolName, toolInput),
  });

  return Response.json({
    outcome,
    ...(outcome === "deny"
      ? { reason: `Not approved in Paco: ${decision.reason}.` }
      : {}),
  });
}
