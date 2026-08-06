import "server-only";

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GH_TIMEOUT_MESSAGE,
  GH_UNREADABLE_MESSAGE,
  ghFailureDetail,
  ghFailureMessage,
} from "@/lib/github/gh-failure-copy";

/**
 * Run the `gh` CLI as a specific user.
 *
 * Paco drives GitHub through `gh` rather than the REST API directly: it is the
 * same tool the agent has on its PATH, it already knows how to create a
 * repository, open a pull request, and read check runs, and it removes the
 * GitHub App — its manifest flow, installation tokens, and a webhook endpoint
 * that could never be reached on a self-hosted localhost anyway.
 *
 * Every call is explicitly scoped to one user's token. There is no ambient
 * authentication: `gh` normally falls back to the host's own keyring login,
 * which on a shared Paco would silently act as the operator instead of the
 * person who clicked the button. The environment below makes that impossible.
 */

/**
 * Why a `gh` call failed.
 *
 * One error type with a discriminator rather than a class per failure:
 * callers branch on the reason — a missing CLI is an operator problem with a
 * fix to suggest, a rejected token is the user's to correct — and a union
 * keeps that branch exhaustive instead of a chain of `instanceof` checks that
 * can silently miss a case.
 */
export type GhFailureKind = "failed" | "missing" | "timeout";

export class GhError extends Error {
  constructor(
    message: string,
    readonly kind: GhFailureKind,
    readonly exitCode: number | null,
    readonly stderr: string,
    /**
     * The command, its exit code and `gh`'s own first line of output.
     *
     * Separate from `message` because `message` is rendered in toasts and
     * dialogs: callers hand it straight to the UI, so anything technical put
     * there is technical the user reads. This is for the log.
     */
    readonly detail?: string,
  ) {
    super(message, detail === undefined ? undefined : { cause: detail });
    this.name = "GhError";
  }
}

/** The CLI is not installed, so no token can help. */
export function isGhMissing(error: unknown): boolean {
  return error instanceof GhError && error.kind === "missing";
}

const GH_MISSING_MESSAGE =
  "Paco needs GitHub's own command-line tool to do this, and it isn't installed on this machine. Install it from https://cli.github.com, then restart Paco.";

const GIT_MISSING_MESSAGE =
  "Paco needs Git to do this, and it isn't installed on this machine. Install it, then restart Paco.";

export type GhResult = {
  stdout: string;
  stderr: string;
};

export type GhOptions = {
  /** The user's GitHub token. Passed by environment, never on the command line. */
  token: string;
  /** Working directory — a chat's worktree for anything repository-scoped. */
  cwd?: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/** Output beyond this is truncated; no `gh` response Paco reads is this large. */
const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * A `gh` configuration directory that belongs to Paco, not to the operator.
 *
 * Two reasons it cannot use the host's own `~/.config/gh`:
 *
 * The first is `git_protocol`. An operator who set it to `ssh` — the default
 * after `gh auth login` chooses SSH — makes `gh repo create --push` add an
 * `git@github.com:` remote and push over SSH. The web server has no SSH agent,
 * so the push fails with "Permission denied (publickey)" *after* the
 * repository has already been created on GitHub, leaving a half-finished
 * state. Observed exactly that on the first live run.
 *
 * The second is isolation: the host config also carries aliases, a default
 * host, and a keyring login, none of which should influence a call that is
 * supposed to act only as the token it was given.
 */
const globalForGhConfig = globalThis as typeof globalThis & {
  __pacoGhConfigDir?: string;
};

function ghConfigDir(): string {
  if (globalForGhConfig.__pacoGhConfigDir) {
    return globalForGhConfig.__pacoGhConfigDir;
  }

  const dir = join(homedir(), ".paco", "gh");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yml"), "git_protocol: https\n", "utf-8");

  globalForGhConfig.__pacoGhConfigDir = dir;
  return dir;
}

function buildEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // `gh` prefers GH_TOKEN over its keyring, which is what pins each call to
    // the requesting user rather than whoever ran `gh auth login` on the host.
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    // Nothing is attached to a terminal, so a prompt would hang until the
    // timeout instead of failing with something legible.
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    // `gh` shells out to git for clone and push; keep that non-interactive too.
    GIT_TERMINAL_PROMPT: "0",
    GH_CONFIG_DIR: ghConfigDir(),
    /*
     * Teach git to authenticate HTTPS pushes with the same token, without
     * writing to the operator's global git config.
     *
     * `gh repo create --push` runs `git push`, and git does not read GH_TOKEN.
     * The documented fix is `gh auth setup-git`, which installs a credential
     * helper globally — a side effect on the host that Paco has no business
     * causing. These variables inject the same helper for this process only.
     */
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!gh auth git-credential",
  };
}

/**
 * Run `gh` and return its output.
 *
 * Arguments are passed as an array and never through a shell, so a branch
 * name, repository description, or PR title containing quotes, `$`, or `;` is
 * data rather than something the shell can act on.
 */
export function gh(args: string[], options: GhOptions): Promise<GhResult> {
  return run("gh", args, options);
}

/**
 * Run `git` with the same credentials as `gh`.
 *
 * Pushing a branch is a git operation, but it is authenticated by the very
 * same token, through the very same credential helper. Reusing this
 * environment is what keeps that true — a separate spawn would have to
 * duplicate the token, the helper, and the non-interactive flags, and would
 * drift from them.
 */
export function git(args: string[], options: GhOptions): Promise<GhResult> {
  return run("git", args, options);
}

function run(
  command: "gh" | "git",
  args: string[],
  options: GhOptions,
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // `detached` makes the child a process-group leader so the whole group can
    // be signalled at once. `gh` shells out to `git` for clone and push, and
    // signalling only `gh` leaves that grandchild running with the pipe still
    // open — the call then never settles, because `close` waits for every
    // writer to let go of stdout.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildEnv(options.token),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone, or never became a group leader. Fall back to the
        // child alone; there is nothing further to do either way.
        child.kill("SIGTERM");
      }
    };

    const timer = setTimeout(() => {
      killGroup();
      // Settled here rather than from `close`: a grandchild that ignores
      // SIGTERM would otherwise hold the request open past its own timeout,
      // which is exactly the failure the timeout exists to prevent.
      finish(() =>
        reject(
          new GhError(
            GH_TIMEOUT_MESSAGE,
            "timeout",
            null,
            stderr,
            `${command} ${args[0] ?? ""} timed out after ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, MAX_OUTPUT_BYTES);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new GhError(
                command === "gh" ? GH_MISSING_MESSAGE : GIT_MISSING_MESSAGE,
                "missing",
                null,
                "",
              )
            : error,
        ),
      );
    });

    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(
          new GhError(
            ghFailureMessage({ command, stderr, exitCode: code }),
            "failed",
            code,
            stderr,
            ghFailureDetail({ command, args, stderr, exitCode: code }),
          ),
        );
      });
    });
  });
}

/** Run `gh` and parse its `--json` output. */
export async function ghJson<T>(
  args: string[],
  options: GhOptions,
): Promise<T> {
  const { stdout } = await gh(args, options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GhError(
      GH_UNREADABLE_MESSAGE,
      "failed",
      0,
      stdout.slice(0, 500),
      `gh ${args[0] ?? ""} returned output that is not JSON`,
    );
  }
}
