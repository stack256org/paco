/**
 * Pick a package manager that is actually installed in the workspace image.
 *
 * The manager is chosen from the project's lockfile, which is the right signal
 * — but the choice was never checked against the container. The image ships
 * npm, pnpm and yarn and does *not* ship bun, so a project with `bun.lockb`
 * produced `bun install`, which died as "command not found" inside a detached
 * shell whose output goes to /dev/null. The launch route had already answered
 * 200 by then, so the panel showed "running" over a port nothing was ever going
 * to listen on, with no error anywhere. Silent, permanent, and indistinguishable
 * from a slow install.
 *
 * Falling back beats refusing. A `package.json` is a `package.json`: npm can
 * install a project whose lockfile happens to be bun's, and the user gets a
 * working preview. Refusing would be technically purer and would leave someone
 * who has never used a terminal staring at "Bun is not installed", which they
 * cannot act on.
 */

export type PackageManagerName = "bun" | "pnpm" | "yarn" | "npm";

/**
 * Who stands in for whom, best first.
 *
 * pnpm before npm for bun and yarn projects because it is the closest in
 * behaviour and is the manager the image is built around. npm is last in every
 * list and is the reason a list can never be exhausted: it ships with Node, so
 * it is present in any image that can run a dev server at all.
 */
const FALLBACK_ORDER: Record<PackageManagerName, PackageManagerName[]> = {
  bun: ["bun", "pnpm", "npm"],
  pnpm: ["pnpm", "npm"],
  yarn: ["yarn", "pnpm", "npm"],
  npm: ["npm", "pnpm"],
};

/**
 * The first manager in `preferred`'s fallback list that is installed.
 *
 * Returns `null` when none of them are, which should be impossible — it means
 * the image has no Node package manager at all — and is reported rather than
 * guessed at, because launching `npm` that does not exist is exactly the silent
 * failure this module exists to remove.
 */
export function selectAvailablePackageManager(
  preferred: PackageManagerName,
  isAvailable: (manager: PackageManagerName) => boolean,
): PackageManagerName | null {
  for (const candidate of FALLBACK_ORDER[preferred]) {
    if (isAvailable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** The candidates worth probing for, so the container is asked once. */
export function fallbackCandidates(
  preferred: PackageManagerName,
): PackageManagerName[] {
  return [...FALLBACK_ORDER[preferred]];
}

export const NO_PACKAGE_MANAGER_MESSAGE =
  "Your workspace doesn't have anything installed that can set up this project's building blocks. Rebuild the workspace image, then try again.";
