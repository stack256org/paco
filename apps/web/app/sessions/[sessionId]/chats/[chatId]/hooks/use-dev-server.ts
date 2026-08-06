"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DevServerLaunchResponse } from "@/app/api/sessions/[sessionId]/dev-server/route";
import { toast } from "@/lib/toast";
import type { DevServerCrashReport } from "./dev-server-liveness";
import { waitForDevServerReady } from "./dev-server-readiness";
import { requestDevServerStop } from "./dev-server-stop";
import { useDevServerLiveness } from "./use-dev-server-liveness";

type DevServerLaunchState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "stopping"; info: DevServerLaunchResponse }
  | { status: "error"; message: string; lastOutput?: string | null }
  | { status: "ready"; info: DevServerLaunchResponse };

export interface DevServerControls {
  state: DevServerLaunchState;
  menuLabel: string;
  menuDetail: string | null;
  showStopAction: boolean;
  handlePrimaryAction: () => Promise<void>;
  handleStopAction: () => Promise<void>;
}

type EnsureSandboxReady = () => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body) || typeof body.error !== "string") {
    return fallback;
  }

  return body.error;
}

function parseLaunchResponse(body: unknown): DevServerLaunchResponse | null {
  if (!isRecord(body)) {
    return null;
  }

  const { packagePath, port, url } = body;
  if (
    typeof packagePath !== "string" ||
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    typeof url !== "string"
  ) {
    return null;
  }

  return {
    packagePath,
    port,
    url,
  };
}

export function useDevServer({
  sessionId,
  chatId,
  canRun,
  ensureSandboxReady,
}: {
  sessionId: string;
  /** Scopes the request to this chat's worktree, where its work lives. */
  chatId: string;
  canRun: boolean;
  ensureSandboxReady?: EnsureSandboxReady;
}): DevServerControls {
  const [state, setState] = useState<DevServerLaunchState>({ status: "idle" });

  /**
   * Identifies the launch currently being waited on.
   *
   * Waiting for the app to answer can run for minutes, so the user can switch
   * chats, press Stop, or start again in the middle of one. Every wait carries
   * the id it started with and abandons itself if the id has moved on — without
   * it, a stale wait resolves later and drags the panel back to a state the
   * user already left.
   */
  const launchIdRef = useRef(0);

  useEffect(() => {
    launchIdRef.current += 1;
    setState({ status: "idle" });
  }, [sessionId, chatId]);

  useEffect(() => {
    if (!canRun) {
      launchIdRef.current += 1;
      setState({ status: "idle" });
    }
  }, [canRun]);

  /*
   * Adopt a dev server that is already running.
   *
   * State lived only in this hook, so it was forgotten on every reload and
   * never knew about a server the agent had started itself. The Preview tab
   * then said "No dev server running" while the app was serving, and pressing
   * Start would collide with the port. The status route answers from the
   * container, so whoever started it, the panel agrees with reality.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/dev-server?chatId=${encodeURIComponent(chatId)}`,
        );
        if (!response.ok || cancelled) {
          return;
        }

        const body = (await response.json()) as {
          running?: boolean;
        } & Partial<DevServerLaunchResponse>;

        if (cancelled || !body.running || !body.url) {
          return;
        }

        // Never clobber an action already in flight in this tab.
        setState((current) =>
          current.status === "idle"
            ? {
                status: "ready",
                info: {
                  packagePath: body.packagePath ?? "root",
                  port: body.port ?? 0,
                  url: body.url as string,
                },
              }
            : current,
        );
      } catch {
        // A status probe that fails just leaves the panel as it was.
      }
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately not gated on `canRun`. That flag says whether this client
    // may *start* a server; whether one is already serving is a fact about the
    // container, and the route refuses on an inactive sandbox anyway. Gating
    // the read meant a running app showed as "not running" whenever the
    // sandbox was merely idle.
  }, [sessionId, chatId]);

  /*
   * The app died after it had started.
   *
   * Leaving "ready" is the point: the panel stops handing out a URL, so the
   * iframe unmounts instead of showing the browser's own connection-refused
   * page, and the Preview tab shows the explanation with a way to start again.
   * It lands in `error` rather than `idle` because "it crashed" and "you never
   * started it" are not the same thing to read.
   *
   * The toast is for the case where the user is on Files or Changes. The
   * Preview tab could put this on screen forever and never be looked at.
   */
  const handleDevServerCrash = useCallback((report: DevServerCrashReport) => {
    setState({
      lastOutput: report.lastOutput,
      message: report.message,
      status: "error",
    });
    toast.error(report.headline, {
      description: "Open the Preview tab to start it again.",
    });
  }, []);

  useDevServerLiveness({
    sessionId,
    chatId,
    target: state.status === "ready" ? state.info : null,
    onCrash: handleDevServerCrash,
  });

  const openDevServerUrl = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const handlePrimaryAction = useCallback(async () => {
    if (state.status === "ready") {
      const sandboxReady = await ensureSandboxReady?.();
      if (sandboxReady === false) {
        setState({ status: "error", message: "Failed to start sandbox" });
        return;
      }

      openDevServerUrl(state.info.url);
      return;
    }

    if (state.status === "starting" || state.status === "stopping") {
      return;
    }

    const launchId = launchIdRef.current + 1;
    launchIdRef.current = launchId;
    setState({ status: "starting" });

    try {
      const sandboxReady = await ensureSandboxReady?.();
      if (sandboxReady === false) {
        throw new Error("Failed to start sandbox");
      }

      const response = await fetch(
        `/api/sessions/${sessionId}/dev-server?chatId=${encodeURIComponent(chatId)}`,
        {
          method: "POST",
        },
      );
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(getErrorMessage(body, "Failed to launch dev server"));
      }

      const launchResponse = parseLaunchResponse(body);
      if (!launchResponse) {
        throw new Error("Invalid dev server response");
      }

      // A 200 from the launch route means "the shell was spawned", not "the app
      // is up" — see dev-server-readiness.ts. Stay in `starting` until the port
      // actually answers, so the iframe is never pointed at a dead port and the
      // "this takes a moment the first time" line stays on screen for the whole
      // install rather than vanishing a second in.
      const ready = await waitForDevServerReady({
        sessionId,
        chatId,
        isCancelled: () => launchIdRef.current !== launchId,
      });

      if (launchIdRef.current !== launchId) {
        return;
      }

      if (!ready.ok) {
        setState({
          lastOutput: ready.ok ? null : (ready.lastOutput ?? null),
          message: ready.message,
          status: "error",
        });
        return;
      }

      setState({
        status: "ready",
        info: launchResponse,
      });
    } catch (error) {
      console.error("Failed to launch dev server:", error);
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to launch dev server",
      });
    }
  }, [chatId, ensureSandboxReady, openDevServerUrl, sessionId, state]);

  const handleStopAction = useCallback(async () => {
    if (state.status !== "ready") {
      return;
    }

    const stopping = { status: "stopping", info: state.info } as const;
    setState(stopping);

    try {
      // A 200 is not the same as a stop. The route answers `{stopped:false}`
      // when the process is still listening after SIGKILL; going idle on the
      // status code alone hid a running server from the panel and let the next
      // Start fight it for the port.
      const result = await requestDevServerStop({ sessionId, chatId });

      if (!result.ok) {
        // Stay on "ready", because the server really is still serving.
        //
        // This used to `throw` straight after, which its own catch below turned
        // into `status: "error"` — so the panel unmounted the preview of an app
        // that was still running and showed "Your app is not running" next to
        // the words "The dev server is still running", two contradictory
        // statements at once. The message belongs somewhere that does not cost
        // the user their preview.
        setState({ status: "ready", info: stopping.info });
        toast.error("That app is still running", {
          description: result.message,
        });
        return;
      }

      setState({ status: "idle" });
    } catch (error) {
      console.error("Failed to stop dev server:", error);
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to stop dev server",
      });
    }
  }, [chatId, sessionId, state]);

  const menuLabel =
    state.status === "ready"
      ? state.info.packagePath === "root"
        ? "Open Dev Server"
        : `Open ${state.info.packagePath}`
      : state.status === "starting"
        ? "Starting Dev Server..."
        : state.status === "stopping"
          ? "Stopping Dev Server..."
          : state.status === "error"
            ? "Retry Dev Server"
            : "Run Dev Server";
  const menuDetail =
    state.status === "ready" || state.status === "stopping"
      ? state.info.url
      : state.status === "error"
        ? state.message
        : null;
  const showStopAction =
    canRun && (state.status === "ready" || state.status === "stopping");

  return {
    state,
    menuLabel,
    menuDetail,
    showStopAction,
    handlePrimaryAction,
    handleStopAction,
  } as const;
}
