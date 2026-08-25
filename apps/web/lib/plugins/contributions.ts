import "server-only";

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ClaudeAgentDefinition } from "@paco/claude-code";
import {
  frontmatterToOptions,
  parseSkillFrontmatter,
  type SkillMetadata,
} from "@paco/sandbox";
import { agentDefinitionSchema } from "@/lib/agent/agent-definition-schema";
import { listPlugins } from "@/lib/db/plugins";
import { pluginDir } from "@/lib/plugins/install";

/**
 * What an enabled plugin contributes to a chat's environment.
 *
 * Both exports here scan the plugin's own directory on disk (the same tree
 * `installPlugin` moved into place), never a plugin's running process — this
 * is discovery, not execution, exactly like `discoverPlugin` in
 * `@paco/plugin-kit`. Neither function ever throws: a chat turn must not fail
 * because one plugin's `skills/` or `agents/` directory is missing or
 * malformed, so every failure is logged and the offending entry is skipped.
 */

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Missing or unreadable directory: no slot entries, not an error.
    return [];
  }
}

async function enabledPluginIds(): Promise<string[]> {
  const rows = await listPlugins();
  return rows.filter((row) => row.enabled).map((row) => row.id);
}

/** One plugin's `skills/<name>/SKILL.md` entries, parsed with the same frontmatter parser the sandbox workspace uses. */
async function skillsForPlugin(pluginId: string): Promise<SkillMetadata[]> {
  const skillsRoot = path.join(pluginDir(pluginId), "skills");
  const entries = (await readDirSafe(skillsRoot))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const skills: SkillMetadata[] = [];
  for (const entry of entries) {
    const skillDir = path.join(skillsRoot, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");

    let content: string;
    try {
      content = await readFile(skillFile, "utf-8");
    } catch {
      // No SKILL.md in this directory: not a skill slot entry.
      continue;
    }

    const parsed = parseSkillFrontmatter(content);
    if (!parsed.success) {
      console.error(
        `pluginSkillContributions: invalid SKILL.md frontmatter, skipping`,
        { pluginId, skillDir },
      );
      continue;
    }

    skills.push({
      name: parsed.data.name,
      description: parsed.data.description,
      path: skillDir,
      filename: "SKILL.md",
      options: frontmatterToOptions(parsed.data),
    });
  }

  return skills;
}

/** Every enabled plugin's skills, in plugin-id order. Never throws. */
export async function pluginSkillContributions(): Promise<SkillMetadata[]> {
  try {
    const pluginIds = await enabledPluginIds();
    const perPlugin = await Promise.all(pluginIds.map(skillsForPlugin));
    return perPlugin.flat();
  } catch (error) {
    console.error(
      "pluginSkillContributions: failed to load plugin skills",
      error,
    );
    return [];
  }
}

/** One plugin's `agents/*.json` entries, validated against the roster's zod mirror of `ClaudeAgentDefinition`. */
async function agentsForPlugin(
  pluginId: string,
): Promise<Record<string, ClaudeAgentDefinition>> {
  const agentsRoot = path.join(pluginDir(pluginId), "agents");
  const entries = (await readDirSafe(agentsRoot)).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );

  const agents: Record<string, ClaudeAgentDefinition> = {};
  for (const entry of entries) {
    const filePath = path.join(agentsRoot, entry.name);
    const name = path.basename(entry.name, ".json");

    let json: unknown;
    try {
      json = JSON.parse(await readFile(filePath, "utf-8"));
    } catch (error) {
      console.error(
        `pluginAgentContributions: could not read/parse agent file, skipping`,
        { pluginId, filePath, error },
      );
      continue;
    }

    const parsed = agentDefinitionSchema.safeParse(json);
    if (!parsed.success) {
      console.error(
        `pluginAgentContributions: invalid agent definition, skipping`,
        { pluginId, filePath, error: parsed.error.message },
      );
      continue;
    }

    agents[name] = parsed.data;
  }

  return agents;
}

/**
 * Every enabled plugin's agents, keyed by filename (without `.json`).
 *
 * Later plugins (by id, ascending — `listPlugins`'s own order) win a name
 * collision between two plugins; the roster wins over all of them once this
 * is merged into a chat's agent options (see `resolveChatAgents` in
 * `chat-environment.ts`). Never throws.
 */
export async function pluginAgentContributions(): Promise<
  Record<string, ClaudeAgentDefinition>
> {
  try {
    const pluginIds = await enabledPluginIds();
    const perPlugin = await Promise.all(pluginIds.map(agentsForPlugin));
    const merged: Record<string, ClaudeAgentDefinition> = {};
    for (const agents of perPlugin) {
      Object.assign(merged, agents);
    }
    return merged;
  } catch (error) {
    console.error(
      "pluginAgentContributions: failed to load plugin agents",
      error,
    );
    return {};
  }
}
