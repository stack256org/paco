import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { discoverEvalScenarios } = await import("./discovery");

let repoDir: string;

beforeEach(async () => {
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-evals-discovery-"));
});

afterEach(async () => {
  await fs.rm(repoDir, { force: true, recursive: true });
});

async function writeEvalFile(filename: string, content: string): Promise<void> {
  const evalsDir = path.join(repoDir, "evals");
  await fs.mkdir(evalsDir, { recursive: true });
  await fs.writeFile(path.join(evalsDir, filename), content, "utf8");
}

describe("discoverEvalScenarios", () => {
  test("returns empty results for a repo with no evals directory", async () => {
    const result = await discoverEvalScenarios(repoDir);
    expect(result).toEqual({ scenarios: [], errors: [] });
  });

  test("discovers a valid scenario file", async () => {
    await writeEvalFile(
      "smoke.json",
      JSON.stringify({
        name: "smoke",
        prompt: "Create a file named ok.txt containing OK",
        assertions: [{ kind: "file-exists", path: "ok.txt" }],
      }),
    );

    const result = await discoverEvalScenarios(repoDir);

    expect(result.errors).toEqual([]);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({
      name: "smoke",
      prompt: "Create a file named ok.txt containing OK",
      maxTurns: 25,
    });
  });

  test("applies the maxTurns default and preserves an explicit override", async () => {
    await writeEvalFile(
      "capped.json",
      JSON.stringify({
        name: "capped",
        prompt: "do the thing",
        assertions: [{ kind: "file-exists", path: "a" }],
        maxTurns: 5,
      }),
    );

    const result = await discoverEvalScenarios(repoDir);
    expect(result.scenarios[0]?.maxTurns).toBe(5);
  });

  test("reports a parse error for invalid JSON without failing discovery", async () => {
    await writeEvalFile("broken.json", "{ not json");
    await writeEvalFile(
      "good.json",
      JSON.stringify({
        name: "good",
        prompt: "do the thing",
        assertions: [{ kind: "file-exists", path: "a" }],
      }),
    );

    const result = await discoverEvalScenarios(repoDir);

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.name).toBe("good");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken.json");
  });

  test("reports a schema validation error naming the failing field", async () => {
    await writeEvalFile(
      "invalid.json",
      JSON.stringify({
        name: "invalid",
        prompt: "do the thing",
        assertions: [],
      }),
    );

    const result = await discoverEvalScenarios(repoDir);

    expect(result.scenarios).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid.json");
  });

  test("rejects an assertion with an unknown kind", async () => {
    await writeEvalFile(
      "unknown-kind.json",
      JSON.stringify({
        name: "unknown-kind",
        prompt: "do the thing",
        assertions: [{ kind: "does-not-exist" }],
      }),
    );

    const result = await discoverEvalScenarios(repoDir);

    expect(result.scenarios).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  test("ignores non-JSON files in the evals directory", async () => {
    await writeEvalFile("readme.md", "# not a scenario");
    const result = await discoverEvalScenarios(repoDir);
    expect(result).toEqual({ scenarios: [], errors: [] });
  });
});
