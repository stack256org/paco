"use client";

import { GitBranch } from "lucide-react";
import { useParams } from "next/navigation";
import { useSessionLayout } from "@/app/sessions/[sessionId]/session-layout-context";

/**
 * States what this tab is working on, which nothing else on the screen says.
 *
 * Each chat gets its own git worktree of the session's repository, on its own
 * branch, so the tabs are parallel lines of work rather than views of one
 * shared directory. That is the single most load-bearing fact about the model
 * and it was previously invisible.
 *
 * It used to be stated as `chat/WtFtUCEMEJqRGmBHmoITd — this chat's own
 * branch`. Every word of that is true and almost none of it is legible to
 * someone who has never used git: the eye-catching part is a random identifier
 * they can do nothing with, sitting in a permanent strip directly above the
 * conversation. So the strip now says the *consequence* — this chat's changes
 * are its own — and keeps the branch name in the `title`, where the one person
 * in twenty who wants it can still find it.
 *
 * The branch is derived rather than fetched: it is a pure function of the chat
 * id, so asking the server for it would be a request to learn something the
 * page already knows.
 */
export function ChatTabsWorkspaceNote() {
  const { session } = useSessionLayout();
  const params = useParams<{ chatId?: string }>();
  const chatId = typeof params.chatId === "string" ? params.chatId : null;

  if (!chatId) {
    return null;
  }

  const repo =
    session.repoOwner && session.repoName
      ? `${session.repoOwner}/${session.repoName}`
      : session.repoName;

  const branch = `chat/${chatId}`;

  return (
    <div
      className="flex items-center gap-1.5 overflow-hidden border-base-300 border-b bg-base-200/30 px-3 py-1 text-[11px] text-base-content/50"
      title={
        repo
          ? `Branch ${branch} of ${repo}`
          : `Branch ${branch}, in this workspace's own repository`
      }
    >
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">
        Changes in this chat stay here
        {repo ? (
          <>
            {" — "}
            <span className="text-base-content/70">{repo}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
