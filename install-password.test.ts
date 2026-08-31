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
  test("documents PACO_PASSWORD", async () => {
    const result = await runInstall(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PACO_PASSWORD");
  });

  test("states that a password is always set", async () => {
    const result = await runInstall(["--help"]);

    // The no-TTY path must be discoverable from --help alone: someone
    // reading this before piping it to sh needs to know an unattended
    // install still ends up protected.
    expect(result.stdout).toContain("generated");
  });

  test("rejects --password as an argument", async () => {
    // There is deliberately no --password flag: a password passed as an
    // argument sits in argv, which `ps` shows to every user on the machine
    // and which lands in root's shell history. PACO_PASSWORD does the same
    // job without either exposure. This must be rejected like any other
    // unrecognised argument, not silently accepted or ignored.
    const result = await runInstall(["--password", "hunter2"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unrecognised argument");
  });

  test("does not hang with no TTY and no explicit flags", async () => {
    // This is the one failure in this file that could hang the advertised
    // `curl ... | sudo sh` install: stdin is a pipe, not a terminal, so
    // neither the domain nor the password prompt may block on `read`. Run
    // unprivileged, so this exits early on the root check rather than 0 —
    // what matters is that it exits at all, promptly, instead of blocking
    // on a prompt that a pipe can never answer. A regression here must fail
    // this test rather than hang CI, hence the explicit timeout that kills
    // the process and fails the assertion below.
    const proc = Bun.spawn(["sh", INSTALL, "--dry-run"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 5000);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    expect(timedOut).toBe(false);
    expect(typeof exitCode).toBe("number");
  }, 10_000);
});
