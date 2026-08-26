import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type FakePluginRow = { id: string; enabled: boolean };

let pluginRows: FakePluginRow[] = [];
// Spread over the real module rather than replacing it outright: `install.ts`
// (imported transitively via `pluginDir`) imports `upsertPlugin` from this
// same module, and a from-scratch mock that omitted it would break that
// import with no relation to what this file tests.
const realDbPlugins = await import("@/lib/db/plugins");
mock.module("@/lib/db/plugins", () => ({
  ...realDbPlugins,
  listPlugins: () => Promise.resolve(pluginRows),
}));

// `pluginDir(id)` (lib/plugins/install.ts) resolves under `pluginsDir()`,
// which honors `PACO_PLUGINS_DIR` — the same override `install.test.ts`
// uses — so fixture plugin trees can be written straight under it without
// mocking `install.ts` itself.
const { pluginSkillContributions, pluginAgentContributions } =
  await import("./contributions");

let pluginsRoot: string;
let outsideDirs: string[] = [];
const consoleErrorCalls: unknown[][] = [];
const originalConsoleError = console.error;

beforeEach(async () => {
  pluginsRoot = await mkdtemp(path.join(os.tmpdir(), "paco-plugins-fixture-"));
  process.env.PACO_PLUGINS_DIR = pluginsRoot;
  pluginRows = [];
  outsideDirs = [];
  consoleErrorCalls.length = 0;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
});

afterEach(async () => {
  console.error = originalConsoleError;
  delete process.env.PACO_PLUGINS_DIR;
  await rm(pluginsRoot, { recursive: true, force: true });
  await Promise.all(
    outsideDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeSkill(
  pluginId: string,
  skillName: string,
  frontmatter: string,
) {
  const skillDir = path.join(pluginsRoot, pluginId, "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), frontmatter);
}

async function writeAgent(pluginId: string, fileName: string, json: unknown) {
  const agentsDir = path.join(pluginsRoot, pluginId, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    path.join(agentsDir, fileName),
    typeof json === "string" ? json : JSON.stringify(json),
  );
}

/**
 * A skill directory living entirely outside `pluginsRoot`, with a valid
 * `SKILL.md` inside — the payload a `skills/<name>` symlink would smuggle in
 * if the plugin dir's containment check didn't catch it.
 */
async function makeOutsideSkillDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paco-outside-skill-"));
  outsideDirs.push(dir);
  await writeFile(
    path.join(dir, "SKILL.md"),
    ["---", "name: escape", "description: Should never surface", "---"].join(
      "\n",
    ),
  );
  return dir;
}

describe("pluginSkillContributions", () => {
  test("parses a valid skill from an enabled plugin", async () => {
    pluginRows = [{ id: "plugin-a", enabled: true }];
    await writeSkill(
      "plugin-a",
      "greet",
      ["---", "name: greet", "description: Says hello", "---", "Body"].join(
        "\n",
      ),
    );

    const skills = await pluginSkillContributions();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "greet",
      description: "Says hello",
      filename: "SKILL.md",
    });
    expect(skills[0]?.path).toBe(
      path.join(pluginsRoot, "plugin-a", "skills", "greet"),
    );
  });

  test("skips a skill with invalid frontmatter, without throwing", async () => {
    pluginRows = [{ id: "plugin-a", enabled: true }];
    // Missing the required `description` field.
    await writeSkill(
      "plugin-a",
      "broken",
      ["---", "name: broken", "---", "Body"].join("\n"),
    );

    const skills = await pluginSkillContributions();

    expect(skills).toEqual([]);
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
  });

  test("skips a disabled plugin entirely", async () => {
    pluginRows = [{ id: "plugin-a", enabled: false }];
    await writeSkill(
      "plugin-a",
      "greet",
      ["---", "name: greet", "description: Says hello", "---"].join("\n"),
    );

    const skills = await pluginSkillContributions();

    expect(skills).toEqual([]);
  });

  test("never throws when listPlugins itself fails", async () => {
    mock.module("@/lib/db/plugins", () => ({
      ...realDbPlugins,
      listPlugins: () => Promise.reject(new Error("db unavailable")),
    }));

    const skills = await pluginSkillContributions();

    expect(skills).toEqual([]);

    // Restore the working mock for later tests in this file.
    mock.module("@/lib/db/plugins", () => ({
      ...realDbPlugins,
      listPlugins: () => Promise.resolve(pluginRows),
    }));
  });

  test("skips a symlinked skill directory that escapes the plugin's own directory, without throwing", async () => {
    pluginRows = [{ id: "plugin-a", enabled: true }];
    const outsideDir = await makeOutsideSkillDir();
    const skillsDir = path.join(pluginsRoot, "plugin-a", "skills");
    await mkdir(skillsDir, { recursive: true });
    await symlink(outsideDir, path.join(skillsDir, "escape"));

    const skills = await pluginSkillContributions();

    expect(skills).toEqual([]);
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
  });

  test("collects skills from multiple enabled plugins", async () => {
    pluginRows = [
      { id: "plugin-a", enabled: true },
      { id: "plugin-b", enabled: true },
    ];
    await writeSkill(
      "plugin-a",
      "one",
      ["---", "name: one", "description: First", "---"].join("\n"),
    );
    await writeSkill(
      "plugin-b",
      "two",
      ["---", "name: two", "description: Second", "---"].join("\n"),
    );

    const skills = await pluginSkillContributions();

    expect(skills.map((s) => s.name).sort()).toEqual(["one", "two"]);
  });
});

describe("pluginAgentContributions", () => {
  test("validates and keys an agent json by filename", async () => {
    pluginRows = [{ id: "plugin-a", enabled: true }];
    await writeAgent("plugin-a", "helper.json", {
      description: "A helper agent",
      prompt: "You help.",
      model: "sonnet",
    });

    const agents = await pluginAgentContributions();

    expect(agents.helper).toEqual({
      description: "A helper agent",
      prompt: "You help.",
      model: "sonnet",
    });
  });

  test("skips an invalid agent definition, without throwing", async () => {
    pluginRows = [{ id: "plugin-a", enabled: true }];
    // Missing the required `prompt` field.
    await writeAgent("plugin-a", "broken.json", {
      description: "Missing a prompt",
    });

    const agents = await pluginAgentContributions();

    expect(agents).toEqual({});
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
  });

  test("skips a file that isn't valid JSON, without throwing", async () => {
    pluginRows = [{ id: "plugin-a", enabled: true }];
    await writeAgent("plugin-a", "broken.json", "{ not json");

    const agents = await pluginAgentContributions();

    expect(agents).toEqual({});
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
  });

  test("skips a disabled plugin entirely", async () => {
    pluginRows = [{ id: "plugin-a", enabled: false }];
    await writeAgent("plugin-a", "helper.json", {
      description: "A helper agent",
      prompt: "You help.",
    });

    const agents = await pluginAgentContributions();

    expect(agents).toEqual({});
  });

  test("never throws when listPlugins itself fails", async () => {
    mock.module("@/lib/db/plugins", () => ({
      ...realDbPlugins,
      listPlugins: () => Promise.reject(new Error("db unavailable")),
    }));

    const agents = await pluginAgentContributions();

    expect(agents).toEqual({});

    // Restore the working mock for later tests in this file.
    mock.module("@/lib/db/plugins", () => ({
      ...realDbPlugins,
      listPlugins: () => Promise.resolve(pluginRows),
    }));
  });
});
