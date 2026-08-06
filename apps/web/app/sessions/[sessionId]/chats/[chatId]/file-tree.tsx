"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FileSuggestion } from "@/app/api/sessions/[sessionId]/files/route";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";

type FileTreeProps = {
  files: FileSuggestion[];
  repoName?: string | null;
  onFileClick: (filePath: string) => void;
};

export function FileTree({ files, repoName, onFileClick }: FileTreeProps) {
  const onFileClickRef = useRef(onFileClick);
  onFileClickRef.current = onFileClick;

  const repoNameRef = useRef(repoName);
  repoNameRef.current = repoName;

  const paths = useMemo(() => {
    const prefix = repoName ? `${repoName}/` : "";
    return files.map((f) => {
      const normalized = f.isDirectory ? f.value.replace(/\/?$/, "/") : f.value;
      return `${prefix}${normalized}`;
    });
  }, [files, repoName]);

  const handleSelectionChange = useCallback(
    (selectedPaths: readonly string[]) => {
      if (selectedPaths.length === 0) return;
      const path = selectedPaths[selectedPaths.length - 1];
      // only fire for files, not directories
      if (!path.endsWith("/")) {
        const prefix = repoNameRef.current ? `${repoNameRef.current}/` : "";
        const stripped =
          prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        onFileClickRef.current(stripped);
      }
    },
    [],
  );

  const { model } = useFileTree({
    paths,
    density: "compact",
    // expand root folder (level 1) so repo name is open by default
    initialExpansion: 1,
    flattenEmptyDirectories: true,
    onSelectionChange: handleSelectionChange,
  });

  // keep paths in sync when files change
  const prevPathsRef = useRef(paths);
  useEffect(() => {
    if (prevPathsRef.current !== paths) {
      prevPathsRef.current = paths;
      model.resetPaths(paths);
    }
  }, [paths, model]);

  if (files.length === 0) {
    return (
      <div className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-base-content/25 py-8 text-center">
        <p className="text-xs text-base-content/60">No files found</p>
      </div>
    );
  }

  return (
    <PierreFileTree
      model={model}
      style={
        {
          /*
            daisyUI theme tokens, using the names the tree actually publishes.
            The background was previously set through
            `--trees-bg-base-200-override`, which is not one of them — so it did
            nothing, the tree kept its own light default, and on the dark theme
            the panel rendered as a white block with near-white filenames on it.

            Every value below is a real `*-override` variable from the package.
          */
          "--trees-bg-override": "var(--color-base-100)",
          "--trees-fg-override": "var(--color-base-content)",
          "--trees-fg-muted-override":
            "color-mix(in oklch, var(--color-base-content) 60%, transparent)",
          "--trees-bg-muted-override": "var(--color-base-200)",
          "--trees-border-color-override": "var(--color-base-300)",
          "--trees-indent-guide-bg-override": "var(--color-base-300)",
          "--trees-selected-bg-override": "var(--color-base-300)",
          "--trees-selected-fg-override": "var(--color-base-content)",
          "--trees-accent-override": "var(--color-primary)",
          "--trees-focus-ring-color-override": "var(--color-primary)",
          "--trees-selected-focused-border-color-override":
            "var(--color-primary)",
          "--trees-scrollbar-thumb-override":
            "color-mix(in oklch, var(--color-base-content) 20%, transparent)",
          "--trees-padding-inline-override": "6px",
          paddingTop: "8px",
          height: "100%",
        } as React.CSSProperties
      }
    />
  );
}
