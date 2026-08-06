/**
 * The set of files open in the editor pane, as plain data.
 *
 * Kept free of React so the awkward parts can be stated once and tested
 * directly: opening a file that is already open must not open it twice, and
 * closing the tab you are looking at has to leave you somewhere sensible
 * rather than on an empty pane with six other files still open.
 *
 * Order is the order the files were opened in, and nothing reorders it. A tab
 * that moves while you are reaching for it is a tab you close by accident.
 */

/**
 * Add `path` at the end, or return the list unchanged when it is already open.
 *
 * The same array comes back on purpose: the hook that owns this list feeds it
 * from an effect, and a fresh array every time would be a new state value every
 * time, which is a render loop.
 */
export function openTab(
  paths: readonly string[],
  path: string,
): readonly string[] {
  if (paths.includes(path)) return paths;
  return [...paths, path];
}

/** Remove `path`, or return the list unchanged when it was not open. */
export function closeTab(
  paths: readonly string[],
  path: string,
): readonly string[] {
  if (!paths.includes(path)) return paths;
  return paths.filter((open) => open !== path);
}

/**
 * The tab to look at once `path` is closed.
 *
 * The one to its right, because that is where the eye already is; failing that
 * the one to its left; and `null` when that was the last one, which puts the
 * pane back to "No file open".
 */
export function neighbourTab(
  paths: readonly string[],
  path: string,
): string | null {
  const index = paths.indexOf(path);
  if (index === -1) return null;
  return paths[index + 1] ?? paths[index - 1] ?? null;
}

/**
 * Follow a renamed file to its new path, keeping its place in the strip.
 *
 * Closing the old tab and opening a new one would send the file to the far end
 * of the strip, which is a strange thing to happen for a change of name.
 */
export function renameTab(
  paths: readonly string[],
  from: string,
  to: string,
): readonly string[] {
  if (!paths.includes(from)) return paths;
  // Renaming onto a path that is already open would otherwise leave two tabs
  // for one file; the destination's tab is the one that survives.
  if (paths.includes(to)) return paths.filter((open) => open !== from);
  return paths.map((open) => (open === from ? to : open));
}
