"use client";

import { useCallback, useEffect, useState } from "react";
import {
  applyThemePreference,
  readThemePreference,
  type ThemePreference,
} from "@/lib/theme";

type UseThemePreferenceReturn = {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
};

/**
 * The one place a React component reads or changes the theme.
 *
 * There used to be two: `Providers` kept its own preference in `localStorage`
 * and expressed it by toggling a `.dark` class, which daisyUI does not look
 * at — so the theme control in Settings, which used it, changed nothing on
 * screen. The toggle in the sidebar used a second implementation that
 * actually worked. Both now go through here.
 *
 * The preference is read after mount rather than during render: the server
 * has already applied the theme to `<html>`, so reading the cookie during
 * render would only risk a hydration mismatch for no visual gain.
 *
 * `initial` is the escape hatch for the callers where that first "system" is
 * not harmless. The syntax highlighter is built once per page from whatever
 * theme it sees first, so correcting the value after mount left it stuck on
 * the wrong one. A server component that has already read the cookie can pass
 * the answer in; everything else keeps the safe default.
 */
export function useThemePreference(
  initial: ThemePreference = "system",
): UseThemePreferenceReturn {
  const [preference, setPreferenceState] = useState<ThemePreference>(initial);

  useEffect(() => {
    setPreferenceState(readThemePreference());
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    applyThemePreference(next);
  }, []);

  return { preference, setPreference };
}
