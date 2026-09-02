"use server";

import { connectSandbox, type Sandbox } from "@paco/sandbox";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import {
  CHAT_NOT_FOUND,
  SESSION_NOT_FOUND,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { shellQuote } from "@/lib/shell/quote";
import {
  discoverNestedRepos,
  groupByOwner,
  isNestedRepoRootRow,
  ownerOf,
  prefixPatchPaths,
  prefixPath,
  repoCwd,
  rootsWithin,
} from "./nested-repos";
import {
  type ParsedStatus,
  parsePorcelainZ,
  pathsToTouch,
} from "./porcelain-status";
import {
  chatIdSchema,
  commitMessageSchema,
  type CommitResult,
  type FileDiff,
  type FileDiffOptions,
  fileDiffOptionsSchema,
  pathListSchema,
  repoRelativePathSchema,
  type SourceControlResult,
  type WorkingTreeStatus,
} from "./source-control-types";

/**
 * The Source Control panel's server half.
 *
 * Turns no longer commit; the operator does. That makes git's own index the
 * staging area — not a list Paco keeps beside it — which is the whole reason
 * these are thin wrappers over `git add`, `git restore` and `git commit`
 * rather than something cleverer. The index survives a reload, survives a
 * server restart, and is exactly what the operator's own `git status` shows if
 * they open a terminal in the worktree.
 *
 * A worktree may hold more than one repository: an operator running several
 * projects out of one session has cloned each *into* the workspace, and git
 * run at the worktree root cannot see inside them. So every operation here is
 * per-repository — status is gathered from each nested repository and merged
 * with its directory as a path prefix, and every action routes each path back
 * to the repository that owns it (`nested-repos.ts`). The panel itself never
 * learns any of this: it keys rows by path, and the prefixed path is just a
 * path.
 *
 * Every function takes a chat id and nothing else that identifies anything.
 * The session is derived from the chat rather than accepted alongside it, so
 * there is no pair of ids to disagree with each other, and the work always
 * happens in the chat's *worktree* (`resolveWorkCwd`) — the session repository
 * is a real repository sitting on the default branch, so getting that wrong
 * fails silently by reporting nothing rather than erroring.
 */

const GIT_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 60_000;
const DIFF_TIMEOUT_MS = 60_000;

const STATUS_FAILED =
  "We couldn't read what had changed. Reload the page and try again.";
const STAGE_FAILED =
  "We couldn't stage those files. Reload the page and try again.";
const UNSTAGE_FAILED =
  "We couldn't unstage those files. Reload the page and try again.";
const DISCARD_FAILED =
  "We couldn't discard those changes. Reload the page and try again.";
const COMMIT_FAILED =
  "We couldn't create the commit. Reload the page and try again.";
const NOTHING_STAGED =
  "Nothing is staged. Stage the changes you want to include, then commit.";

/** The parent repository's key in a per-repository map. */
const PARENT = "";

type Access = {
  sandbox: Sandbox;
  cwd: string;
  /** Nested repository roots under `cwd`, longest-first. Empty for the common case. */
  roots: string[];
};

/**
 * The chat exists, its session exists, and the sandbox is up.
 *
 * A chat has no owner column of its own, so its session is looked up via it
 * rather than trusted from an argument. Throws rather than returning a
 * result. Every caller below converts it into the `{ success: false, error
 * }` the panel renders, so the copy the operator reads is the copy in
 * `error-copy.ts` and nothing leaks past it.
 *
 * Nested repositories are discovered here, once per request, so every
 * operation in the request routes against the same picture of the workspace.
 */
async function requireSourceControlAccess(rawChatId: string): Promise<Access> {
  const chatId = chatIdSchema.parse(rawChatId);

  const chat = await getChatById(chatId);
  if (!chat) {
    throw new Error(CHAT_NOT_FOUND);
  }

  const session = await getSessionById(chat.sessionId);
  if (!session) {
    throw new Error(SESSION_NOT_FOUND);
  }

  if (!(session.sandboxState && isSandboxActive(session.sandboxState))) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }

  const sandbox = await connectSandbox(session.sandboxState);
  const cwd = resolveWorkCwd(session.sandboxState, chatId);
  const roots = await discoverNestedRepos(sandbox, cwd);
  return { sandbox, cwd, roots };
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function run(
  access: Access,
  command: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await access.sandbox.exec(command, access.cwd, timeoutMs);
  return {
    ok: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** `run`, but in one repository's directory — `root` "" is the parent. */
async function runIn(
  access: Access,
  root: string,
  command: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await access.sandbox.exec(
    command,
    repoCwd(access.cwd, root),
    timeoutMs,
  );
  return {
    ok: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function quoteAll(paths: string[]): string {
  return paths.map((path) => shellQuote(path)).join(" ");
}

/**
 * One repository's status, paths relative to that repository.
 *
 * For the parent, rows that *are* a nested repository — `?? project/` for an
 * untracked one, a gitlink entry for a tracked one — are dropped: the
 * repository's real changes are listed instead, and staging the untracked row
 * would record a gitlink, a pointer that silently replaces the project's
 * files in any clone of the parent.
 */
async function readRepoStatus(
  access: Access,
  root: string,
): Promise<ParsedStatus> {
  // `--untracked-files=all`: git's default collapses a new directory to a
  // single `a folder/` row, which is not something the operator can stage,
  // discard, or click to see a diff of. The panel lists files.
  const result = await runIn(
    access,
    root,
    "git status --porcelain=v1 -z --untracked-files=all",
  );
  if (!result.ok) {
    // A nested repository can disappear between discovery and this command
    // (the agent deleted it mid-request). For a nested repo that is an empty
    // answer; for the parent it is the failure it always was.
    if (root !== PARENT) {
      return { staged: [], unstaged: [], untracked: [] };
    }
    throw new Error(STATUS_FAILED);
  }
  const parsed = parsePorcelainZ(result.stdout);

  // Not only the parent: a repository cloned inside another repository gives
  // the *intermediate* repository its own opaque `inner/` row. Every
  // repository filters against the discovered roots inside it.
  const within = rootsWithin(root, access.roots);
  if (within.length === 0) {
    return parsed;
  }
  const notARepoRow = (change: { path: string }) =>
    !isNestedRepoRootRow(change.path, within);
  return {
    staged: parsed.staged.filter(notARepoRow),
    unstaged: parsed.unstaged.filter(notARepoRow),
    untracked: parsed.untracked.filter(notARepoRow),
  };
}

/**
 * Status of every repository in the worktree, keyed by root ("" = parent).
 *
 * Sequential, not `Promise.all`: some sandbox backends are not reliable with
 * concurrent command streams after a reconnect.
 */
async function readStatuses(
  access: Access,
): Promise<Map<string, ParsedStatus>> {
  const statuses = new Map<string, ParsedStatus>([
    [PARENT, await readRepoStatus(access, PARENT)],
  ]);
  for (const root of access.roots) {
    statuses.set(root, await readRepoStatus(access, root));
  }
  return statuses;
}

/** The per-repository statuses flattened into what the panel draws. */
function mergeStatuses(statuses: Map<string, ParsedStatus>): ParsedStatus {
  const merged: ParsedStatus = { staged: [], unstaged: [], untracked: [] };
  for (const [root, status] of statuses) {
    for (const list of ["staged", "unstaged", "untracked"] as const) {
      for (const change of status[list]) {
        merged[list].push({
          ...change,
          path: prefixPath(root, change.path),
          ...(change.oldPath
            ? { oldPath: prefixPath(root, change.oldPath) }
            : {}),
        });
      }
    }
  }
  // Each repository's porcelain arrives path-sorted; the merge interleaves
  // them back into one path order so the panel's lists read as one workspace.
  for (const list of ["staged", "unstaged", "untracked"] as const) {
    merged[list].sort((a, b) => a.path.localeCompare(b.path));
  }
  return merged;
}

/**
 * The ref this branch is measured against.
 *
 * Deliberately *not* `@{upstream}` or `origin/<this branch>`: those answer
 * "what have I not pushed", and the panel is asking "what have I written that
 * the base does not have". A chat branch is cut from the session's default
 * branch, so that is the comparison — the remote's idea of it when there is a
 * remote, the local branch when there is not, and nothing at all in a
 * repository that has neither.
 *
 * Parent repository only: nested repositories have no chat branch, so "ahead
 * of base" is not a question they can be asked.
 */
async function resolveBaseRef(access: Access): Promise<string | null> {
  // `2>/dev/null`: a repository with no remote answers this with `fatal:`,
  // which is a legitimate "there isn't one" rather than something to log.
  const remoteHead = await run(
    access,
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null",
  );
  if (remoteHead.ok && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim();
  }

  for (const candidate of ["main", "master"]) {
    const exists = await run(
      access,
      `git rev-parse --verify --quiet refs/heads/${candidate}`,
    );
    if (exists.ok && exists.stdout.trim()) {
      return candidate;
    }
  }

  return null;
}

async function countAheadOfBase(access: Access): Promise<number> {
  const base = await resolveBaseRef(access);
  if (!base) {
    return 0;
  }

  const ahead = await run(
    access,
    `git rev-list --count ${shellQuote(base)}..HEAD`,
  );
  if (!ahead.ok) {
    return 0;
  }

  const count = Number.parseInt(ahead.stdout.trim(), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

/**
 * Everything the panel draws, in one round trip.
 *
 * A file can appear in both `staged` and `unstaged` — staged content is a
 * snapshot of the file as it was when it was staged, and the agent (or the
 * operator) can change it again afterwards. Git models that as two separate
 * entries and so does this: the panel shows the row twice, once under each
 * heading, because they are two different diffs and committing captures only
 * the staged one.
 */
export async function getWorkingTreeStatus(
  chatId: string,
): Promise<WorkingTreeStatus> {
  const access = await requireSourceControlAccess(chatId);
  const parsed = mergeStatuses(await readStatuses(access));
  const aheadOfBase = await countAheadOfBase(access);

  return { ...parsed, aheadOfBase };
}

/**
 * Move paths into the index — each path into the index of the repository
 * that owns it.
 *
 * `git add -A --` rather than `git add --`: without `-A` a deleted file is not
 * staged as a deletion, so a row the operator ticked would quietly stay out of
 * the commit.
 */
export async function stageFiles(
  chatId: string,
  paths: string[],
): Promise<SourceControlResult> {
  try {
    const access = await requireSourceControlAccess(chatId);
    const wanted = pathListSchema.parse(paths);

    for (const [root, rels] of groupByOwner(wanted, access.roots)) {
      // The requested names only — never `pathsToTouch`. That expansion adds
      // a staged rename's *source*, which is right for restore and discard
      // (both halves have index or HEAD entries to act on) and fatal here:
      // the source exists neither on disk nor in the index, and `git add`
      // dies with `fatal: pathspec … did not match any files`. The rename is
      // already staged; adding the new name alone is the whole job.
      const result = await runIn(
        access,
        root,
        `git add -A -- ${quoteAll(rels)}`,
      );
      if (!result.ok) {
        console.error("[source-control] stage failed:", result.stderr.trim());
        return { success: false, error: STAGE_FAILED };
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: messageFor(error, STAGE_FAILED) };
  }
}

/**
 * Take paths back out of the index, leaving the working tree alone.
 *
 * On an unborn branch there is no HEAD to restore the index entry *from*, so
 * the entry is dropped instead. Same outcome — the path is no longer staged —
 * reached the only way git offers before the first commit exists. Asked per
 * repository: a freshly cloned project inside a workspace that has commits is
 * the common case, and the reverse — an unborn project inside it — happens
 * the moment the agent runs `git init` somewhere.
 */
export async function unstageFiles(
  chatId: string,
  paths: string[],
): Promise<SourceControlResult> {
  try {
    const access = await requireSourceControlAccess(chatId);
    const wanted = pathListSchema.parse(paths);

    for (const [root, rels] of groupByOwner(wanted, access.roots)) {
      const status = await readRepoStatus(access, root);
      const quoted = quoteAll(pathsToTouch(rels, status));

      const hasHead = await runIn(
        access,
        root,
        "git rev-parse --verify --quiet HEAD",
      );
      const command = hasHead.ok
        ? `git restore --staged -- ${quoted}`
        : `git rm --cached -r --quiet -- ${quoted}`;

      const result = await runIn(access, root, command);
      if (!result.ok) {
        console.error("[source-control] unstage failed:", result.stderr.trim());
        return { success: false, error: UNSTAGE_FAILED };
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: messageFor(error, UNSTAGE_FAILED) };
  }
}

/**
 * Throw away working-tree changes, and delete untracked files.
 *
 * Restores from the **index**, not from HEAD. That is what VS Code's "Discard
 * Changes" does, and here it matters more than it does there: staged content
 * is the operator's deliberate selection, and a discard that reset to HEAD
 * would silently destroy it as well as the unstaged edit they asked to drop.
 * To throw staged work away too, unstage it first and then discard — two
 * explicit acts for two destructive ones.
 *
 * An untracked file has no index entry to restore from, so it is deleted.
 * Nothing else can be meant by discarding it.
 */
export async function discardFiles(
  chatId: string,
  paths: string[],
): Promise<SourceControlResult> {
  try {
    const access = await requireSourceControlAccess(chatId);
    const wanted = pathListSchema.parse(paths);

    for (const [root, rels] of groupByOwner(wanted, access.roots)) {
      const status = await readRepoStatus(access, root);

      const untracked = new Set(status.untracked.map((change) => change.path));
      const tracked = rels.filter((path) => !untracked.has(path));
      const toDelete = rels.filter((path) => untracked.has(path));

      if (tracked.length > 0) {
        const restore = await runIn(
          access,
          root,
          `git restore --worktree -- ${quoteAll(pathsToTouch(tracked, status))}`,
        );
        if (!restore.ok) {
          console.error(
            "[source-control] discard failed:",
            restore.stderr.trim(),
          );
          return { success: false, error: DISCARD_FAILED };
        }
      }

      if (toDelete.length > 0) {
        const removed = await runIn(
          access,
          root,
          `rm -rf -- ${quoteAll(toDelete)}`,
        );
        if (!removed.ok) {
          console.error(
            "[source-control] remove failed:",
            removed.stderr.trim(),
          );
          return { success: false, error: DISCARD_FAILED };
        }
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: messageFor(error, DISCARD_FAILED) };
  }
}

/**
 * Commit what is staged, and only what is staged.
 *
 * No `-a`, no `add -A` first: the point of the staging area is that the
 * operator chose its contents, and a commit that swept in the rest would make
 * that choice meaningless.
 *
 * One commit **per repository that has something staged**, all with the same
 * message: each repository's index is its own staging area, and a workspace
 * holding three projects gets three commits when the operator staged work in
 * all three. The sha returned is the parent repository's when it committed —
 * that is the commit the chat's branch and pull request are built from —
 * otherwise the first nested repository's.
 *
 * Two refusals, both before git is asked. An empty message, because `git
 * commit` aborts on one anyway and its abort text is not something a
 * non-technical owner can act on. An empty index, because `git commit` with
 * nothing staged prints the entire status output and exits 1, which reads as a
 * crash rather than as "you have not chosen anything yet".
 *
 * Local only. Publishing is a separate, separately consented act — see the
 * pull-request path — for the same reason committing and pushing were already
 * two steps: a commit writes history the operator owns, a push writes to
 * someone's GitHub account.
 */
export async function commitStaged(
  chatId: string,
  message: string,
): Promise<CommitResult> {
  try {
    const access = await requireSourceControlAccess(chatId);

    const parsedMessage = commitMessageSchema.safeParse(message);
    if (!parsedMessage.success) {
      return {
        success: false,
        error:
          parsedMessage.error.issues[0]?.message ??
          "Write a commit message before committing.",
      };
    }

    const statuses = await readStatuses(access);
    const withStaged = [...statuses].filter(
      ([, status]) => status.staged.length > 0,
    );
    if (withStaged.length === 0) {
      return { success: false, error: NOTHING_STAGED };
    }

    let sha: string | undefined;
    for (const [root] of withStaged) {
      // `shellQuote`, not `JSON.stringify`: the command runs through `bash
      // -lc`, so double quotes would leave a backtick in the message live and
      // would flatten a multi-line body onto the subject line.
      const committed = await runIn(
        access,
        root,
        `git commit -m ${shellQuote(parsedMessage.data)}`,
        COMMIT_TIMEOUT_MS,
      );
      if (!committed.ok) {
        console.error(
          "[source-control] commit failed:",
          committed.stderr.trim(),
        );
        return { success: false, error: COMMIT_FAILED };
      }

      const head = await runIn(access, root, "git rev-parse HEAD");
      if (head.ok && head.stdout.trim() && (root === PARENT || !sha)) {
        sha = head.stdout.trim();
      }
    }

    return { success: true, ...(sha ? { sha } : {}) };
  } catch (error) {
    return { success: false, error: messageFor(error, COMMIT_FAILED) };
  }
}

function looksBinary(patch: string): boolean {
  return (
    patch.includes("GIT binary patch") ||
    /^Binary files .* differ$/m.test(patch)
  );
}

/**
 * `git diff --no-index /dev/null <path>` names the left side `a/dev/null`.
 *
 * Every patch renderer reads the file's identity off the `diff --git` line, so
 * left as-is an untracked file shows up in the panel called `dev/null`. The
 * `--- /dev/null` marker below it already says "this file is new", which is
 * the part that has to survive.
 */
function normalizeUntrackedPatch(patch: string, path: string): string {
  return patch.replace(
    /^diff --git a\/dev\/null b\/.*$/m,
    `diff --git a/${path} b/${path}`,
  );
}

/**
 * One file's diff, as a complete unified patch.
 *
 * The path routes to the repository that owns it, the commands run there with
 * the repository's own relative path, and the finished patch has its headers
 * rewritten to the prefixed path the panel knows the file by
 * (`prefixPatchPaths`).
 *
 * Three cases, because git needs three different questions asked:
 *
 * - **Staged** — index against HEAD. A rename is only detectable when git can
 *   see both halves, and a pathspec naming just the new path hides the old
 *   one, so the original path is looked up first and both are passed.
 * - **Tracked and unstaged** — working tree against the index, which is what
 *   the operator would still have to stage.
 * - **Untracked** — against `/dev/null`, so a new file is readable in the
 *   panel instead of being a row that does nothing when clicked.
 *
 * Binary content comes back as `binary: true` and an empty patch rather than
 * as a wall of bytes or an error: the panel can say "binary file" and still
 * offer to stage it.
 */
export async function getFileDiff(
  chatId: string,
  path: string,
  opts: FileDiffOptions,
): Promise<FileDiff> {
  const access = await requireSourceControlAccess(chatId);
  const requested = repoRelativePathSchema.parse(path);
  const { staged } = fileDiffOptionsSchema.parse(opts);

  const { root, rel: target } = ownerOf(requested, access.roots);
  const status = await readRepoStatus(access, root);
  const quoted = shellQuote(target);

  if (staged) {
    const entry = status.staged.find((change) => change.path === target);
    const oldPath = entry?.oldPath;
    const pathspec = oldPath ? `${shellQuote(oldPath)} ${quoted}` : quoted;
    const result = await runIn(
      access,
      root,
      `git diff --cached -M --find-copies -- ${pathspec}`,
      DIFF_TIMEOUT_MS,
    );
    const patch = result.stdout;
    return {
      patch: looksBinary(patch) ? "" : prefixPatchPaths(patch, root),
      binary: looksBinary(patch),
      ...(oldPath ? { oldPath: prefixPath(root, oldPath) } : {}),
    };
  }

  const isUntracked = status.untracked.some((change) => change.path === target);
  if (isUntracked) {
    // `--no-index` exits 1 when the files differ, which is the whole point of
    // running it, so its exit code says nothing useful here.
    const result = await runIn(
      access,
      root,
      `git diff --no-index -- /dev/null ${quoted}`,
      DIFF_TIMEOUT_MS,
    );
    const patch = result.stdout;
    return {
      // Normalize first, with the repository-relative name — that is what the
      // `a/dev/null` anchor matches against — then prefix the whole patch.
      patch: looksBinary(patch)
        ? ""
        : prefixPatchPaths(normalizeUntrackedPatch(patch, target), root),
      binary: looksBinary(patch),
    };
  }

  const result = await runIn(
    access,
    root,
    `git diff -M -- ${quoted}`,
    DIFF_TIMEOUT_MS,
  );
  const patch = result.stdout;
  return {
    patch: looksBinary(patch) ? "" : prefixPatchPaths(patch, root),
    binary: looksBinary(patch),
  };
}
