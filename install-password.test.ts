import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const INSTALL = join(import.meta.dirname, "install.sh");

type RunResult = { stdout: string; stderr: string; exitCode: number };

async function runInstall(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["sh", INSTALL, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
}

describe("install.sh password handling", () => {
  test("documents --password and PACO_PASSWORD", async () => {
    const result = await runInstall(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--password");
    expect(result.stdout).toContain("PACO_PASSWORD");
  });

  test("states that a password is always set", async () => {
    const result = await runInstall(["--help"]);

    // The no-TTY path must be discoverable from --help alone: someone
    // reading this before piping it to sh needs to know an unattended
    // install still ends up protected.
    expect(result.stdout).toContain("generated");
  });

  test("rejects --password with no value", async () => {
    const result = await runInstall(["--password"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--password needs a value");
  });
});
