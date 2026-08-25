import "server-only";

import type { ClaudeAgentDefinition } from "@paco/claude-code";
import type { SkillMetadata } from "@paco/sandbox";
import { getRoster } from "@/lib/db/roster";
import {
  pluginAgentContributions,
  pluginSkillContributions,
} from "@/lib/plugins/contributions";

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

/**
 * The subagent roster for one chat's turn.
 *
 * `{...pluginAgentContributions(), ...getRoster(organizationId)}` — the
 * organisation's roster wins any name collision with a plugin-contributed
 * agent, the same way a plugin never gets to shadow a builtin: the roster is
 * what an organisation's admins configured on purpose, a plugin's `agents/`
 * directory is a suggestion. `getRoster` already applies its own
 * enabled/valid filtering (a disabled or invalid row never reaches the
 * returned record), so nothing further is filtered here.
 *
 * `DEFAULT_AGENTS` (`@paco/claude-code`) is not merged in here — it stays the
 * package-level fallback `resolveAgents` (`lib/agent/run-step.ts`) reaches
 * for when a caller passes no `agents` at all, and the seed source
 * `seedDefaultRoster` copies into a fresh organisation's roster. The web app
 * always resolves this function instead of leaving `agents` undefined, so
 * that fallback is reached only when this call itself fails upstream.
 */
export async function resolveChatAgents(
  organizationId: string,
): Promise<Record<string, ClaudeAgentDefinition>> {
  const [pluginAgents, roster] = await Promise.all([
    pluginAgentContributions(),
    getRoster(organizationId),
  ]);
  return { ...pluginAgents, ...roster };
}

/**
 * A chat's skill list: the workspace's own skills, plus every enabled
 * plugin's, concatenated with the plugin's after the workspace's.
 *
 * A name collision keeps the workspace's skill and drops the plugin's: a
 * project's own `.claude/skills` or `.agents/skills` entry is something a
 * maintainer put there on purpose, and a plugin should not be able to
 * silently override what a skill named `deploy` (say) actually does. The
 * drop is logged so an admin can see why a plugin's skill didn't show up.
 */
export async function resolveChatSkills(
  workspaceSkills: SkillMetadata[],
): Promise<SkillMetadata[]> {
  const pluginSkills = await pluginSkillContributions();
  if (pluginSkills.length === 0) {
    return workspaceSkills;
  }

  const workspaceNames = new Set(
    workspaceSkills.map((skill) => skill.name.toLowerCase()),
  );
  const nonColliding = pluginSkills.filter((skill) => {
    if (workspaceNames.has(skill.name.toLowerCase())) {
      console.warn(
        `resolveChatSkills: plugin skill "${skill.name}" collides with a workspace skill; the workspace skill wins`,
      );
      return false;
    }
    return true;
  });

  return [...workspaceSkills, ...nonColliding];
}
