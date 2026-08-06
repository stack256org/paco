import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildArgs, type ClaudeCodeOptions } from "./options.ts";
import {
  type ClaudeMessage,
  type ClaudeResultMessage,
  isResultMessage,
} from "./types.ts";

export class ClaudeCodeError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface ClaudeCodeRun {
  /** Every protocol message, in order, as the CLI emits it. */
  messages: AsyncIterable<ClaudeMessage>;
  /** Resolves once the terminal `result` message has been observed. */
  result: Promise<ClaudeResultMessage>;
  /** Session id, available as soon as the `system/init` message arrives. */
  sessionId: Promise<string>;
  /** Underlying process, exposed for diagnostics. */
  process: ChildProcessWithoutNullStreams;
}

/**
 * Exit code the CLI uses when a run is terminated with SIGTERM. Documented
 * behavior: the turn is aborted, the Bash process tree is killed, SessionEnd
 * hooks run, and the process exits 143. Treated as a clean cancellation.
 */
const SIGTERM_EXIT_CODE = 143;

function deferred<T>() {
  return Promise.withResolvers<T>();
}

/**
 * Run Claude Code headlessly against a workspace directory.
 *
 * The process runs on the host with `cwd` pointing at the sandbox's bind-mounted
 * workspace, so edits made here are immediately visible to the container that
 * executes the app.
 */
export function runClaudeCode(
  prompt: string,
  options: ClaudeCodeOptions,
  signal?: AbortSignal,
): ClaudeCodeRun {
  const child = spawn(options.executable ?? "claude", buildArgs(options), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const resultDeferred = deferred<ClaudeResultMessage>();
  const sessionDeferred = deferred<string>();

  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    // Bounded so a chatty run can't grow this without limit.
    stderr = (stderr + chunk).slice(-64_000);
  });

  // Send the turn, then close stdin so the CLI knows the turn is complete.
  child.stdin.write(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    })}\n`,
  );
  child.stdin.end();

  const onAbort = () => {
    // SIGTERM (not SIGKILL) so the CLI can tear down child processes and run
    // its SessionEnd hooks rather than orphaning them.
    child.kill("SIGTERM");
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  async function* iterate(): AsyncGenerator<ClaudeMessage> {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let sawResult = false;

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let message: ClaudeMessage;
        try {
          message = JSON.parse(trimmed) as ClaudeMessage;
        } catch {
          // A non-JSON line means the CLI wrote diagnostics to stdout. Skip it
          // rather than failing the run.
          continue;
        }

        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init" &&
          "session_id" in message
        ) {
          sessionDeferred.resolve(message.session_id as string);
        }

        if (isResultMessage(message)) {
          sawResult = true;
          resultDeferred.resolve(message);
        }

        yield message;
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.once("close", (code) => resolve(code));
      });

      if (!sawResult) {
        const aborted = signal?.aborted || exitCode === SIGTERM_EXIT_CODE;
        const error = aborted
          ? new ClaudeCodeError("Claude Code run was aborted", exitCode, stderr)
          : new ClaudeCodeError(
              `Claude Code exited without a result (code ${exitCode})${
                stderr ? `: ${stderr.trim().slice(-2000)}` : ""
              }`,
              exitCode,
              stderr,
            );
        if (aborted) {
          error.name = "AbortError";
        }
        resultDeferred.reject(error);
        sessionDeferred.reject(error);
        throw error;
      }
    } finally {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
  }

  // Surface spawn failures (missing binary) on both promises.
  child.on("error", (error) => {
    resultDeferred.reject(error);
    sessionDeferred.reject(error);
  });

  return {
    messages: iterate(),
    result: resultDeferred.promise,
    sessionId: sessionDeferred.promise,
    process: child,
  };
}
