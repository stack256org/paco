import { z } from "zod";
import {
  requireAuthenticatedUser,
  requireOwnedChatById,
} from "@/app/api/chat/_lib/chat-context";
import {
  type ApprovalRequest,
  listPendingApprovals,
  resolveApproval,
} from "@/lib/agent/approvals/store";
import { BAD_REQUEST } from "@/lib/error-copy";

/**
 * What this chat's agent is waiting for permission to do, and the answer.
 *
 * Separate from the internal endpoint the hook blocks on: this one is called
 * by the browser and is authenticated as the user who owns the chat. Ownership
 * matters more than usual here — answering is what lets a shell command run on
 * the host.
 */

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

export type PendingApprovalsResponse = {
  approvals: ApprovalRequest[];
};

const decisionSchema = z.object({
  id: z.string().min(1),
  outcome: z.enum(["allow", "deny"]),
});

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAuthenticatedUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { chatId } = await context.params;
  const chat = await requireOwnedChatById({ userId: auth.userId, chatId });
  if (!chat.ok) {
    return chat.response;
  }

  return Response.json({
    approvals: listPendingApprovals(chatId),
  } satisfies PendingApprovalsResponse);
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireAuthenticatedUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { chatId } = await context.params;
  const chat = await requireOwnedChatById({ userId: auth.userId, chatId });
  if (!chat.ok) {
    return chat.response;
  }

  const parsed = decisionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  // False means the request is already gone — answered twice, or timed out
  // while the user was deciding. Reported rather than treated as an error,
  // since the UI's only sensible response either way is to stop showing it.
  const resolved = resolveApproval(parsed.data.id, chatId, parsed.data.outcome);

  return Response.json({ resolved });
}
