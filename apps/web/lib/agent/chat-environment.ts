/**
 * Environment details for one chat, on top of the session's.
 *
 * The sandbox describes the session: the container, the mount, the preview
 * URLs. What it cannot describe is which of the session's worktrees this
 * particular turn runs in — the sandbox is shared by every chat in the session
 * and does not know about chats at all.
 *
 * Getting this wrong is not cosmetic. The agent runs on the host, so the
 * directory named here is the one whose branch its edits land on. If it were
 * pointed at the session's repository instead of the chat's worktree, every
 * chat would write to the same branch and the isolation would exist on disk
 * but not in practice.
 *
 * There is one path rather than a host/container pair: the workspace is
 * mounted at its host path inside the container as well, which is what lets
 * git worktrees resolve from both sides.
 */
export function buildChatEnvironmentDetails(params: {
  /** The session-level description from the sandbox. */
  sandboxDetails?: string;
  /** The chat's worktree — the same path on the host and in the container. */
  worktreePath: string;
  /** The branch that worktree has checked out. */
  branch: string;
}): string {
  const lines = [
    `- Your working directory (you run here): ${params.worktreePath}`,
    "- The container sees this at the same path, so it is the directory to use there too.",
    `- Branch: \`${params.branch}\` — this chat has its own git worktree, so your changes here do not touch other chats in this session.`,
  ];

  // The sandbox's own working-directory lines describe the session root and
  // would contradict the chat-scoped ones above, so they are dropped rather
  // than shown alongside them.
  const sessionLines = (params.sandboxDetails ?? "")
    .split("\n")
    .filter(
      (line) =>
        !(
          line.startsWith("- Your working directory") ||
          line.startsWith("- The same files inside the container")
        ),
    );

  return [...sessionLines, ...lines].filter(Boolean).join("\n");
}
