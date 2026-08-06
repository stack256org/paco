import { registerCustomTheme } from "@pierre/diffs";
import { appDark, appLight } from "./app-themes";

/**
 * Teach this realm's highlighter about Paco's two syntax themes.
 *
 * Must be called in *every* realm that highlights, which means the main thread
 * and the worker separately. The registry is module state, and a worker is a
 * different realm with its own copy of the module — so registering on the main
 * thread told the worker nothing.
 *
 * That was the reason code rendered as one flat colour: the worker could not
 * resolve "app-dark", tokenised without a theme, and the only colours left
 * were the container's own foreground and background.
 */
export function registerAppThemes(): void {
  registerCustomTheme("app-dark", () => Promise.resolve(appDark));
  registerCustomTheme("app-light", () => Promise.resolve(appLight));
}
