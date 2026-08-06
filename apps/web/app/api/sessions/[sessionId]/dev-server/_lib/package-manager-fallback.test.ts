import { describe, expect, test } from "bun:test";
import {
  fallbackCandidates,
  NO_PACKAGE_MANAGER_MESSAGE,
  type PackageManagerName,
  selectAvailablePackageManager,
} from "./package-manager-fallback";

/**
 * What the shipped image actually contains, verified by running
 * `command -v` for each manager inside `paco-sandbox:latest`:
 * npm, pnpm and yarn are present; bun is not.
 */
const SHIPPED_IMAGE: ReadonlySet<PackageManagerName> = new Set([
  "npm",
  "pnpm",
  "yarn",
]);

const availableIn =
  (present: ReadonlySet<PackageManagerName>) => (manager: PackageManagerName) =>
    present.has(manager);

describe("selectAvailablePackageManager", () => {
  test("keeps the project's own manager when the image has it", () => {
    for (const manager of ["npm", "pnpm", "yarn"] as const) {
      expect(
        selectAvailablePackageManager(manager, availableIn(SHIPPED_IMAGE)),
      ).toBe(manager);
    }
  });

  test("a bun project falls back instead of dying silently", () => {
    // The regression: `bun install` in an image without bun exits
    // "command not found" into /dev/null, and the panel reports "running".
    expect(
      selectAvailablePackageManager("bun", availableIn(SHIPPED_IMAGE)),
    ).toBe("pnpm");
  });

  test("uses bun when an image does provide it", () => {
    const withBun = new Set<PackageManagerName>([...SHIPPED_IMAGE, "bun"]);
    expect(selectAvailablePackageManager("bun", availableIn(withBun))).toBe(
      "bun",
    );
  });

  test("falls all the way to npm when only npm is present", () => {
    const npmOnly = new Set<PackageManagerName>(["npm"]);
    for (const manager of ["bun", "pnpm", "yarn", "npm"] as const) {
      expect(selectAvailablePackageManager(manager, availableIn(npmOnly))).toBe(
        "npm",
      );
    }
  });

  test("reports rather than guesses when nothing is installed", () => {
    const nothing = new Set<PackageManagerName>();
    expect(selectAvailablePackageManager("npm", availableIn(nothing))).toBe(
      null,
    );
  });

  test("every manager can fall back to something", () => {
    for (const manager of ["bun", "pnpm", "yarn", "npm"] as const) {
      const candidates = fallbackCandidates(manager);
      expect(candidates[0]).toBe(manager);
      expect(candidates).toContain("npm");
    }
  });
});

describe("NO_PACKAGE_MANAGER_MESSAGE", () => {
  test("says what to do and names no command the reader must type", () => {
    expect(NO_PACKAGE_MANAGER_MESSAGE.length).toBeGreaterThan(0);
    expect(NO_PACKAGE_MANAGER_MESSAGE).not.toMatch(/npm|pnpm|yarn|bun/);
  });
});
