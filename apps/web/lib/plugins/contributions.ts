import "server-only";

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
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

/**
 * Whether `candidate` resolves (after symlinks) to somewhere under `root`.
 *
 * A plugin's `skills/<name>` entry can be a symlink — nothing stops one from
 * pointing outside the plugin's own installed directory, at an arbitrary path
 * on the host. Reading through it would let an installed-but-unprivileged
 * plugin surface a skill sourced from anywhere the process can read, so every
 * skill directory is realpath-resolved and checked against the plugin's own
 * (also realpath-resolved) root before its `SKILL.md` is read.
 *
 * Note: `packages/sandbox/skills/discovery.ts`'s `discoverSkills` (workspace
 * skills) has the same gap and does not get this check here — tracked
 * separately.
 */
function isContainedIn(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** One plugin's `skills/<name>/SKILL.md` entries, parsed with the same frontmatter parser the sandbox workspace uses. */
async function skillsForPlugin(pluginId: string): Promise<SkillMetadata[]> {
  const root = pluginDir(pluginId);
  const skillsRoot = path.join(root, "skills");
  // A symlinked entry reports `isDirectory() === false` (Dirent reflects the
  // link itself, not its target), so `isSymbolicLink()` entries are kept
  // here too — otherwise a symlink escaping the plugin's directory would be
  // silently dropped before the containment check below ever saw it.
  const entries = (await readDirSafe(skillsRoot))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    return [];
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    // The plugin directory itself doesn't exist or isn't readable: nothing
    // to contribute, and nothing to have escaped through either.
    return [];
  }

  const skills: SkillMetadata[] = [];
  for (const entry of entries) {
    const skillDir = path.join(skillsRoot, entry.name);

    let realSkillDir: string;
    try {
      realSkillDir = await realpath(skillDir);
    } catch {
      // Vanished between the readdir above and here: not a skill slot entry.
      continue;
    }

    if (!isContainedIn(realRoot, realSkillDir)) {
      console.error(
        "pluginSkillContributions: skill directory escapes the plugin's own directory (symlink?), skipping",
        { pluginId, skillDir, resolved: realSkillDir },
      );
      continue;
    }

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
