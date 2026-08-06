/**
 * End-to-end check of the platform's core architecture.
 *
 * Proves the topology the app depends on: Claude Code runs on the host against
 * a workspace directory, and the Docker sandbox mounts that same directory, so
 * agent edits are immediately runnable inside the container.
 *
 * Requires a working `claude` CLI (subscription auth) and a Docker daemon;
 * skipped automatically when either is unavailable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Docker from "dockerode";
import { CONTAINER_WORKDIR, DockerSandbox } from "@paco/sandbox";
import { streamClaudeAgent, toRunUsage } from "@paco/claude-code";

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

function claudeAvailable(): boolean {
  return spawnSync("claude", ["--version"], { encoding: "utf-8" }).status === 0;
}

const ready = (await dockerAvailable()) && claudeAvailable();
const describeE2E = ready ? describe : describe.skip;

describeE2E("Claude Code + Docker sandbox", () => {
  const name = `e2e-${Date.now()}`;
  let workspace: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    workspace = path.join(os.tmpdir(), `paco-e2e-${Date.now()}`);
    sandbox = await DockerSandbox.create({
      name,
      hostWorkspace: workspace,
      ports: [3000],
      timeout: 300_000,
    });
  }, 300_000);

  afterAll(async () => {
    await sandbox?.destroy();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 120_000);

  test("agent edits on the host are runnable inside the container", async () => {
    const run = streamClaudeAgent(
      "Create a file named hello.js containing exactly: console.log('PACO_E2E_OK'). Then stop.",
      {
        cwd: workspace,
        model: "haiku",
        permissionMode: "acceptEdits",
        maxTurns: 6,
      },
    );

    // Draining the chunk stream is what makes the terminal result available.
    for await (const _chunk of run.chunks) {
      // chunks are exercised by the mapper's own tests
    }

    const result = await run.result;
    expect(result.is_error).toBe(false);

    // The agent wrote to the host directory...
    const onHost = await fs.readFile(path.join(workspace, "hello.js"), "utf-8");
    expect(onHost).toContain("PACO_E2E_OK");

    // ...and the container sees the same bytes through the bind mount.
    const exec = await sandbox.exec("node hello.js", CONTAINER_WORKDIR, 60_000);
    expect(exec.success).toBe(true);
    expect(exec.stdout).toContain("PACO_E2E_OK");

    // Usage accounting is populated for the run.
    const usage = toRunUsage(result);
    expect(usage.outputTokens).toBeGreaterThan(0);
  }, 600_000);
});
