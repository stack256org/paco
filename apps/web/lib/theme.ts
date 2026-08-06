/**
 * Theme selection.
 *
 * daisyUI reads the active theme from `data-theme` on the document element.
 * The preference is kept in a cookie rather than `localStorage` so the server
 * can read it while rendering and put the right `data-theme` on `<html>` in
 * the first byte of HTML. That removes the blocking inline script this used to
 * need — and with it the React 19 "Encountered a script tag while rendering
 * React component" console error, which no amount of `next/script` wrapping
 * silenced, because the warning is about rendering a script element from a
 * component at all.
 *
 * "system" deliberately sets no attribute. daisyUI's `prefersdark` then picks
 * the theme from the OS in pure CSS, which cannot flash and needs no
 * `matchMedia` listener. An explicit light or dark preference sets the
 * attribute, and an attribute always beats the media query — so the two never
 * compete, which was the original reason for resolving "system" in JS.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_COOKIE_NAME = "paco-theme";

export const THEMES = {
  light: "paco-light",
  dark: "paco-dark",
} as const;

/** A year. The preference is a convenience, not a credential. */
const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function parseThemePreference(
  value: string | null | undefined,
): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * The `data-theme` value for a preference, or `null` when CSS should decide.
 *
 * Returning `null` for "system" is what lets `prefersdark` do the work.
 */
export function themeAttribute(preference: ThemePreference): string | null {
  if (preference === "light") {
    return THEMES.light;
  }
  if (preference === "dark") {
    return THEMES.dark;
  }
  return null;
}

/** The stored preference, read on the client. */
export function readThemePreference(): ThemePreference {
  if (typeof document === "undefined") {
    return "system";
  }

  const match = new RegExp(`(?:^|;\\s*)${THEME_COOKIE_NAME}=([^;]*)`).exec(
    document.cookie,
  );

  return parseThemePreference(match ? decodeURIComponent(match[1]) : null);
}

/** Persist a preference and apply it to the live document. */
export function applyThemePreference(preference: ThemePreference): void {
  const attribute = themeAttribute(preference);

  if (attribute === null) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = attribute;
  }

  // The lint rule prefers the Cookie Store API, which Safari and Firefox do
  // not implement — the theme would simply stop persisting there. A cookie
  // library would be a dependency for one assignment.
  // eslint-disable-next-line unicorn/no-document-cookie -- see above
  document.cookie = `${THEME_COOKIE_NAME}=${preference}; path=/; max-age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
