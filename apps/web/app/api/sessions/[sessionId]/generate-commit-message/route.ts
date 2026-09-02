import { generateCommitMessage } from "@/lib/github/commit-message";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { connectSandbox } from "@paco/sandbox";

import { getSessionById } from "@/lib/db/sessions";
import { discoverNestedRepos, repoCwd } from "@/lib/git/nested-repos";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { SESSION_NOT_FOUND, WORKSPACE_NOT_STARTED } from "@/lib/error-copy";

export const maxDuration = 30;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const limited = await checkRateLimit({
    key: rateLimitKey(["generate-commit-message"]),
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const { sessionId } = await params;
  const dbSession = await getSessionById(sessionId);
  if (!dbSession) {
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

  // Get the diff for commit message generation — from the worktree's own
  // repository and from every repository nested inside it, so a commit
  // message written for a multi-project workspace describes all of the work
  // rather than only the parent's slice.
  const diffResult = await sandbox.exec(
    "git diff HEAD --stat && echo '---DIFF---' && git diff HEAD",
    cwd,
    30000,
  );

  let diff = diffResult.stdout;
  for (const root of await discoverNestedRepos(sandbox, cwd)) {
    const nested = await sandbox.exec(
      "git diff HEAD --stat && echo '---DIFF---' && git diff HEAD",
      repoCwd(cwd, root),
      30000,
    );
    if (nested.success && nested.stdout.trim()) {
      diff += `\n--- in ${root}/ ---\n${nested.stdout}`;
    }
  }

  if (!diff.trim() || !diff.includes("---DIFF---")) {
    return Response.json({ message: "chore: update repository changes" });
  }

  return Response.json({
    message: await generateCommitMessage(diff, dbSession.title),
  });
}
