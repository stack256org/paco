import type { BaseCodeOptions } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs";

const unsafeCSS = `
  :host {
    display: block;
    max-width: 100%;
    /*
      daisyUI theme tokens, not the old --background/--foreground pair.

      Those two were removed when the app moved to semantic tokens, which left
      both of these declarations invalid: the renderer fell back to its own
      defaults and painted near-black text onto Paco's near-black surface, with
      no syntax colours at all. These variables inherit through the shadow
      boundary, so they follow whichever daisyUI theme is active.
    */
    --diffs-bg: var(--color-base-100);
    --diffs-fg: var(--color-base-content);

    /*
      The renderer writes the syntax theme's own editor background as an
      inline style on this element, and that hex was chosen for a palette Paco
      no longer uses — so the code sat on a visibly different black from the
      panel around it, like a hole in the page.

      An author !important is the only thing that outranks an inline style,
      and there is no prop to turn the theme's background off. The syntax
      colours still come from the theme; only the surface is the app's.
    */
    background-color: var(--color-base-100) !important;
    --diffs-font-family: var(--font-geist-mono, ui-monospace, monospace);
    --diffs-tab-size: 2;
    --diffs-gap-inline: 8px;
    --diffs-gap-block: 0px;
    --diffs-addition-color-override: #3dc96a;
    --diffs-deletion-color-override: #f04b78;
    --diffs-bg-addition-override: rgba(61, 201, 106, 0.12);
    --diffs-bg-deletion-override: rgba(240, 75, 120, 0.12);
  }
`;

/*
 * A single resolved theme name, not a { dark, light } pair.
 *
 * Given a pair, the renderer picks between them with
 * `matchMedia("(prefers-color-scheme: dark)")` — the *operating system*, which
 * is not what decides Paco's appearance. Paco defaults to its dark theme and
 * only sets `data-theme` for an explicit choice, so on a light-mode machine the
 * renderer chose the light syntax theme and painted dark text onto Paco's dark
 * surface: the file viewer showed a page of near-invisible code.
 *
 * Resolving it here, from the same preference the rest of the app reads, keeps
 * the two in step. `useCodeTheme` is the hook that supplies it.
 */
export type CodeTheme = "app-dark" | "app-light";

/* ------------------------------------------------------------------ */
/* Exported option presets                                              */
/* ------------------------------------------------------------------ */

export const defaultDiffOptions: Omit<FileDiffOptions<undefined>, "theme"> = {
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  disableFileHeader: true,
  unsafeCSS,
  hunkSeparators: "line-info",
};

export const splitDiffOptions: FileDiffOptions<undefined> = {
  ...defaultDiffOptions,
  diffStyle: "split",
};

export const defaultFileOptions = {
  overflow: "scroll",
  disableFileHeader: true,
  unsafeCSS,
} satisfies BaseCodeOptions;
