"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPreviewShareState,
  type PreviewShareState,
  updatePreviewVisibility,
} from "@/lib/preview/actions";
import type { PreviewVisibility } from "@/lib/preview/visibility";
import { toast } from "@/lib/toast";

const COPY_FEEDBACK_MS = 1600;

export type PreviewShareStatus =
  | { status: "loading" }
  | { status: "error" }
  | ({ status: "ready" } & PreviewShareState);

/**
 * Data and handlers behind the Preview tab's share control.
 *
 * Split out of `preview-share-control.tsx` for the reason every other tab in
 * this pane splits its state out: fetching the share state, updating
 * visibility, and the copy-to-clipboard affordance are three independent
 * effects/handlers, and keeping them here leaves the component a function of
 * its props — the same shape as `PreviewRunControls` and `PreviewNotRunning`
 * next to it, and just as easy to test with static markup.
 */
export function usePreviewShare(chatId: string) {
  const [state, setState] = useState<PreviewShareStatus>({
    status: "loading",
  });
  const [updating, setUpdating] = useState(false);
  const [copied, setCopied] = useState(false);

  // Identifies which in-flight load is still worth acting on — the same
  // generation-counter pattern `DomainSection` uses, so a response that
  // lands after a newer load started (or after unmount) becomes a no-op
  // instead of overwriting fresher state.
  const requestIdRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const result = await getPreviewShareState(chatId);
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState({ status: "ready", ...result });
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState({ status: "error" });
    }
  }, [chatId]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    },
    [],
  );

  const setVisibility = useCallback(
    async (next: PreviewVisibility) => {
      setUpdating(true);
      try {
        const result = await updatePreviewVisibility(chatId, next);
        if (!result.success) {
          toast.error(result.error ?? "That didn't save. Try again.");
          return;
        }
        setState((prev) =>
          prev.status === "ready" ? { ...prev, visibility: next } : prev,
        );
      } catch {
        toast.error("That didn't save. Try again.");
      } finally {
        setUpdating(false);
      }
    },
    [chatId],
  );

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_MS,
      );
    });
  }, []);

  return { state, updating, copied, copy, setVisibility, reload: load };
}
