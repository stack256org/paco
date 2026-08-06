"use client";

import { useMemo } from "react";
import { useThemePreference } from "@/hooks/use-theme-preference";
import type { CodeTheme } from "@/lib/diffs-config";
import type { ThemePreference } from "@/lib/theme";

/** The syntax theme a stored preference resolves to. */
export function codeThemeFor(preference: ThemePreference): CodeTheme {
  // "system" resolves to dark because `paco-dark` is the default daisyUI
  // theme — the app renders dark until someone explicitly asks for light.
  return preference === "light" ? "app-light" : "app-dark";
}

/**
 * The syntax theme the code and diff renderers should use.
 *
 * Returned as a `{ dark, light }` pair with *both slots set to the same
 * resolved theme*, which looks redundant and is not.
 *
 * `@pierre/diffs` decides between the two with
 * `matchMedia("(prefers-color-scheme: dark)")`, and it makes that decision in
 * more than one place — the React component, and again inside the highlighting
 * worker. The operating system is not what decides Paco's appearance: the dark
 * theme is daisyUI's `default`, so with no explicit preference Paco is dark on
 * a light-mode machine too. The renderer therefore chose the light syntax
 * theme and painted `#171717` text onto Paco's near-black surface — a page of
 * code that was there but unreadable.
 *
 * Handing back the same name twice means every one of those media queries
 * lands on the theme we actually want, with no way for one layer to disagree
 * with another.
 *
 * `initial` matters more than it looks. The stored preference is a cookie read
 * after mount, so without it this hook's first answer is always "system" — and
 * the highlighter is a page-lifetime singleton built from whatever theme it
 * saw first. Correcting the value a tick later came too late: under an
 * explicit light preference the code kept rendering in the dark theme's near
 * white, this time onto a white surface. Callers that can read the cookie on
 * the server pass the resolved preference in, so the first answer is right.
 */
export function useCodeTheme(
  initial: ThemePreference = "system",
): Record<"dark" | "light", CodeTheme> {
  const { preference } = useThemePreference(initial);

  return useMemo(() => {
    const resolved = codeThemeFor(preference);
    return { dark: resolved, light: resolved };
  }, [preference]);
}
