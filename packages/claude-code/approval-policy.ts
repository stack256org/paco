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
 *
 * ## Why Bash is an allow-list and not a pattern list
 *
 * `Bash` used to be the exception to that line: it was checked against about a
 * dozen regular expressions over the raw command string, and anything that did
 * not match ran unattended. That made the containment the write tools enforce
 * decorative, because the shell can write anywhere a `Write` cannot:
 *
 * ```text
 * echo pwned > /Users/me/.zshrc                allowed
 * echo '…' > ~/.paco/hooks/pre-tool-use.mjs    allowed  ← disables this gate
 * cp ~/.ssh/id_rsa /tmp/x && echo done         allowed
 * mv /Users/me/Documents /tmp/gone             allowed
 * git config --global core.hooksPath /tmp/h    allowed
 * ```
 *
 * The shape was wrong, not the entries. A regular expression matches the text
 * the agent typed; the kernel runs what the *shell* makes of that text, and the
 * two are only accidentally the same. `G=push; git $G --force origin main`,
 * `git push --for''ce origin main` and a `git push \` continued onto the next
 * line all reach `execve("git", ["push", "--force", …])`, and none of them
 * contain the string the pattern was looking for. Each hole is individually
 * patchable and there is always another one, which is the same lesson
 * `packages/plugin-host/SECURITY.md` records about module denylists.
 *
 * So `Bash` is now decided the way the write tools always were — by asking
 * where the command writes, and by knowing what it is:
 *
 * 1. **Parse instead of match.** {@link parseCommandLine} is a small shell
 *    tokenizer: it removes quoting the way the shell does (so `--for''ce`
 *    becomes `--force`), honours line continuations, splits on `;`, `&&`,
 *    `||`, `|`, `&` and newlines, and pulls redirections and their targets out
 *    of each segment.
 * 2. **Refuse to guess.** Anything whose meaning depends on state this policy
 *    cannot see — `$VAR`, `$(…)`, backticks, subshells, process substitution —
 *    stops the parse and asks. This is where `$G` and `$(cat target.txt)` land,
 *    and it is a property of the design rather than a pattern that has to
 *    anticipate them.
 * 3. **Every write target is checked against the worktree.** Redirections
 *    (`>`, `>>`, `&>`) and the operands of the commands that move bytes
 *    around (`cp`, `mv`, `rm`, `tee`, `tar`, …) all go through
 *    {@link isInsideWorktree}, exactly like `Write` and `Edit`.
 * 4. **The command itself must be recognised.** {@link SAFE_COMMANDS} is an
 *    allow-list of heads that are known to stay inside the worktree, some with
 *    an argument check for the forms that do not (`git push --force`,
 *    `git config --global`, `npm install <pkg>`, `find … -delete`,
 *    `curl -o /outside`). Anything else — `sh`, `python3`, `awk`, `sudo`,
 *    `docker`, an MCP-installed binary, a typo — asks. The default answer for
 *    an unrecognised command is a question, not a pass.
 *
 * A false positive here costs one card in the chat. A false negative costs the
 * operator's machine, and this file is the only thing in the way, so the trade
 * is not close.
 *
 * ## What this does not stop
 *
 * The agent is allowed to run the worktree's own code — `node script.js`,
 * `pnpm build`, `./scripts/deploy.sh` — because that is the product. It is also
 * allowed to write files in the worktree without asking. Those two together
 * mean a *deliberately* hostile agent can still reach the host: write a script,
 * then run it. Nothing decided from a command line can prevent that; only an
 * OS-level sandbox (seatbelt/Landlock, or running the CLI in the container)
 * can. What this policy does is make every such escape take at least two steps
 * that both appear in the transcript, instead of one unremarkable `Bash` call —
 * and in particular it stops the single line that overwrites Paco's own hook,
 * which is what made the difference between a gate and a suggestion.
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

/* -------------------------------------------------------------------------- */
/* Shell parsing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One argv entry, after the shell's quote removal.
 *
 * `text` is what `execve` would receive, which is the whole point: `--for''ce`
 * and `--force` are the same word here, and a pattern over the raw string can
 * never say that. `glob` and `tilde` record that the shell would have expanded
 * this word against the filesystem or the user's home before the program saw
 * it — so the text is *not* the final path and must not be treated as one.
 */
type Word = {
  text: string;
  glob: boolean;
  tilde: boolean;
};

type Redirection = {
  direction: "in" | "out";
  target: Word | null;
};

/** One simple command: the words between two shell operators. */
type Segment = {
  words: Word[];
  redirections: Redirection[];
};

type Parse = { ok: true; segments: Segment[] } | { ok: false; reason: string };

const OPAQUE_EXPANSION =
  "uses a shell expansion Paco cannot resolve, so it cannot tell what would actually run";
const OPAQUE_STRUCTURE =
  "uses shell syntax Paco cannot read — a subshell, a group, or a process substitution";
const UNBALANCED_QUOTE = "has an unbalanced quote, so Paco cannot read it";

/** Redirection targets that are not really files. `>/dev/null` is everywhere. */
const WRITABLE_DEVICES = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/fd/1",
  "/dev/fd/2",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FD_ONLY = /^\d+$/;
const HEREDOC_DELIMITER = /^\s*(['"]?)([A-Za-z0-9_.-]+)\1/;
const FD_DUPLICATE = /^&(\d+|-)/;

/**
 * Split a command line into simple commands, the way a shell would.
 *
 * Deliberately partial. It understands quoting, escaping, line continuation,
 * the control operators, redirections and heredocs — and it *refuses* the
 * rest. Every construct whose result depends on something this process cannot
 * see (a variable, a command substitution, a subshell) ends the parse with a
 * reason, because the alternative is to guess, and a wrong guess here is a
 * silent allow.
 */
/**
 * The tokenizer's mutable state.
 *
 * A record rather than four `let`s: TypeScript resets the narrowing of an
 * object property at every call, but keeps narrowing a `let` that only the
 * nested helpers below reassign — which would have it believe `current` is
 * permanently `null`, and stop it from catching a real mistake here.
 */
type ScanState = {
  words: Word[];
  redirections: Redirection[];
  current: Word | null;
  pending: Redirection | null;
};

function startWord(state: ScanState): Word {
  state.current ??= { text: "", glob: false, tilde: false };
  return state.current;
}

function endWord(state: ScanState): void {
  const word = state.current;
  if (word === null) {
    return;
  }
  state.current = null;
  const redirection = state.pending;
  if (redirection === null) {
    state.words.push(word);
    return;
  }
  redirection.target = word;
  state.redirections.push(redirection);
  state.pending = null;
}

function endSegment(state: ScanState, segments: Segment[]): void {
  endWord(state);
  const dangling = state.pending;
  if (dangling !== null) {
    state.redirections.push(dangling);
    state.pending = null;
  }
  if (state.words.length > 0 || state.redirections.length > 0) {
    segments.push({ words: state.words, redirections: state.redirections });
  }
  state.words = [];
  state.redirections = [];
}

/** `2>file`: leading digits are a file descriptor, not the start of a word. */
function isFileDescriptor(word: Word | null): boolean {
  return word !== null && FD_ONLY.test(word.text);
}

/**
 * Consume a heredoc body, returning where the command resumes and whether the
 * body has to be refused.
 *
 * An unquoted delimiter means the shell expands the body, and a `$(…)` in
 * there runs before the heredoc is written anywhere — so that body is code,
 * not data.
 */
function skipHeredoc(
  command: string,
  from: number,
  body: { delimiter: string; quoted: boolean },
): { next: number; refusal: string | null } {
  let end = command.length;
  let next = command.length;
  let cursor = from;
  while (cursor <= command.length) {
    const newline = command.indexOf("\n", cursor);
    const line = command.slice(
      cursor,
      newline === -1 ? command.length : newline,
    );
    if (line.trim() === body.delimiter) {
      end = cursor;
      next = newline === -1 ? command.length : newline + 1;
      break;
    }
    if (newline === -1) {
      break;
    }
    cursor = newline + 1;
  }
  const text = command.slice(from, end);
  if (!body.quoted && (text.includes("$(") || text.includes("`"))) {
    return { next, refusal: OPAQUE_EXPANSION };
  }
  return { next, refusal: null };
}

/**
 * Split a command line into simple commands, the way a shell would.
 *
 * Deliberately partial. It understands quoting, escaping, line continuation,
 * the control operators, redirections and heredocs — and it *refuses* the
 * rest. Every construct whose result depends on something this process cannot
 * see (a variable, a command substitution, a subshell) ends the parse with a
 * reason, because the alternative is to guess, and a wrong guess here is a
 * silent allow.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a tokenizer is one flat dispatch over the input; splitting it up would hide the control flow that makes it reviewable.
function parseCommandLine(command: string): Parse {
  const segments: Segment[] = [];
  const state: ScanState = {
    words: [],
    redirections: [],
    current: null,
    pending: null,
  };
  let heredoc: { delimiter: string; quoted: boolean } | null = null;
  let index = 0;

  while (index < command.length) {
    const character = command[index] as string;

    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        startWord(state).text += "\\";
        index += 1;
        continue;
      }
      // A backslash-newline is a line continuation: it disappears, and the
      // command keeps going. `git push \<newline> --force` is `git push --force`.
      if (next === "\n") {
        index += 2;
        continue;
      }
      startWord(state).text += next;
      index += 2;
      continue;
    }

    if (character === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) {
        return { ok: false, reason: UNBALANCED_QUOTE };
      }
      startWord(state).text += command.slice(index + 1, end);
      index = end + 1;
      continue;
    }

    if (character === '"') {
      const word = startWord(state);
      index += 1;
      let closed = false;
      while (index < command.length) {
        const inner = command[index] as string;
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "\\") {
          const next = command[index + 1];
          if (next === undefined) {
            break;
          }
          if (next !== "\n") {
            word.text += next;
          }
          index += 2;
          continue;
        }
        if (inner === "$" || inner === "`") {
          return { ok: false, reason: OPAQUE_EXPANSION };
        }
        word.text += inner;
        index += 1;
      }
      if (!closed) {
        return { ok: false, reason: UNBALANCED_QUOTE };
      }
      continue;
    }

    if (character === "$" || character === "`") {
      return { ok: false, reason: OPAQUE_EXPANSION };
    }

    // Covers subshells, function bodies and `<(…)` / `>(…)` alike.
    if (character === "(" || character === ")") {
      return { ok: false, reason: OPAQUE_STRUCTURE };
    }

    if (character === "#" && state.current === null) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline;
      continue;
    }

    if (character === " " || character === "\t" || character === "\r") {
      endWord(state);
      index += 1;
      continue;
    }

    if (character === "\n") {
      endSegment(state, segments);
      index += 1;
      const body = heredoc;
      if (body !== null) {
        heredoc = null;
        const skipped = skipHeredoc(command, index, body);
        if (skipped.refusal !== null) {
          return { ok: false, reason: skipped.refusal };
        }
        index = skipped.next;
      }
      continue;
    }

    if (character === ";") {
      endSegment(state, segments);
      index += 1;
      continue;
    }

    if (character === "&") {
      const next = command[index + 1];
      if (next === "&") {
        endSegment(state, segments);
        index += 2;
        continue;
      }
      if (next === ">") {
        endWord(state);
        index += command[index + 2] === ">" ? 3 : 2;
        state.pending = { direction: "out", target: null };
        continue;
      }
      endSegment(state, segments);
      index += 1;
      continue;
    }

    if (character === "|") {
      const next = command[index + 1];
      endSegment(state, segments);
      index += next === "|" || next === "&" ? 2 : 1;
      continue;
    }

    if (character === ">") {
      if (isFileDescriptor(state.current)) {
        state.current = null;
      } else {
        endWord(state);
      }
      let cursor = index + 1;
      if (command[cursor] === ">" || command[cursor] === "|") {
        cursor += 1;
      }
      if (command[cursor] === "&") {
        const duplicate = FD_DUPLICATE.exec(command.slice(cursor));
        if (duplicate !== null) {
          // `2>&1` names no file at all.
          index = cursor + duplicate[0].length;
          continue;
        }
        cursor += 1;
      }
      state.pending = { direction: "out", target: null };
      index = cursor;
      continue;
    }

    if (character === "<") {
      if (isFileDescriptor(state.current)) {
        state.current = null;
      } else {
        endWord(state);
      }
      let cursor = index + 1;
      if (command[cursor] === "<") {
        cursor += 1;
        if (command[cursor] === "<") {
          // A here-string is data, not a path.
          state.pending = { direction: "in", target: null };
          index = cursor + 1;
          continue;
        }
        if (command[cursor] === "-") {
          cursor += 1;
        }
        if (heredoc !== null) {
          return { ok: false, reason: OPAQUE_STRUCTURE };
        }
        const delimiter = HEREDOC_DELIMITER.exec(command.slice(cursor));
        if (delimiter === null) {
          return { ok: false, reason: OPAQUE_STRUCTURE };
        }
        heredoc = {
          delimiter: delimiter[2] as string,
          quoted: delimiter[1] !== "",
        };
        index = cursor + delimiter[0].length;
        continue;
      }
      if (command[cursor] === "&") {
        const duplicate = FD_DUPLICATE.exec(command.slice(cursor));
        if (duplicate !== null) {
          index = cursor + duplicate[0].length;
          continue;
        }
        cursor += 1;
      }
      state.pending = { direction: "in", target: null };
      index = cursor;
      continue;
    }

    if (
      character === "*" ||
      character === "?" ||
      character === "[" ||
      character === "]" ||
      character === "{" ||
      character === "}"
    ) {
      const word = startWord(state);
      word.glob = true;
      word.text += character;
      index += 1;
      continue;
    }

    if (character === "~" && state.current === null) {
      const word = startWord(state);
      word.tilde = true;
      word.text += character;
      index += 1;
      continue;
    }

    startWord(state).text += character;
    index += 1;
  }

  endSegment(state, segments);
  return { ok: true, segments };
}

/* -------------------------------------------------------------------------- */
/* Per-command checks                                                         */
/* -------------------------------------------------------------------------- */

/** Returns a reason to ask, or `null` if this call may proceed unattended. */
type CommandCheck = (args: Word[], worktree: string) => string | null;

function isFlag(word: Word): boolean {
  return word.text.startsWith("-") && word.text !== "-";
}

function operands(args: Word[]): Word[] {
  return args.filter((word) => !isFlag(word));
}

/**
 * Whether a word provably names a path inside the worktree.
 *
 * A word the shell would still expand — `*`, `~` — is not a path yet, so it
 * cannot be shown to be inside anything. That is an ask, not an allow.
 */
function wordInside(word: Word, worktree: string): boolean {
  if (word.glob || word.tilde) {
    return false;
  }
  return isInsideWorktree(word.text, worktree);
}

function outsideReason(name: string, word: Word): string {
  return `runs ${name} on ${word.text}, which is outside this chat's workspace`;
}

function looksLikePath(text: string): boolean {
  return text.includes("/") || text.startsWith("~") || text.startsWith(".");
}

/** The value half of a `--option=value` argument, when it looks like a path. */
function attachedPathValues(args: Word[]): Word[] {
  const values: Word[] = [];
  for (const word of args) {
    if (!isFlag(word)) {
      continue;
    }
    const equals = word.text.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const value = word.text.slice(equals + 1);
    if (looksLikePath(value)) {
      values.push({
        text: value,
        glob: word.glob,
        tilde: value.startsWith("~"),
      });
    }
  }
  return values;
}

/**
 * The check for every command that moves bytes between paths.
 *
 * Every operand has to be inside the worktree, source as well as destination.
 * Checking only the destination would be enough to stop the damage, but not
 * enough to stop `cp ~/.ssh/id_rsa ./key` staging a secret for the next
 * command, and the extra question costs nothing.
 */
function pathCommand(name: string): CommandCheck {
  return (args, worktree) => {
    const targets = operands(args);
    if (targets.length === 0) {
      return `runs ${name} without a target Paco can check`;
    }
    for (const target of [...targets, ...attachedPathValues(args)]) {
      if (!wordInside(target, worktree)) {
        return outsideReason(name, target);
      }
    }
    return null;
  };
}

/** The value of `--flag value` or `--flag=value`, if this argument is it. */
function optionValue(
  args: Word[],
  position: number,
  names: Set<string>,
): Word | null {
  const word = args[position];
  if (word === undefined) {
    return null;
  }
  const equals = word.text.indexOf("=");
  if (equals > 0 && names.has(word.text.slice(0, equals))) {
    const value = word.text.slice(equals + 1);
    return { text: value, glob: word.glob, tilde: value.startsWith("~") };
  }
  if (names.has(word.text)) {
    return args[position + 1] ?? null;
  }
  return null;
}

/** Commands whose named output option must land inside the worktree. */
function outputOptionCommand(name: string, options: Set<string>): CommandCheck {
  return (args, worktree) => {
    for (let position = 0; position < args.length; position += 1) {
      const value = optionValue(args, position, options);
      if (value === null) {
        continue;
      }
      if (!wordInside(value, worktree)) {
        return outsideReason(name, value);
      }
    }
    return null;
  };
}

/* --- find ---------------------------------------------------------------- */

/**
 * `find`'s actions are a closed set, which is what makes checking them honest:
 * these are every way it can write or execute rather than print.
 */
const FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const findCheck: CommandCheck = (args, worktree) => {
  for (const word of args) {
    if (FIND_ACTIONS.has(word.text)) {
      return "runs find with an action that deletes files or runs another command";
    }
  }
  // Everything before the first expression operator is a starting point.
  for (const word of args) {
    if (word.text.startsWith("-")) {
      break;
    }
    if (!wordInside(word, worktree)) {
      return outsideReason("find", word);
    }
  }
  return null;
};

/* --- git ----------------------------------------------------------------- */

/** Git's global options that name a directory it will then work in. */
const GIT_PATH_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);

/**
 * Config keys whose value git hands to a shell or executes directly.
 *
 * `core.hooksPath` is the one that matters most here: it points git at a
 * directory of scripts that run on the agent's own next commit.
 */
const GIT_EXECUTED_CONFIG_KEYS = new Set([
  "core.hookspath",
  "core.sshcommand",
  "core.askpass",
  "core.fsmonitor",
  "credential.helper",
  "gpg.program",
  "diff.external",
  "init.templatedir",
  "sequence.editor",
  "uploadpack.packobjectshook",
]);

const GIT_EXECUTED_CONFIG_PREFIXES = ["alias.", "filter.", "protocol."];
const CONFIG_VALUE_METACHARACTERS = /[\s/$`;&|<>()]/;

function badGitConfig(assignment: string): string | null {
  const equals = assignment.indexOf("=");
  const key = (
    equals < 0 ? assignment : assignment.slice(0, equals)
  ).toLowerCase();
  if (
    GIT_EXECUTED_CONFIG_KEYS.has(key) ||
    GIT_EXECUTED_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    return "sets a git configuration key whose value git runs as a program";
  }
  // Any other key is only dangerous if its value can name or become one.
  if (
    equals >= 0 &&
    CONFIG_VALUE_METACHARACTERS.test(assignment.slice(equals + 1))
  ) {
    return "sets a git configuration value that could name another program";
  }
  return null;
}

const GIT_PUSH_FORCE_FLAGS = new Set(["--force", "-f", "--mirror"]);
const GIT_PUSH_DELETE_FLAGS = new Set(["--delete", "-d", "--prune"]);

const gitPushCheck: CommandCheck = (args) => {
  for (const word of args) {
    if (
      GIT_PUSH_FORCE_FLAGS.has(word.text) ||
      word.text.startsWith("--force-with-lease") ||
      word.text.startsWith("--force-if-includes")
    ) {
      return "force-pushes, which can discard commits on the remote";
    }
    if (GIT_PUSH_DELETE_FLAGS.has(word.text)) {
      return "deletes a branch on the remote";
    }
    if (!isFlag(word) && word.text.startsWith(":")) {
      return "deletes a branch on the remote";
    }
  }
  return null;
};

const GIT_CONFIG_FILE_OPTIONS = new Set(["--file", "-f"]);

const gitConfigCheck: CommandCheck = (args, worktree) => {
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] as Word;
    if (word.text === "--global" || word.text === "--system") {
      return "changes git configuration for the whole machine, outside this chat's workspace";
    }
    const file = optionValue(args, position, GIT_CONFIG_FILE_OPTIONS);
    if (file !== null && !wordInside(file, worktree)) {
      return outsideReason("git config", file);
    }
  }
  const [key] = operands(args);
  if (key !== undefined) {
    const refusal = badGitConfig(key.text);
    if (refusal !== null) {
      return refusal;
    }
  }
  return null;
};

const gitCloneCheck: CommandCheck = (args, worktree) => {
  const targets = operands(args);
  const destination = targets.length >= 2 ? targets.at(-1) : undefined;
  if (destination !== undefined && !wordInside(destination, worktree)) {
    return outsideReason("git clone", destination);
  }
  return null;
};

const gitWorktreeCheck: CommandCheck = (args, worktree) => {
  for (const word of operands(args).slice(1)) {
    if (looksLikePath(word.text) && !wordInside(word, worktree)) {
      return outsideReason("git worktree", word);
    }
  }
  return null;
};

const GIT_OUTPUT_OPTIONS = new Set(["-o", "--output", "--output-directory"]);

/**
 * Git subcommands that stay inside the repository the CLI is already in.
 *
 * An allow-list rather than a list of the dangerous ones, for the same reason
 * the command table is: `git filter-branch`, `git send-email`,
 * `git maintenance` (which installs a cron job) and whatever ships next are
 * all questions by default.
 */
const GIT_SUBCOMMANDS = new Map<string, CommandCheck | null>([
  ["push", gitPushCheck],
  ["config", gitConfigCheck],
  ["clone", gitCloneCheck],
  ["worktree", gitWorktreeCheck],
  ["archive", outputOptionCommand("git archive", GIT_OUTPUT_OPTIONS)],
  ["format-patch", outputOptionCommand("git format-patch", GIT_OUTPUT_OPTIONS)],
  ["bundle", outputOptionCommand("git bundle", GIT_OUTPUT_OPTIONS)],
  ["add", null],
  ["am", null],
  ["apply", null],
  ["bisect", null],
  ["blame", null],
  ["branch", null],
  ["cat-file", null],
  ["check-attr", null],
  ["check-ignore", null],
  ["checkout", null],
  ["cherry", null],
  ["cherry-pick", null],
  ["clean", null],
  ["commit", null],
  ["count-objects", null],
  ["describe", null],
  ["diff", null],
  ["diff-tree", null],
  ["fetch", null],
  ["for-each-ref", null],
  ["fsck", null],
  ["gc", null],
  ["grep", null],
  ["hash-object", null],
  ["init", null],
  ["log", null],
  ["ls-files", null],
  ["ls-remote", null],
  ["ls-tree", null],
  ["merge", null],
  ["merge-base", null],
  ["mv", null],
  ["name-rev", null],
  ["notes", null],
  ["prune", null],
  ["pull", null],
  ["range-diff", null],
  ["rebase", null],
  ["reflog", null],
  ["remote", null],
  ["repack", null],
  ["reset", null],
  ["restore", null],
  ["rev-list", null],
  ["rev-parse", null],
  ["revert", null],
  ["rm", null],
  ["shortlog", null],
  ["show", null],
  ["show-ref", null],
  ["sparse-checkout", null],
  ["stash", null],
  ["status", null],
  ["switch", null],
  ["symbolic-ref", null],
  ["tag", null],
  ["update-index", null],
  ["update-ref", null],
  ["whatchanged", null],
]);

const GIT_VALUE_OPTIONS = new Set([
  "-c",
  "--config-env",
  "--namespace",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "-C",
]);

const gitCheck: CommandCheck = (args, worktree) => {
  let position = 0;
  while (position < args.length) {
    const word = args[position] as Word;
    if (!word.text.startsWith("-")) {
      break;
    }
    if (word.text === "-c" || word.text === "--config-env") {
      const value = args[position + 1];
      if (value === undefined) {
        return "runs git with a configuration override Paco cannot read";
      }
      const refusal = badGitConfig(value.text);
      if (refusal !== null) {
        return refusal;
      }
      position += 2;
      continue;
    }
    if (word.text === "--exec-path" || word.text.startsWith("--exec-path=")) {
      return "changes where git looks for the programs it runs";
    }
    const directory = optionValue(args, position, GIT_PATH_OPTIONS);
    if (directory !== null) {
      if (!wordInside(directory, worktree)) {
        return outsideReason("git", directory);
      }
      position += GIT_VALUE_OPTIONS.has(word.text) ? 2 : 1;
      continue;
    }
    position += GIT_VALUE_OPTIONS.has(word.text) ? 2 : 1;
  }

  const subcommand = args[position];
  if (subcommand === undefined) {
    return null;
  }
  if (!GIT_SUBCOMMANDS.has(subcommand.text)) {
    return `runs git ${subcommand.text}, which Paco does not recognise as staying inside this chat's workspace`;
  }
  const check = GIT_SUBCOMMANDS.get(subcommand.text) ?? null;
  return check === null ? null : check(args.slice(position + 1), worktree);
};

/* --- gh ------------------------------------------------------------------ */

const GH_API_WRITE_FLAGS = new Set([
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--input",
]);
const GH_API_METHOD_FLAGS = new Set(["-X", "--method"]);

const ghApiCheck: CommandCheck = (args) => {
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] as Word;
    if (GH_API_WRITE_FLAGS.has(word.text)) {
      return "calls the GitHub API with a request body, which changes something on GitHub";
    }
    const method = optionValue(args, position, GH_API_METHOD_FLAGS);
    if (method !== null && method.text.toUpperCase() !== "GET") {
      return `calls the GitHub API with ${method.text.toUpperCase()}, which changes something on GitHub`;
    }
  }
  return null;
};

/** `gh repo`/`gh release` are safe to read from and not to act with. */
function ghReadOnlySubcommands(
  name: string,
  allowed: Set<string>,
): CommandCheck {
  return (args) => {
    const [subcommand] = operands(args);
    if (subcommand === undefined || !allowed.has(subcommand.text)) {
      return (
        `runs gh ${name} ${subcommand?.text ?? ""}`.trimEnd() +
        ", which can change or delete something on GitHub"
      );
    }
    return null;
  };
}

/**
 * `gh` subcommands Paco expects an agent to use.
 *
 * Pull requests and issues are the product's own workflow, so they run
 * unattended. `gh auth`, `gh secret`, `gh alias` (whose values are shell
 * commands) and `gh extension` are not on the list and therefore ask.
 */
const GH_SUBCOMMANDS = new Map<string, CommandCheck | null>([
  ["pr", null],
  ["issue", null],
  ["run", null],
  ["workflow", null],
  ["browse", null],
  ["status", null],
  ["search", null],
  ["label", null],
  ["api", ghApiCheck],
  [
    "repo",
    ghReadOnlySubcommands(
      "repo",
      new Set(["view", "list", "clone", "set-default"]),
    ),
  ],
  [
    "release",
    ghReadOnlySubcommands("release", new Set(["view", "list", "download"])),
  ],
]);

const ghCheck: CommandCheck = (args, worktree) => {
  const [subcommand] = operands(args);
  if (subcommand === undefined) {
    return null;
  }
  if (!GH_SUBCOMMANDS.has(subcommand.text)) {
    return `runs gh ${subcommand.text}, which can change something on GitHub or on this machine`;
  }
  const check = GH_SUBCOMMANDS.get(subcommand.text) ?? null;
  const rest = args.slice(args.indexOf(subcommand) + 1);
  return check === null ? null : check(rest, worktree);
};

/* --- package managers ---------------------------------------------------- */

/** Subcommands that fetch new code from a registry and then run its scripts. */
const PACKAGE_MANAGER_ASK = new Set([
  "add",
  "create",
  "dlx",
  "init",
  "link",
  "unlink",
  "login",
  "logout",
  "adduser",
  "token",
  "publish",
  "unpublish",
  "deprecate",
  "owner",
  "access",
  "config",
  "set",
  "patch",
  "import",
  "setup",
  "store",
  "x",
  "npx",
]);

const PACKAGE_MANAGER_INSTALL = new Set(["install", "i", "in", "ins", "ci"]);

/** Package-manager flags that take a separate value, so it is not a subcommand. */
const PACKAGE_MANAGER_VALUE_FLAGS = new Set([
  "--dir",
  "-C",
  "--filter",
  "-F",
  "--prefix",
  "--workspace",
  "-w",
]);
const PACKAGE_MANAGER_DIR_FLAGS = new Set(["--dir", "-C", "--prefix"]);

function packageManagerCheck(name: string): CommandCheck {
  return (args, worktree) => {
    let position = 0;
    while (position < args.length) {
      const word = args[position] as Word;
      if (!word.text.startsWith("-")) {
        break;
      }
      const directory = optionValue(args, position, PACKAGE_MANAGER_DIR_FLAGS);
      if (directory !== null && !wordInside(directory, worktree)) {
        return outsideReason(name, directory);
      }
      position += PACKAGE_MANAGER_VALUE_FLAGS.has(word.text) ? 2 : 1;
    }

    const subcommand = args[position];
    if (subcommand === undefined) {
      return null;
    }
    const rest = operands(args.slice(position + 1));

    if (subcommand.text === "exec") {
      // pnpm and yarn run a binary that is already in the worktree's
      // node_modules; npm and bun will happily fetch one first.
      return name === "pnpm" || name === "yarn"
        ? null
        : `runs ${name} exec, which can download a package before running it`;
    }
    if (PACKAGE_MANAGER_ASK.has(subcommand.text)) {
      return `runs ${name} ${subcommand.text}, which fetches or publishes code outside this chat's workspace`;
    }
    if (PACKAGE_MANAGER_INSTALL.has(subcommand.text)) {
      if (rest.length > 0) {
        return `installs ${rest[0]?.text} from a registry, whose install scripts run immediately`;
      }
      // A bare install only materialises what the manifest already declares.
      return null;
    }
    if (name === "bun" && !BUN_SUBCOMMANDS.has(subcommand.text)) {
      // `bun some/script.ts` — an interpreter invocation in disguise.
      return wordInside(subcommand, worktree)
        ? null
        : outsideReason("bun", subcommand);
    }
    return null;
  };
}

const BUN_SUBCOMMANDS = new Set([
  "run",
  "test",
  "build",
  "install",
  "remove",
  "update",
  "outdated",
  "pm",
  "repl",
  "upgrade",
]);

/* --- interpreters and downloads ------------------------------------------ */

const NODE_EVAL_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "-",
]);

/**
 * `node` is allowed to run a file the worktree already contains, because that
 * is what building and testing an app looks like. It is not allowed to run code
 * handed to it on the command line or on stdin, which is how a download becomes
 * an execution.
 */
const nodeCheck: CommandCheck = (args, worktree) => {
  for (const word of args) {
    if (
      NODE_EVAL_FLAGS.has(word.text) ||
      word.text.startsWith("--eval=") ||
      word.text.startsWith("--require=") ||
      word.text.startsWith("--import=")
    ) {
      return "runs node on code given to it directly rather than on a file in this chat's workspace";
    }
  }
  const [script] = operands(args);
  if (script === undefined) {
    return "runs node with no script, so it would execute whatever it is given on standard input";
  }
  if (!wordInside(script, worktree)) {
    return outsideReason("node", script);
  }
  return null;
};

const CURL_OUTPUT_OPTIONS = new Set([
  "-o",
  "--output",
  "--output-dir",
  "-D",
  "--dump-header",
  "--trace",
  "--trace-ascii",
  "-c",
  "--cookie-jar",
]);
const CURL_CONFIG_OPTIONS = new Set(["-K", "--config"]);
const WGET_OUTPUT_OPTIONS = new Set([
  "-O",
  "--output-document",
  "-P",
  "--directory-prefix",
  "-o",
  "--output-file",
  "-a",
  "--append-output",
]);

function downloadCheck(name: string, options: Set<string>): CommandCheck {
  const outputs = outputOptionCommand(name, options);
  return (args, worktree) => {
    if (name === "curl") {
      for (const word of args) {
        if (CURL_CONFIG_OPTIONS.has(word.text)) {
          return "runs curl from a configuration file, which can set any option including where it writes";
        }
      }
    }
    return outputs(args, worktree);
  };
}

/* --- the rest ------------------------------------------------------------ */

const cdCheck: CommandCheck = (args, worktree) => {
  const [target] = operands(args);
  if (target === undefined) {
    return "changes directory to the user's home, outside this chat's workspace";
  }
  if (!wordInside(target, worktree)) {
    return outsideReason("cd", target);
  }
  return null;
};

const envCheck: CommandCheck = (args) => {
  for (const word of operands(args)) {
    if (!ASSIGNMENT.test(word.text)) {
      return "uses env to run another command, which Paco cannot see through";
    }
  }
  return null;
};

const teeCheck: CommandCheck = (args, worktree) => {
  for (const word of operands(args)) {
    if (WRITABLE_DEVICES.has(word.text)) {
      continue;
    }
    if (!wordInside(word, worktree)) {
      return outsideReason("tee", word);
    }
  }
  return null;
};

/**
 * Commands that read, print, or compute, and write nothing on their own.
 *
 * Their output still goes through the redirection check, so `cat x > ~/.zshrc`
 * is stopped by the redirection rather than by the command.
 */
const INERT_COMMANDS = [
  "base64",
  "basename",
  "cat",
  "cksum",
  "cmp",
  "column",
  "comm",
  "cut",
  "date",
  "df",
  "diff",
  "dirname",
  "du",
  "echo",
  "egrep",
  "export",
  "false",
  "fgrep",
  "file",
  "grep",
  "head",
  "hexdump",
  "hostname",
  "id",
  "jq",
  "join",
  "ls",
  "lsof",
  "md5sum",
  "nl",
  "paste",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "readlink",
  "realpath",
  "rev",
  "rg",
  "set",
  "sha1sum",
  "sha256sum",
  "shasum",
  "sleep",
  "seq",
  "sort",
  "stat",
  "tail",
  "tr",
  "tree",
  "true",
  "type",
  "uname",
  "uniq",
  "unset",
  "wc",
  "which",
  "whoami",
  "xxd",
  "yq",
];

/** Commands whose operands are paths they will write, move, or destroy. */
const PATH_COMMANDS = [
  "chmod",
  "chown",
  "cp",
  "gunzip",
  "gzip",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "rsync",
  "tar",
  "touch",
  "truncate",
  "unzip",
  "zip",
];

/**
 * Every command head this policy will run without asking.
 *
 * The absences are the point. `sh`, `bash`, `zsh`, `python`, `perl`, `ruby`,
 * `awk`, `sed`, `xargs`, `eval` and `source` are all missing, because each of
 * them takes a *program* as an argument — checking their arguments would mean
 * writing an interpreter for a second language, and half-checking one is how
 * this file got into trouble the first time. `sudo`, `docker`, `npx` and
 * `bunx` are missing for the same reason in a different shape: their whole
 * purpose is to run something this policy never sees. All of them ask.
 */
const SAFE_COMMANDS = new Map<string, CommandCheck | null>([
  ...INERT_COMMANDS.map(
    (name) => [name, null] as [string, CommandCheck | null],
  ),
  ...PATH_COMMANDS.map(
    (name) => [name, pathCommand(name)] as [string, CommandCheck | null],
  ),
  ["cd", cdCheck],
  ["env", envCheck],
  ["find", findCheck],
  ["gh", ghCheck],
  ["git", gitCheck],
  ["node", nodeCheck],
  ["tee", teeCheck],
  ["sort", outputOptionCommand("sort", new Set(["-o", "--output"]))],
  ["curl", downloadCheck("curl", CURL_OUTPUT_OPTIONS)],
  ["wget", downloadCheck("wget", WGET_OUTPUT_OPTIONS)],
  ["npm", packageManagerCheck("npm")],
  ["pnpm", packageManagerCheck("pnpm")],
  ["yarn", packageManagerCheck("yarn")],
  ["bun", packageManagerCheck("bun")],
]);

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

function checkSegment(segment: Segment, worktree: string): string | null {
  for (const redirection of segment.redirections) {
    if (redirection.direction !== "out") {
      continue;
    }
    const target = redirection.target;
    if (target === null) {
      return "redirects output somewhere Paco cannot read";
    }
    if (WRITABLE_DEVICES.has(target.text)) {
      continue;
    }
    if (!wordInside(target, worktree)) {
      return `redirects output to ${target.text}, which is outside this chat's workspace`;
    }
  }

  const { words } = segment;
  let position = 0;
  while (
    position < words.length &&
    ASSIGNMENT.test((words[position] as Word).text)
  ) {
    position += 1;
  }
  const head = words[position];
  if (head === undefined) {
    // A segment of nothing but assignments, or nothing but redirections.
    return null;
  }

  if (head.glob || head.tilde) {
    return `runs ${head.text}, which the shell would expand before Paco could tell what it is`;
  }

  // A program from the worktree itself — `./scripts/build.sh`,
  // `node_modules/.bin/tsc`. The agent may already write these files without
  // asking, so gating them would be theatre; see the residual note above.
  if (head.text.includes("/") && isInsideWorktree(head.text, worktree)) {
    return null;
  }

  const name = head.text.slice(head.text.lastIndexOf("/") + 1);
  if (!SAFE_COMMANDS.has(name)) {
    return `runs ${name}, which is not one of the commands Paco knows to stay inside this chat's workspace`;
  }
  const check = SAFE_COMMANDS.get(name) ?? null;
  return check === null ? null : check(words.slice(position + 1), worktree);
}

function decideShellCommand(
  command: string,
  worktree: string,
): ApprovalDecision {
  const parsed = parseCommandLine(command);
  if (!parsed.ok) {
    return { kind: "ask", reason: parsed.reason };
  }
  for (const segment of parsed.segments) {
    const reason = checkSegment(segment, worktree);
    if (reason !== null) {
      return { kind: "ask", reason };
    }
  }
  return { kind: "allow" };
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

  // Reading the output of a shell that was already approved starts nothing.
  if (call.name === "BashOutput" || call.name === "KillShell") {
    return { kind: "allow" };
  }

  if (call.name === "Bash") {
    const command = asString(call.input.command);
    if (!command.trim()) {
      // Same principle as an unreadable write path: a Bash call whose command
      // this policy cannot read has not been shown to be safe.
      return {
        kind: "ask",
        reason: "runs Bash without a command Paco can read",
      };
    }
    return decideShellCommand(command, worktree);
  }

  // An unrecognised tool is one this policy has never been reasoned about —
  // most likely from an MCP server the user configured. Ask rather than
  // assume, since the alternative is a silent allow-list bypass.
  return {
    kind: "ask",
    reason: `runs ${call.name}, which Paco does not recognise`,
  };
}
