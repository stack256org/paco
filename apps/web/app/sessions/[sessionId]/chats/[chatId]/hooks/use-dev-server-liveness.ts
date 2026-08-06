"use client";

import { useEffect, useRef } from "react";
import {
  type DevServerCrashReport,
  watchDevServerLiveness,
} from "./dev-server-liveness";

/**
 * Watch a running app for as long as the panel claims it is running.
 *
 * Everything that decides anything lives in dev-server-liveness.ts, where it is
 * tested against a fake clock. What is left here is the browser: real timers, a
 * real `document`, and a teardown that has to leave nothing behind.
 *
 * The watch runs only while `target` is set — which the caller does only in the
 * "ready" state — so idle, starting, stopping and crashed all stop it. There is
 * no timer alive for a preview that is not running, and none for a chat the
 * user has left.
 */
export function useDevServerLiveness(params: {
  sessionId: string;
  chatId: string;
  /** The running app to watch, or null when there is nothing to watch. */
  target: { packagePath: string } | null;
  onCrash: (report: DevServerCrashReport) => void;
}): void {
  const { sessionId, chatId, onCrash } = params;
  const packagePath = params.target?.packagePath ?? null;

  /*
   * The callback through a ref, so a caller that rebuilds it every render does
   * not restart the watch — which would reset the miss counter each time and
   * mean the threshold was never reached.
   */
  const onCrashRef = useRef(onCrash);
  useEffect(() => {
    onCrashRef.current = onCrash;
  }, [onCrash]);

  useEffect(() => {
    if (packagePath === null) {
      return;
    }

    let cancelled = false;
    /** Ends the current wait early: on teardown, or on coming back to the tab. */
    let wake: (() => void) | null = null;

    /*
     * An interruptible wait.
     *
     * A plain `setTimeout` would hold the loop for up to a full interval after
     * unmount, and would make a user returning to a backgrounded tab wait out a
     * sleep that started while they were away. This resolves early for both.
     */
    const sleep = (ms: number) => {
      let endWait = () => {
        // Replaced synchronously below, before anything can call it.
      };
      const waited = new Promise<void>((resolve) => {
        endWait = resolve;
      });

      const finish = () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", handleVisible);
        wake = null;
        endWait();
      };
      const handleVisible = () => {
        if (document.visibilityState === "visible") {
          finish();
        }
      };

      const timer = setTimeout(finish, ms);
      document.addEventListener("visibilitychange", handleVisible);
      wake = finish;

      return waited;
    };

    void watchDevServerLiveness({
      sessionId,
      chatId,
      packagePath,
      sleep,
      isCancelled: () => cancelled,
      isVisible: () => document.visibilityState !== "hidden",
    }).then((report) => {
      if (report && !cancelled) {
        onCrashRef.current(report);
      }
    });

    return () => {
      cancelled = true;
      wake?.();
    };
  }, [chatId, packagePath, sessionId]);
}
