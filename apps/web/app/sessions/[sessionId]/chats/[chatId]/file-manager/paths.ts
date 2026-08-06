/**
 * Workspace path arithmetic for the file manager.
 *
 * Kept free of React and of `node:path` on purpose: the browser bundle should
 * not pull in a polyfill, and every workspace path is POSIX and relative to the
 * chat's worktree root, so the rules are simple enough to state directly.
 *
 * The API answers with plain English because these messages go straight onto
 * the screen for someone who does not know what a path separator is.
 */

/** Directory entries arrive from the listing endpoint with a trailing slash. */
function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end);
}

/**
 * The folder a path sits in, or `""` for something at the top level.
 */
export function parentDirectory(path: string): string {
  const trimmed = stripSlashes(path);
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? "" : trimmed.slice(0, index);
}

/** The last segment of a path — what a person would call "the file's name". */
export function fileName(path: string): string {
  const trimmed = stripSlashes(path);
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * Join a folder and a name into a workspace-relative path.
 *
 * Either side may be empty (the root folder, or a folder with no name yet), and
 * either may carry stray slashes from a trailing-slash directory entry or from
 * something the user typed.
 */
export function joinPath(directory: string, name: string): string {
  const dir = stripSlashes(directory);
  const rest = stripSlashes(name);
  if (!dir) return rest;
  if (!rest) return dir;
  return `${dir}/${rest}`;
}

/** The path an entry would have after being given `newName` in place. */
export function renamedPath(path: string, newName: string): string {
  return joinPath(parentDirectory(path), newName);
}

/**
 * Whether the text in the editor still matches what was last read from disk.
 *
 * `null` means nothing has been loaded or nothing is being edited, which is
 * never a reason to warn someone about losing work.
 */
export function hasUnsavedChanges(
  savedContent: string | null,
  draft: string | null,
): boolean {
  if (savedContent === null || draft === null) return false;
  return savedContent !== draft;
}

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; message: string };

/**
 * `.git` is refused by the API by design, so catching it here turns a rejected
 * request into an explanation the user can act on before they submit.
 */
const RESERVED_SEGMENTS = new Set([".git"]);

const MAX_NAME_LENGTH = 255;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Validate a name typed into the New file / New folder / Rename dialog.
 *
 * Slashes are allowed — typing `notes/todo.md` to create a file in a new
 * subfolder is a reasonable thing to want, and the API creates missing parents
 * anyway. Everything else that would fail server-side is explained here
 * instead, so the user finds out while the dialog is still open.
 */
export function checkEntryName(rawName: string): NameCheck {
  const name = stripSlashes(rawName.trim());

  if (!name) {
    return { ok: false, message: "Type a name first." };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: "That name is too long. Try a shorter one." };
  }
  if (hasControlCharacter(name) || name.includes("\\")) {
    return {
      ok: false,
      message:
        "That name has characters we can't use. Letters, numbers, dashes, underscores and dots work best.",
    };
  }

  const segments = name.split("/");
  if (segments.includes("")) {
    return { ok: false, message: "Names can't have two slashes in a row." };
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return {
      ok: false,
      message: 'Names can\'t contain a part that is just "." or "..".',
    };
  }
  if (
    segments.some((segment) => RESERVED_SEGMENTS.has(segment.toLowerCase()))
  ) {
    return {
      ok: false,
      message:
        "That name is reserved for this project's history, so it can't be used.",
    };
  }
  if (segments.some((segment) => segment.endsWith(" "))) {
    return {
      ok: false,
      message: "Names can't end with a space. Remove it and try again.",
    };
  }

  return { ok: true, name };
}

/**
 * The SWR key for one file's contents.
 *
 * Shared verbatim with the read-only file view so both read one cache entry:
 * opening a file must not fetch it twice, and saving must not leave the two
 * views disagreeing about what is on disk.
 */
export function fileContentKey(
  sessionId: string,
  chatId: string,
  path: string | null,
): string | null {
  if (!path) return null;
  const params = new URLSearchParams({ path, chatId });
  return `/api/sessions/${sessionId}/files/content?${params.toString()}`;
}
