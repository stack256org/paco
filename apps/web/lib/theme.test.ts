import { describe, expect, test } from "bun:test";
import { parseThemePreference, THEMES, themeAttribute } from "./theme";

describe("parseThemePreference", () => {
  test("keeps an explicit preference", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  test("falls back to system for anything else", () => {
    // A missing cookie, a stale value from an older build, or a tampered one
    // must all land on the safe default rather than throwing.
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference(undefined)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("solarized")).toBe("system");
  });
});

describe("themeAttribute", () => {
  test("names a concrete theme for an explicit preference", () => {
    expect(themeAttribute("light")).toBe(THEMES.light);
    expect(themeAttribute("dark")).toBe(THEMES.dark);
  });

  test("returns null for system so daisyUI's prefersdark decides", () => {
    // Setting an attribute here would defeat the media query and freeze the
    // page on whichever theme happened to be chosen at render time.
    expect(themeAttribute("system")).toBeNull();
  });
});
