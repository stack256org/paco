// Extend Shiki's BundledTheme to include custom app themes.
// This allows passing "app-light" and "app-dark" anywhere
// the library expects a BundledTheme string.
declare module "shiki" {
  export type BundledTheme =
    | import("shiki/dist/themes.mjs").BundledTheme
    | "app-light"
    | "app-dark";
}

// Widen @streamdown/code's createCodePlugin to also accept ThemeRegistration
// objects. At runtime Shiki's createHighlighter already handles this; the
// published types are just too narrow.
declare module "@streamdown/code" {
  import type { ThemeRegistration } from "@shikijs/types";
  import type { BundledTheme } from "shiki";
  import type { CodeHighlighterPlugin } from "@streamdown/code";

  interface CodePluginOptions {
    themes?: [
      BundledTheme | ThemeRegistration,
      BundledTheme | ThemeRegistration,
    ];
  }

  export function createCodePlugin(
    options?: CodePluginOptions,
  ): CodeHighlighterPlugin;
}
