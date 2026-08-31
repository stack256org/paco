import "server-only";

import type { ClaudeAgentDefinition } from "@paco/claude-code";
import type { SkillMetadata } from "@paco/sandbox";
import { appLoopbackUrl } from "@/lib/app-url";
import { getRoster } from "@/lib/db/roster";
import {
  pluginAgentContributions,
  pluginSkillContributions,
} from "@/lib/plugins/contributions";
import type { McpServerSpec } from "@/lib/plugins/mcp-bridge";

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
 * `organizationId` is optional: plugin agents don't need one (they come from
 * disk, keyed by filename), only the roster half does. A caller that hasn't
 * resolved an organisation yet (a fresh self-hosted install, or a failed
 * lookup) still gets plugin contributions rather than losing agents entirely
 * — only the roster half is skipped, not the whole merge.
 *
 * `DEFAULT_AGENTS` (`@paco/claude-code`) is not merged in here — it stays the
 * package-level fallback `resolveAgents` (`lib/agent/run-step.ts`) reaches
 * for when a caller passes no `agents` at all, and the seed source
 * `seedDefaultRoster` copies into a fresh organisation's roster. The web app
 * always resolves this function instead of leaving `agents` undefined, so
 * that fallback is reached only when this call itself fails upstream.
 */
export async function resolveChatAgents(
  organizationId: string | undefined,
): Promise<Record<string, ClaudeAgentDefinition>> {
  const [pluginAgents, roster] = await Promise.all([
    pluginAgentContributions(),
    organizationId ? getRoster(organizationId) : Promise.resolve({}),
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

/**
 * This turn's `--mcp-config` entries for enabled plugins
 * (`AgentCallOptions.mcpServers`, `lib/agent/types.ts`) — the dead-code fix
 * the plan's Task 12 brief calls out: nothing populated this field before,
 * so a plugin's `tools:register` slot and manifest-declared `mcpServers`
 * never reached a turn no matter how a plugin was installed and granted.
 *
 * `ensurePluginsStarted()` runs first so a plugin that is enabled but has
 * never been started this process (or has crashed and is due a retry) gets
 * a chance to come up before `listEnabledPluginsForMcp` reads the registry
 * — the same "start it, then read it" order `resolveChatAgents`/
 * `resolveChatSkills`'s own plugin contributions rely on being fresh per
 * turn.
 *
 * Resolved fresh every turn, right alongside the roster/skills above and
 * for the same reason: a plugin enabled or disabled since the last turn
 * should be visible on this one, not stuck at whatever the workflow saw
 * when it started.
 *
 * Returns `undefined` — never `{}` — when there is nothing to bridge, so a
 * caller can spread it in with `...(mcpServers ? { mcpServers } : {})` and
 * leave the field genuinely absent (see `AgentCallOptions.mcpServers`'s own
 * doc: absent keeps a plugin-free turn exactly as isolated as
 * `--strict-mcp-config` already makes it).
 *
 * Never throws: additive, never a turn dependency, same posture as memory
 * and the roster/skills resolvers above — a failure here must not fail a
 * turn (spec Section 2 degradation invariant).
 *
 * `registry.ts` and `mcp-bridge.ts` are both imported dynamically, inside
 * this function, rather than statically at module scope. A static import
 * would close a real cycle: `registry.ts` imports
 * `capability-handlers.ts`, whose `messages:post` handler imports
 * `lib/chat/submit-message.ts` -> `app/workflows/chat.ts` ->
 * `chat-sandbox-runtime.ts` -> straight back to this file
 * (`buildChatEnvironmentDetails`). Loading them only when a turn actually
 * needs to resolve its MCP config breaks that cycle the same way
 * `app/workflows/chat.ts` already dynamically imports THIS module for the
 * same underlying reason (see its own comment on that import).
 */
export async function resolveChatMcpServers(): Promise<
  Record<string, McpServerSpec> | undefined
> {
  try {
    const [
      { ensurePluginsStarted, listEnabledPluginsForMcp },
      { buildPluginMcpConfig },
    ] = await Promise.all([
      import("@/lib/plugins/registry"),
      import("@/lib/plugins/mcp-bridge"),
    ]);

    await ensurePluginsStarted();
    const enabled = await listEnabledPluginsForMcp();
    if (enabled.length === 0) {
      return undefined;
    }

    // Loopback, not the public origin: the bridge script this spawns runs
    // as its own process on this same machine (see `mcp-bridge.ts`'s doc),
    // the same reasoning `app/workflows/chat.ts` already applies to the
    // approval hook's callback URL. See `appLoopbackUrl`'s doc for why this
    // must never be built from `appUrl()`.
    const internalUrl = `${appLoopbackUrl()}/api/internal/plugin-tools`;
    const config = buildPluginMcpConfig(enabled, { internalUrl });
    return Object.keys(config).length > 0 ? config : undefined;
  } catch (error) {
    console.error(
      "resolveChatMcpServers: failed to build plugin mcp config for this turn",
      error,
    );
    return undefined;
  }
}
