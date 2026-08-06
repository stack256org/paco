"use client";

import { type Dispatch, type SetStateAction, useEffect } from "react";
import type { Session } from "@/lib/db/schema";

/**
 * Let a workspace restored somewhere else unlock the page you are looking at.
 *
 * `sessionRecord` is seeded from a server prop with `useState`, so it never
 * re-reads that prop again — which is right for everything the page itself
 * edits (a title, a model) and wrong for exactly one case: you are looking at
 * an archived workspace and restore it from the switcher's archived list. The
 * server row changes, `router.refresh()` delivers the new prop, and the page
 * would keep showing "This workspace is archived" over a workspace that is not.
 *
 * Deliberately one-way and one-field. It copies `status` only, only when the
 * local copy says archived and the server disagrees, so it can never overwrite
 * an optimistic local edit — and never archives a page out from under someone.
 */
export function useServerUnarchiveSync({
  serverStatus,
  localStatus,
  setSessionRecord,
}: {
  serverStatus: Session["status"];
  localStatus: Session["status"];
  setSessionRecord: Dispatch<SetStateAction<Session>>;
}): void {
  useEffect(() => {
    if (localStatus !== "archived" || serverStatus === "archived") {
      return;
    }

    setSessionRecord((current) =>
      current.status === "archived"
        ? { ...current, status: serverStatus, lifecycleState: null }
        : current,
    );
  }, [localStatus, serverStatus, setSessionRecord]);
}
