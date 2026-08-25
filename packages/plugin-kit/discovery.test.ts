import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { discoverPlugin } from "./discovery.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "plugin-kit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function minimalManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: "my-plugin",
    version: "1.0.0",
    description: "Does a thing.",
    pacoApi: 1,
    ...overrides,
  };
}

async function writeManifest(
  rootDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    path.join(rootDir, "plugin.json"),
    JSON.stringify(minimalManifest(overrides)),
  );
}

describe("discoverPlugin", () => {
  test("discovers every populated slot with absolute, sorted paths", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir, { capabilities: ["channels:ingress"] });

    await mkdir(path.join(rootDir, "tools"));
    await writeFile(path.join(rootDir, "tools", "a.ts"), "");
    await writeFile(path.join(rootDir, "tools", "b.js"), "");

    await mkdir(path.join(rootDir, "channels"));
    await writeFile(path.join(rootDir, "channels", "slack.ts"), "");

    await mkdir(path.join(rootDir, "skills", "greet"), { recursive: true });
    await writeFile(path.join(rootDir, "skills", "greet", "SKILL.md"), "");

    await mkdir(path.join(rootDir, "agents"));
    await writeFile(path.join(rootDir, "agents", "helper.json"), "{}");

    await mkdir(path.join(rootDir, "renderers"));
    await writeFile(path.join(rootDir, "renderers", "panel.html"), "");

    await mkdir(path.join(rootDir, "hooks"));
    await writeFile(path.join(rootDir, "hooks", "pre.ts"), "");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const absoluteRoot = path.resolve(rootDir);
    expect(result.plugin.rootDir).toBe(absoluteRoot);
    expect(result.plugin.manifest.name).toBe("my-plugin");
    expect(result.plugin.slots).toEqual({
      tools: [
        path.join(absoluteRoot, "tools", "a.ts"),
        path.join(absoluteRoot, "tools", "b.js"),
      ],
      channels: [path.join(absoluteRoot, "channels", "slack.ts")],
      skills: [path.join(absoluteRoot, "skills", "greet", "SKILL.md")],
      agents: [path.join(absoluteRoot, "agents", "helper.json")],
      renderers: [path.join(absoluteRoot, "renderers", "panel.html")],
      hooks: [path.join(absoluteRoot, "hooks", "pre.ts")],
    });

    for (const files of Object.values(result.plugin.slots)) {
      for (const file of files) {
        expect(path.isAbsolute(file)).toBe(true);
      }
    }
  });

  test("returns empty arrays for every slot when only the manifest exists", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir);

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plugin.slots).toEqual({
      tools: [],
      channels: [],
      skills: [],
      agents: [],
      renderers: [],
      hooks: [],
    });
  });

  test("returns ok:false with a manifest error when plugin.json is missing", async () => {
    const rootDir = await makeTempDir();

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });

  test("returns ok:false with a manifest error for a schema-invalid plugin.json", async () => {
    const rootDir = await makeTempDir();
    await writeFile(
      path.join(rootDir, "plugin.json"),
      JSON.stringify({ name: "Not Valid!" }),
    );

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.length).toBeGreaterThan(0);
  });

  test("returns ok:false for malformed JSON in plugin.json", async () => {
    const rootDir = await makeTempDir();
    await writeFile(path.join(rootDir, "plugin.json"), "{ this is not json");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when a channels/ slot exists without channels:ingress", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir);

    await mkdir(path.join(rootDir, "channels"));
    await writeFile(path.join(rootDir, "channels", "events.ts"), "");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("channels/");
    expect(result.error).toContain('"channels:ingress"');
  });

  test("discovers a channels/ slot when channels:ingress is requested", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir, { capabilities: ["channels:ingress"] });

    await mkdir(path.join(rootDir, "channels"));
    await writeFile(path.join(rootDir, "channels", "events.ts"), "");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plugin.slots.channels).toEqual([
      path.join(path.resolve(rootDir), "channels", "events.ts"),
    ]);
  });

  test("sorts slot files alphabetically regardless of creation order", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir);
    await mkdir(path.join(rootDir, "hooks"));

    // Written in reverse alphabetical order to prove sorting isn't
    // incidental to filesystem readdir ordering.
    await writeFile(path.join(rootDir, "hooks", "c.ts"), "");
    await writeFile(path.join(rootDir, "hooks", "b.js"), "");
    await writeFile(path.join(rootDir, "hooks", "a.ts"), "");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const names = result.plugin.slots.hooks.map((file) => path.basename(file));
    expect(names).toEqual(["a.ts", "b.js", "c.ts"]);
  });

  test("ignores files with non-matching extensions in each slot", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir);

    await mkdir(path.join(rootDir, "tools"));
    await writeFile(path.join(rootDir, "tools", "a.ts"), "");
    await writeFile(path.join(rootDir, "tools", "readme.md"), "");
    await writeFile(path.join(rootDir, "tools", "notes.txt"), "");

    await mkdir(path.join(rootDir, "agents"));
    await writeFile(path.join(rootDir, "agents", "helper.json"), "{}");
    await writeFile(path.join(rootDir, "agents", "helper.yaml"), "");

    await mkdir(path.join(rootDir, "renderers"));
    await writeFile(path.join(rootDir, "renderers", "panel.html"), "");
    await writeFile(path.join(rootDir, "renderers", "panel.css"), "");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plugin.slots.tools.map((f) => path.basename(f))).toEqual([
      "a.ts",
    ]);
    expect(result.plugin.slots.agents.map((f) => path.basename(f))).toEqual([
      "helper.json",
    ]);
    expect(result.plugin.slots.renderers.map((f) => path.basename(f))).toEqual([
      "panel.html",
    ]);
  });

  test("skips skill directories that have no SKILL.md file", async () => {
    const rootDir = await makeTempDir();
    await writeManifest(rootDir);

    await mkdir(path.join(rootDir, "skills", "no-skill-file"), {
      recursive: true,
    });
    await mkdir(path.join(rootDir, "skills", "has-skill"), {
      recursive: true,
    });
    await writeFile(path.join(rootDir, "skills", "has-skill", "SKILL.md"), "");

    const result = await discoverPlugin(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const absoluteRoot = path.resolve(rootDir);
    expect(result.plugin.slots.skills).toEqual([
      path.join(absoluteRoot, "skills", "has-skill", "SKILL.md"),
    ]);
  });
});
