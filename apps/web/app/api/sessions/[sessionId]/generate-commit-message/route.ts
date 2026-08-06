import { generateCommitMessage } from "@/lib/github/commit-message";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { connectSandbox } from "@paco/sandbox";

import { getSessionById } from "@/lib/db/sessions";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  SESSION_NOT_FOUND,
  SIGNED_OUT,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";

export const maxDuration = 30;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["generate-commit-message", session.user.id]),
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const { sessionId } = await params;
  const dbSession = await getSessionById(sessionId);
  if (!dbSession || dbSession.userId !== session.user.id) {
    return Response.json({ error: SESSION_NOT_FOUND }, { status: 404 });
  }

  if (!isSandboxActive(dbSession.sandboxState)) {
    return Response.json({ error: WORKSPACE_NOT_STARTED }, { status: 400 });
  }

  const sandbox = await connectSandbox(dbSession.sandboxState);
  const cwd = resolveWorkCwd(
    dbSession.sandboxState,
    new URL(req.url).searchParams.get("chatId"),
  );

  // Get the diff for commit message generation
  const diffResult = await sandbox.exec(
    "git diff HEAD --stat && echo '---DIFF---' && git diff HEAD",
    cwd,
    30000,
  );

  const diff = diffResult.stdout;
  if (!diff.trim() || !diff.includes("---DIFF---")) {
    return Response.json({ message: "chore: update repository changes" });
  }

  return Response.json({
    message: await generateCommitMessage(diff, dbSession.title),
  });
}
