import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  channelSlotKey,
  checkChannelDeclarations,
  checkChannelsCapability,
  parsePluginManifest,
  type PluginManifest,
} from "./manifest.ts";

export interface PluginDescriptor {
  manifest: PluginManifest;
  rootDir: string;
  slots: {
    tools: string[]; // tools/*.ts|*.js
    channels: string[]; // channels/*.ts|*.js
    skills: string[]; // skills/*/SKILL.md
    agents: string[]; // agents/*.json
    renderers: string[]; // renderers/*.html (sandboxed iframe entries)
    hooks: string[]; // hooks/*.ts|*.js
  };
}

/**
 * Reads plugin.json at rootDir and parses it. Any read failure (missing
 * file, unreadable, malformed JSON) is normalized to `undefined` so the
 * result always flows through the same manifest-validation error path.
 */
async function readManifestJson(manifestPath: string): Promise<unknown> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    // Missing file, unreadable, or malformed JSON: fall through to
    // `undefined`, handled below.
  }
}

function isCodeFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function isJsonFile(name: string): boolean {
  return name.endsWith(".json");
}

function isHtmlFile(name: string): boolean {
  return name.endsWith(".html");
}

/**
 * Lists files directly inside `dir` whose name matches `matches`, as
 * absolute paths sorted alphabetically. A missing or unreadable directory
 * yields an empty array rather than an error.
 */
async function discoverFileSlot(
  dir: string,
  matches: (name: string) => boolean,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && matches(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Lists `skills/<name>/SKILL.md` as absolute paths sorted alphabetically
 * by skill directory name. A skill directory without a SKILL.md file is
 * skipped, not an error.
 */
async function discoverSkillSlot(skillsDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skillDirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const skillPaths: string[] = [];
  for (const name of skillDirNames) {
    const skillMdPath = path.join(skillsDir, name, "SKILL.md");
    try {
      await readFile(skillMdPath);
      skillPaths.push(skillMdPath);
    } catch {
      // No SKILL.md in this directory: not a skill slot entry.
    }
  }
  return skillPaths;
}

/**
 * Discovers a plugin's manifest and slot contents at rootDir.
 *
 * This is discovery only: it stats and reads files (plugin.json and, to
 * confirm their existence, SKILL.md files) but never imports or executes
 * any plugin code. Executing plugin code is exclusively the plugin host's
 * job.
 */
export async function discoverPlugin(
  rootDir: string,
): Promise<
  { ok: true; plugin: PluginDescriptor } | { ok: false; error: string }
> {
  const absoluteRootDir = path.resolve(rootDir);
  const manifestJson = await readManifestJson(
    path.join(absoluteRootDir, "plugin.json"),
  );

  const parsed = parsePluginManifest(manifestJson);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const [tools, channels, agents, renderers, hooks, skills] = await Promise.all(
    [
      discoverFileSlot(path.join(absoluteRootDir, "tools"), isCodeFile),
      discoverFileSlot(path.join(absoluteRootDir, "channels"), isCodeFile),
      discoverFileSlot(path.join(absoluteRootDir, "agents"), isJsonFile),
      discoverFileSlot(path.join(absoluteRootDir, "renderers"), isHtmlFile),
      discoverFileSlot(path.join(absoluteRootDir, "hooks"), isCodeFile),
      discoverSkillSlot(path.join(absoluteRootDir, "skills")),
    ],
  );

  const channelsCapabilityError = checkChannelsCapability(
    parsed.manifest,
    channels,
  );
  if (channelsCapabilityError) {
    return { ok: false, error: channelsCapabilityError };
  }

  const channelDeclarationError = checkChannelDeclarations(
    parsed.manifest,
    channels.map((filePath) => channelSlotKey(filePath)),
  );
  if (channelDeclarationError) {
    return { ok: false, error: channelDeclarationError };
  }

  return {
    ok: true,
    plugin: {
      manifest: parsed.manifest,
      rootDir: absoluteRootDir,
      slots: { tools, channels, skills, agents, renderers, hooks },
    },
  };
}
