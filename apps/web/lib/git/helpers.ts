export const SAFE_BRANCH_PATTERN = /^[\w\-/.]+$/;

export function isSafeBranchName(branch: string): boolean {
  return (
    SAFE_BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

/**
 * A fresh, unclaimed branch name. Used to be prefixed with initials derived
 * from whoever was signed in; there is no signed-in identity left to derive
 * that from, so every generated branch shares the same `nb/` prefix now.
 */
export function generateBranchName(): string {
  const randomSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `nb/${randomSuffix}`;
}

/**
 * Detects if a string looks like a git commit hash (detached HEAD state).
 * Git short hashes are 7+ hex chars, full hashes are 40.
 */
export function looksLikeCommitHash(str: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(str);
}
