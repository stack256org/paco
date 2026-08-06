"use client";

import { preloadHighlighter } from "@pierre/diffs";
import { useEffect, useState } from "react";
import type { CodeTheme } from "@/lib/diffs-config";

/**
 * The languages worth having loaded before the first file is rendered.
 *
 * Not every grammar shiki ships — that would be megabytes. These are what a
 * coding agent actually touches, plus the config and markup formats that show
 * up in a diff.
 */
const PRELOAD_LANGUAGES = [
  "tsx",
  "typescript",
  "javascript",
  "jsx",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "shellscript",
  "yaml",
  "sql",
  "go",
  "rust",
] as const;

/**
 * Waits for the syntax highlighter to have Paco's themes and the common
 * grammars loaded, and reports when it does.
 *
 * The renderers resolve grammars lazily: the first paint of a file happens
 * before its language is attached, so it comes out as plain text, and the
 * coloured version only arrives if the follow-up repaint lands. That repaint
 * was unreliable — code rendered uncoloured until an unrelated re-render
 * happened to occur, which is why this looked like a theme bug for so long.
 *
 * Loading the grammars up front removes the race rather than papering over
 * it: by the time a file mounts, the highlighter already has what it needs and
 * the first paint is the coloured one.
 */
export function useHighlighterReady(
  theme: Record<"dark" | "light", CodeTheme>,
) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void preloadHighlighter({
      themes: [theme.dark, theme.light],
      langs: [...PRELOAD_LANGUAGES],
    } as never)
      .catch(() => {
        // A grammar that fails to load must not hide the code. Rendering
        // uncoloured is a far better outcome than rendering nothing.
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [theme.dark, theme.light]);

  return ready;
}
