import * as path from "node:path";

/**
 * Which tool calls a human has to see before they run.
 *
 * Paco runs Claude Code on the host with permission prompts bypassed, because
 * every other mode breaks it: `acceptEdits` gates Bash, so the agent can write
 * an app and then fail to install or start it, and `dontAsk` denies Bash
 * outright. That left nothing between the agent and the operator's machine
 * except a line in the system prompt.
 *
 * So the gate moved here. The CLI's `PreToolUse` hook fires even under
 * `bypassPermissions`, hands over the tool name and its arguments, and can
 * refuse with a reason the agent handles gracefully — which is the per-call
 * approval an interactive session would give you.
 *
 * The policy has to earn its keep in both directions. Asking about everything
 * makes the product unusable: a single turn reads dozens of files. Asking
 * about nothing is where this started. So the line is drawn at *what leaves a
 * mark outside this chat's worktree*.
 */

export type ApprovalDecision =
  | { kind: "allow" }
  | { kind: "ask"; reason: string };

export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
};

/**
 * Tools that only ever read.
 *
 * A turn makes dozens of these. Prompting for them would train the user to
 * click "allow" without reading, which is worse than not asking.
 */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoWrite",
  "Task",
  "Skill",
  "AskUserQuestion",
]);

/** Tools that write files. Safe inside the worktree, not outside it. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Where a write tool says it is going to write.
 *
 * Every write tool spells this differently, and reading the wrong key is not a
 * cosmetic miss. The lookup used to be `file_path || filePath || path`, so
 * NotebookEdit — whose key is `notebook_path` — always came back empty, and an
 * empty path was then treated as "inside the worktree":
 * `NotebookEdit {notebook_path: "/etc/evil.ipynb"}` ran with no prompt.
 *
 * `null` means no key held a usable path. That is a question, not a pass.
 */
const WRITE_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
];

function writeTarget(input: Record<string, unknown>): string | null {
  for (const key of WRITE_PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Global options `git` accepts *before* the subcommand.
 *
 * They are not cosmetic: `git -c core.pager=cat push --force` is a force-push,
 * but `\bgit\s+push\b` never sees it because `push` is no longer the token
 * after `git`. Anything matching on a git subcommand has to skip these first.
 *
 * The options that take a separate value are listed by name, because a bare
 * `\S+` after any option would swallow the subcommand itself.
 */
const GIT_GLOBAL_OPTIONS = String.raw`(?:(?:-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:=|\s+)\S+\s+|--?[A-Za-z][\w-]*\s+)*`;

function gitSubcommand(rest: string): RegExp {
  return new RegExp(String.raw`\bgit\s+${GIT_GLOBAL_OPTIONS}${rest}`);
}

/**
 * Commands worth stopping the agent for.
 *
 * The bar is deliberately high: an action gets a prompt only when it is
 * irreversible *and* reaches outside the chat's own worktree. Everything inside
 * the worktree — deleting node_modules, resetting, cleaning, rewriting local
 * history — is recoverable, because a checkpoint is taken before every turn and
 * the whole worktree is a throwaway branch.
 *
 * This list was much longer. Prompting for ordinary work (`rm -rf node_modules`
 * before reinstalling, `git reset --hard` to undo a bad edit) meant a card
 * appeared several times a turn, and a prompt that appears constantly is one
 * the user learns to approve without reading. The rare genuinely destructive
 * action then arrives looking exactly like the noise. Fewer prompts is what
 * makes the remaining ones mean something.
 *
 * Matched on the whole command string rather than a parsed argv, because the
 * agent writes pipelines and `&&` chains — the dangerous part is rarely the
 * first word.
 */
const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Remote history and remote state: not recoverable from this machine.
  {
    pattern: gitSubcommand(String.raw`push\b.*(--force(-with-lease)?|-f\b)`),
    reason: "force-pushes, which can discard commits on the remote",
  },
  {
    pattern: gitSubcommand(String.raw`push\b.*(--delete\b|\s:[\w./-]+)`),
    reason: "deletes a branch on the remote",
  },
  {
    pattern: /\bgh\s+repo\s+delete\b/,
    reason: "deletes a GitHub repository",
  },
  {
    pattern: /\bgh\s+(release|secret|ssh-key|gpg-key)\s+delete\b/,
    reason: "deletes something on GitHub that cannot be restored from here",
  },

  // The machine itself, which is the operator's, not the agent's.
  { pattern: /\b(sudo|doas)\b/, reason: "runs with elevated privileges" },
  {
    pattern: /\b(shutdown|reboot|halt)\b/,
    reason: "affects the whole machine",
  },
  {
    pattern: /\bmkfs(\.[a-z0-9]+)?\b|\bdd\s+.*\bof=/,
    reason: "writes directly to a device",
  },
  {
    // `[^;&]*` rather than `[^|]*`: the pipeline may have stages in between,
    // and `curl -s https://x.sh | tee /tmp/a | bash` still ends in a shell.
    // The old `[^|]*` could not reach past the first pipe, so adding any stage
    // walked straight through this rule.
    pattern: /\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
    reason: "pipes a downloaded script straight into a shell",
  },

  // Published to the world under someone's name.
  {
    pattern: /\b(npm|pnpm|yarn)\s+publish\b/,
    reason: "publishes a package publicly",
  },
];

/**
 * Recursive deletes get their own check rather than a line in the list above,
 * because they are the one rule with an exception: a delete confined to the
 * worktree is ordinary work and must not prompt.
 */
const RECURSIVE_DELETE_REASON =
  "deletes files recursively outside this chat's workspace";

/** Split a command line where one command ends and the next begins. */
function splitIntoCommands(command: string): string[] {
  return command.split(/\|\||&&|[;\n|&]/);
}

/**
 * Whether a token is one of `rm`'s recursive or force flags.
 *
 * Both spellings of every flag, because `rm` accepts both and the gate has to
 * accept whichever the caller chose.
 */
function isRecursiveOrForceFlag(token: string): boolean {
  if (token.startsWith("--")) {
    return /^--(recursive|force|dir)$/.test(token);
  }
  // A short-option bundle: `-r`, `-R`, `-f`, `-rf`, `-fR`, …
  return /^-[a-zA-Z]*[rRf]/.test(token);
}

/**
 * Whether a command line asks `rm` to delete recursively (or to force).
 *
 * This was one regex, `rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]`, and every part of
 * it was walkable:
 *
 * - `[rf]` is lowercase-only, so POSIX's `rm -R /Users/me/Documents` passed;
 * - `-[a-zA-Z]*` stops at the second dash, so `rm --recursive --force …` passed;
 * - it required a flag immediately after `rm`, so `rm /Users/me/Documents -rf`
 *   — which GNU and BSD both honour — passed.
 *
 * Splitting into commands and then into tokens means the flag is found wherever
 * in the argument list it was written, in whichever spelling.
 */
function isRecursiveDelete(command: string): boolean {
  return splitIntoCommands(command).some((segment) => {
    const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
    const rmIndex = tokens.findIndex(
      (token) => token === "rm" || token.endsWith("/rm"),
    );

    return (
      rmIndex >= 0 && tokens.slice(rmIndex + 1).some(isRecursiveOrForceFlag)
    );
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Whether a path stays inside the chat's worktree.
 *
 * Relative paths resolve against the worktree, so they are inside by
 * definition. An absolute path has to be checked, and `path.relative`
 * starting with `..` is the reliable way — string prefix comparison says
 * `/work/session-2` is inside `/work/session`.
 *
 * A path this function cannot read is *not* inside. The empty target used to
 * return `true`, which made every missing path key an allow: `Write {}` — no
 * `file_path` at all — was approved without anyone seeing it. Callers that
 * genuinely have no path must ask, so this fails closed.
 */
function isInsideWorktree(target: string, worktree: string): boolean {
  if (!(target && worktree)) {
    return false;
  }

  const resolved = path.resolve(worktree, target);
  const relative = path.relative(path.resolve(worktree), resolved);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Decide whether a tool call can proceed unattended.
 *
 * `worktree` is the chat's own directory. Everything Paco asks the agent to do
 * happens there, so it is the natural boundary: inside is the agent's to
 * change, outside is the user's machine.
 */
export function decideApproval(
  call: ToolCall,
  worktree: string,
): ApprovalDecision {
  if (READ_ONLY_TOOLS.has(call.name)) {
    return { kind: "allow" };
  }

  if (WRITE_TOOLS.has(call.name)) {
    const target = writeTarget(call.input);
    if (target === null) {
      // The call names no path this policy can read, so it cannot be shown to
      // stay inside the worktree. Asking is the only honest answer; the
      // previous code read the missing key as `""` and allowed it.
      return {
        kind: "ask",
        reason: `runs ${call.name} without a readable path, so Paco cannot tell where it writes`,
      };
    }
    if (isInsideWorktree(target, worktree)) {
      return { kind: "allow" };
    }
    return {
      kind: "ask",
      reason: `writes to ${target}, which is outside this chat's workspace`,
    };
  }

  if (call.name === "Bash" || call.name === "BashOutput") {
    const command = asString(call.input.command);
    if (!command) {
      return { kind: "allow" };
    }

    for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return { kind: "ask", reason };
      }
    }

    // Last, because it is the only rule with an exception: a recursive delete
    // that provably stays inside the worktree is ordinary work.
    if (
      isRecursiveDelete(command) &&
      !isRecursiveDeleteConfinedToWorktree(command, worktree)
    ) {
      return { kind: "ask", reason: RECURSIVE_DELETE_REASON };
    }

    return { kind: "allow" };
  }

  // An unrecognised tool is one this policy has never been reasoned about —
  // most likely from an MCP server the user configured. Ask rather than
  // assume, since the alternative is a silent allow-list bypass.
  return {
    kind: "ask",
    reason: `runs ${call.name}, which Paco does not recognise`,
  };
}

/**
 * Whether a recursive delete only touches paths inside this chat's worktree.
 *
 * `rm -rf node_modules` is ordinary work — reinstalling dependencies, clearing
 * a build directory — and prompting for it turned the approval card into
 * something to click past, which is how a real prompt gets missed. The check
 * that matters is not the flags but the target: inside the worktree the damage
 * is bounded and revertible, outside it is the operator's machine.
 *
 * Deliberately conservative. Anything that is not a plain literal path — a
 * variable, a glob reaching upward, a bare `/`, no operand at all — is not
 * recognised as confined and still asks.
 */
function isRecursiveDeleteConfinedToWorktree(
  command: string,
  worktree: string | undefined,
): boolean {
  if (!worktree) {
    return false;
  }

  // Only a lone `rm`; a compound line may hide anything after the delete.
  if (/[;&|`]|\$\(/.test(command)) {
    return false;
  }

  const match = /^\s*rm\s+(.*)$/.exec(command);
  if (!match) {
    return false;
  }

  const operands = (match[1] ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("-"));

  if (operands.length === 0) {
    return false;
  }

  return operands.every((operand) => {
    const unquoted = operand.replace(/^['"]|['"]$/g, "");
    // A variable or command substitution could expand to anything.
    if (/[$*?~]/.test(unquoted) || unquoted.length === 0) {
      return false;
    }
    return isInsideWorktree(unquoted, worktree);
  });
}
