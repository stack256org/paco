import type { InstallSource } from "@/lib/plugins/install";

/**
 * Parses the source-string forms the install form accepts into the
 * `InstallSource` `installPlugin` expects:
 *
 * - `"owner/repo"` — a GitHub repo, default branch.
 * - `"owner/repo#ref"` — a GitHub repo pinned to a branch/tag/sha.
 * - `"github:owner/repo"` / `"github:owner/repo#ref"` — the same, in the
 *   prefixed form `installPlugin` writes back as `plugins.sourceLabel`.
 * - `"local:/abs/path"` — a directory already on this machine.
 *
 * This lives OUTSIDE `actions.ts` on purpose. That file is `"use server"`,
 * and Next requires every value export of a server-actions module to be
 * async — a synchronous export there fails `next build` outright (and only
 * `next build`: `pnpm run ci` does not run it, and `next dev` compiles
 * routes lazily, so nothing else catches it). A pure parser also has no
 * business being a POST-able action in the first place.
 *
 * Deliberately light on validation: the exact character-class rules for a
 * GitHub repo/ref live in `buildCloneArgs` (`lib/plugins/install.ts`) and are
 * re-checked there regardless of what this function lets through, so
 * duplicating them here would only be a second place for that rule to drift.
 * This function only rejects shapes `installPlugin` could never make sense
 * of at all (an empty repo, a local path that isn't absolute).
 *
 * The `github:` form matters for round-tripping, not just for typing by
 * hand: `installPlugin` stores `sourceLabel` as `github:owner/repo#ref`
 * (`lib/plugins/install.ts`), and the Plugins page's "Update" button feeds
 * that stored label straight back in. Without this branch the label fell
 * through to the bare-repo case as `repo = "github:owner/repo"`, failed
 * `GITHUB_REPO_PATTERN`, and Update was broken for every GitHub-installed
 * plugin while working fine for `local:` ones.
 */
export function parseInstallSource(
  source: string,
): { ok: true; source: InstallSource } | { ok: false; error: string } {
  if (source.startsWith("local:")) {
    const path = source.slice("local:".length);
    if (!path.startsWith("/")) {
      return {
        ok: false,
        error: `A local plugin source must be an absolute path, got "${path}"`,
      };
    }
    return { ok: true, source: { kind: "local", path } };
  }

  const withoutScheme = source.startsWith("github:")
    ? source.slice("github:".length)
    : source;

  const hashIndex = withoutScheme.indexOf("#");
  const repo =
    hashIndex === -1 ? withoutScheme : withoutScheme.slice(0, hashIndex);
  const ref = hashIndex === -1 ? undefined : withoutScheme.slice(hashIndex + 1);

  if (repo.length === 0) {
    return { ok: false, error: `No repo in source "${source}"` };
  }
  if (ref !== undefined && ref.length === 0) {
    return { ok: false, error: `Empty ref in source "${source}"` };
  }

  return { ok: true, source: { kind: "github", repo, ref } };
}
