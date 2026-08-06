import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

/**
 * A stub `gh` on PATH.
 *
 * Everything worth asserting here is about how the process is launched — that
 * the token travels in the environment rather than the command line, that
 * arguments are not interpreted by a shell, that a non-zero exit becomes a
 * legible error. None of that is observable without actually spawning
 * something, and none of it needs the real CLI or a network call.
 */
let binDir: string;
let originalPath: string | undefined;

function installStub(script: string) {
  const target = join(binDir, "gh");
  writeFileSync(target, `#!/bin/sh\n${script}\n`);
  chmodSync(target, 0o755);
}

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "paco-gh-stub-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

const { gh, GhError, ghJson, isGhMissing } = await import("./gh");

/** The imports above are values, so the instance type is derived from them. */
type CaughtGhError = InstanceType<typeof GhError>;

/** Await a rejection without narrowing it to `unknown` at every call site. */
function caught<T>(promise: Promise<T>): Promise<CaughtGhError> {
  return promise.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (error: unknown) => error as CaughtGhError,
  );
}

describe("gh", () => {
  test("passes the token by environment, never on the command line", async () => {
    // `ps` exposes another process's arguments to any user on the machine, so
    // a token in argv is a token leaked to everyone logged in.
    installStub('echo "ARGS:$*"; echo "TOKEN:$GH_TOKEN"');

    const { stdout } = await gh(["api", "user"], { token: "ghp_secret" });

    expect(stdout).toContain("ARGS:api user");
    expect(stdout).not.toContain("ARGS:ghp_secret");
    expect(stdout).toContain("TOKEN:ghp_secret");
  });

  test("also sets GITHUB_TOKEN, which git subcommands read", async () => {
    installStub('echo "$GITHUB_TOKEN"');

    const { stdout } = await gh(["repo", "clone", "o/r"], { token: "ghp_x" });

    expect(stdout.trim()).toBe("ghp_x");
  });

  test("forces HTTPS rather than inheriting the host's git protocol", async () => {
    // An operator whose `gh` is configured for SSH would otherwise get an
    // `git@github.com:` remote and a push from a server with no SSH agent —
    // which fails only *after* the repository has been created on GitHub.
    installStub('cat "$GH_CONFIG_DIR/config.yml"');

    const { stdout } = await gh(["repo", "create", "x"], { token: "t" });

    expect(stdout).toContain("git_protocol: https");
  });

  test("gives git a credential helper without touching global config", async () => {
    // `gh repo create --push` shells out to `git push`, and git does not read
    // GH_TOKEN. The documented alternative, `gh auth setup-git`, writes to the
    // operator's global git config.
    installStub(
      'echo "$GIT_CONFIG_COUNT|$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0"',
    );

    const { stdout } = await gh(["repo", "create", "x"], { token: "t" });

    expect(stdout.trim()).toBe(
      "1|credential.https://github.com.helper|!gh auth git-credential",
    );
  });

  test("disables prompts so a hung CLI fails fast instead of blocking", async () => {
    installStub('echo "$GH_PROMPT_DISABLED/$GIT_TERMINAL_PROMPT"');

    const { stdout } = await gh(["auth", "status"], { token: "t" });

    expect(stdout.trim()).toBe("1/0");
  });

  test("does not let arguments reach a shell", async () => {
    // A branch name or PR title is user input. Through a shell, `$(id)` and
    // `;rm` would run.
    installStub('printf "%s\\n" "$@"');

    const { stdout } = await gh(
      ["pr", "create", "--title", "$(id); rm -rf /"],
      {
        token: "t",
      },
    );

    expect(stdout).toContain("$(id); rm -rf /");
    expect(stdout).not.toContain("uid=");
  });

  test("runs in the directory it is given", async () => {
    installStub("pwd");

    const { stdout } = await gh(["status"], { token: "t", cwd: binDir });

    expect(stdout.trim()).toContain("paco-gh-stub-");
  });

  test("turns a rejected token into copy the user can act on", async () => {
    installStub('echo "gh: Bad credentials (HTTP 401)" >&2; exit 1');

    const error = await caught(gh(["api", "user"], { token: "t" }));

    expect(error).toBeInstanceOf(GhError);
    expect(error.message).toContain("Reconnect GitHub in Settings");
    expect(error.exitCode).toBe(1);
  });

  test("keeps the CLI's own words off the message and on the error", async () => {
    installStub('echo "gh: Bad credentials (HTTP 401)" >&2; exit 1');

    const error = await caught(gh(["api", "user"], { token: "t" }));

    expect(error.message).not.toContain("Bad credentials");
    expect(error.message).not.toContain("401");
    expect(error.detail).toContain("Bad credentials");
    expect(error.stderr).toContain("Bad credentials");
    expect(error.cause).toContain("Bad credentials");
  });

  test("skips a usage banner when recording the detail", async () => {
    installStub(
      'echo "Usage: gh pr create" >&2; echo "no commits" >&2; exit 1',
    );

    const error = await caught(gh(["pr", "create"], { token: "t" }));

    expect(error.detail).toContain("no commits");
    expect(error.detail).not.toContain("Usage:");
  });

  test("kills a command that overruns its timeout", async () => {
    installStub("sleep 5");

    const error = await caught(
      gh(["api", "user"], { token: "t", timeoutMs: 150 }),
    );

    expect(error.kind).toBe("timeout");
  });

  test("says what to install when gh is absent", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "paco-no-gh-"));
    const saved = process.env.PATH;
    process.env.PATH = emptyPath;

    try {
      const error = await caught(gh(["api", "user"], { token: "t" }));

      expect(isGhMissing(error)).toBe(true);
      expect(error.message).toContain("cli.github.com");
    } finally {
      process.env.PATH = saved;
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});

describe("ghJson", () => {
  test("parses JSON output", async () => {
    installStub('echo \'{"login":"octocat"}\'');

    const user = await ghJson<{ login: string }>(["api", "user"], {
      token: "t",
    });

    expect(user.login).toBe("octocat");
  });

  test("reports non-JSON output rather than throwing a parse error", async () => {
    installStub('echo "not json at all"');

    const error = await caught(ghJson(["api", "user"], { token: "t" }));

    expect(error).toBeInstanceOf(GhError);
    expect(error.message).toContain("couldn't read");
    expect(error.detail).toContain("not JSON");
  });
});
