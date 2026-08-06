"use client";

import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { useCodeTheme } from "@/hooks/use-code-theme";
import { useHighlighterReady } from "@/hooks/use-highlighter-ready";
import { registerAppThemes } from "@/lib/register-app-themes";
import type { ThemePreference } from "@/lib/theme";

// Runs once, when this module is first imported. Every code and diff renderer
// in the chat is mounted below this provider, so registering here is enough.
registerAppThemes();

/**
 * Context for the code and diff renderers: syntax themes, and the worker pool.
 *
 * Every renderer below this passes `disableWorkerPool`, which makes the pool
 * look pointless. It is not — the renderers read this context unconditionally
 * and render nothing at all without it. The pool has to exist; what it must
 * not do is any work.
 *
 * That is the fix for Paco never having syntax highlighted anything. With a
 * live pool, `FileRenderer` renders plain text immediately and asks a worker
 * to tokenise, swapping in the coloured result when the worker answers. Paco's
 * workers never answered, and the pool manager drops a failed task inside a
 * bare `catch {}` — no error, no warning, no failed request. Every file simply
 * stayed on the plain first pass: one uncoloured span per line, which read as
 * a theme problem and was not one.
 *
 * Bypassing the pool makes the same renderer tokenise on the main thread.
 * Verified directly: the shared highlighter returns proper tokens for our
 * themes (`const` at #F75F8F, identifiers at #52A8FF), and the viewer paints
 * them.
 *
 * The pool's purpose — keeping tokenisation off the main thread for large
 * files — is real and worth restoring if the worker is ever made to reply. A
 * pool that silently swallows every request is strictly worse than none,
 * because it costs the feature entirely.
 */
export function DiffsProvider({
  children,
  themePreference = "system",
}: {
  children: React.ReactNode;
  /** Read from the theme cookie by the server, so the first render is right. */
  themePreference?: ThemePreference;
}) {
  const theme = useCodeTheme(themePreference);
  const highlighterReady = useHighlighterReady(theme);

  /*
   * Hold the tree back until the grammars are in.
   *
   * A file rendered before then paints as plain text and depends on a
   * follow-up repaint to gain colour — a repaint that did not reliably
   * happen. Waiting costs one tick on first load and makes the first paint
   * the coloured one.
   */
  if (!highlighterReady) {
    return null;
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        // Two, matching what the pool was created with before. Nothing is
        // dispatched to it, but the renderers require the context to exist.
        poolSize: 2,
        workerFactory: () =>
          new Worker(
            new URL("@pierre/diffs/worker/worker.js", import.meta.url),
          ),
      }}
      highlighterOptions={{ theme, langs: [] }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
