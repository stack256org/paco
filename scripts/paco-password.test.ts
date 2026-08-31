import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACO = join(import.meta.dirname, "paco");

type RunResult = { stdout: string; stderr: string; exitCode: number };

async function runPaco(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["sh", PACO, ...args], {
    stdin: options.stdin ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
}

async function htpasswdPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paco-htpasswd-"));
  return join(dir, "paco.htpasswd");
}

describe("paco password", () => {
  test("writes a bcrypt entry for the fixed user 'paco'", async () => {
    const file = await htpasswdPath();

    const result = await runPaco(["password", "--stdin"], {
      stdin: "correct-horse-battery-staple\n",
      env: { PACO_HTPASSWD: file },
    });

    expect(result.exitCode).toBe(0);

    const contents = await readFile(file, "utf8");
    expect(contents).toMatch(/^paco:\$2[aby]\$/);
  });

  test("never stores the password in plaintext", async () => {
    const file = await htpasswdPath();
    const secret = "hunter2-not-in-the-file";

    await runPaco(["password", "--stdin"], {
      stdin: `${secret}\n`,
      env: { PACO_HTPASSWD: file },
    });

    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain(secret);
  });

  test("writes the file group-readable and no wider", async () => {
    const file = await htpasswdPath();

    await runPaco(["password", "--stdin"], {
      stdin: "some-password\n",
      env: { PACO_HTPASSWD: file },
    });

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  test("replaces the previous entry rather than appending a second", async () => {
    const file = await htpasswdPath();

    await runPaco(["password", "--stdin"], {
      stdin: "first-password\n",
      env: { PACO_HTPASSWD: file },
    });
    await runPaco(["password", "--stdin"], {
      stdin: "second-password\n",
      env: { PACO_HTPASSWD: file },
    });

    const lines = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  test("refuses an empty password", async () => {
    const file = await htpasswdPath();

    const result = await runPaco(["password", "--stdin"], {
      stdin: "\n",
      env: { PACO_HTPASSWD: file },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("empty password");
  });

  test("refuses an unknown argument", async () => {
    const file = await htpasswdPath();

    const result = await runPaco(["password", "--wat"], {
      env: { PACO_HTPASSWD: file },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--wat");
  });

  test("is listed in the help output", async () => {
    const result = await runPaco(["--help"]);

    expect(result.stdout).toContain("password");
  });
});
