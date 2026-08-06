import { hasUnsavedChanges } from "./paths";

/**
 * Edits in progress, one per file.
 *
 * A draft used to be a single `{ path, base, text }`, so opening a second file
 * threw the first one's typing away. Same shape, now held per path: switching
 * tabs changes which draft is on screen and nothing else.
 *
 * Every function returns the map unchanged when there is nothing to do, so a
 * no-op never becomes a re-render.
 */

/** An edit in progress, tied to the file it was started on. */
export type Draft = {
  path: string;
  /** What the file held when Edit was pressed — the baseline for "changed". */
  base: string;
  text: string;
};

/** Every edit in progress, keyed by the path it belongs to. */
export type DraftsByPath = Readonly<Record<string, Draft>>;

export const NO_DRAFTS: DraftsByPath = {};

/** The draft for one file, or `null` when that file is not being edited. */
export function draftAt(
  drafts: DraftsByPath,
  path: string | null,
): Draft | null {
  if (!path) return null;
  return drafts[path] ?? null;
}

/** Begin editing `path`, with `base` as the text it started from. */
export function startDraft(
  drafts: DraftsByPath,
  path: string,
  base: string,
): DraftsByPath {
  return { ...drafts, [path]: { path, base, text: base } };
}

/**
 * Record what the user has typed into `path`.
 *
 * A file with no draft is a file nobody pressed Edit on, so there is nothing to
 * type into and the keystroke is ignored rather than starting an edit by
 * surprise.
 */
export function setDraftText(
  drafts: DraftsByPath,
  path: string,
  text: string,
): DraftsByPath {
  const current = drafts[path];
  if (!current || current.text === text) return drafts;
  return { ...drafts, [path]: { ...current, text } };
}

/** Throw one file's draft away. */
export function discardDraft(drafts: DraftsByPath, path: string): DraftsByPath {
  if (!(path in drafts)) return drafts;

  const next: Record<string, Draft> = {};
  for (const [key, draft] of Object.entries(drafts)) {
    if (key !== path) next[key] = draft;
  }
  return next;
}

/**
 * Carry a draft with its file when the file is renamed.
 *
 * The text is the same text; only the name it will be saved under changed. Not
 * moving it would silently discard whatever was typed just before the rename.
 */
export function moveDraft(
  drafts: DraftsByPath,
  from: string,
  to: string,
): DraftsByPath {
  const current = drafts[from];
  if (!current || from === to) return drafts;
  return { ...discardDraft(drafts, from), [to]: { ...current, path: to } };
}

/**
 * Every file whose draft differs from what is on disk.
 *
 * This is what marks a tab and what the unsaved-changes guard asks about, so it
 * has to cover background tabs too, not just the one on screen.
 */
export function dirtyDraftPaths(drafts: DraftsByPath): readonly string[] {
  return Object.values(drafts)
    .filter((draft) => hasUnsavedChanges(draft.base, draft.text))
    .map((draft) => draft.path);
}
