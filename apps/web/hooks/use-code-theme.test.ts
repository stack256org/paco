import { describe, expect, test } from "bun:test";

import { codeThemeFor } from "./use-code-theme";

describe("codeThemeFor", () => {
  test("resolves an explicit preference to the matching theme", () => {
    expect(codeThemeFor("light")).toBe("app-light");
    expect(codeThemeFor("dark")).toBe("app-dark");
  });

  test("resolves 'system' to dark, not to the operating system", () => {
    // `paco-dark` is daisyUI's `default`, so with no `data-theme` attribute the
    // app renders dark whatever the machine prefers. Following the OS here is
    // what painted light-theme code onto Paco's near-black surface.
    expect(codeThemeFor("system")).toBe("app-dark");
  });
});
