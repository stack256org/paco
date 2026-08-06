"use client";

import { Check, Copy, Globe, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { RefObject } from "react";
import { useRef } from "react";
import type { PreviewVisibility } from "@/lib/preview/visibility";
import { cn } from "@/lib/utils";
import type { PreviewShareStatus } from "./use-preview-share";

const SETTINGS_HREF = "/settings/admin";

/**
 * The sentence that stops someone sharing a preview of an app wired to their
 * production database. Read literally by whoever is about to click "Make it
 * public" — not softened into a tooltip, because a tooltip is easy to skip
 * and this is the one warning in the phase that has to land.
 */
export const PUBLIC_WARNING =
  "Anyone with this link will be able to open it — no sign-in required. It serves the code the agent has just written, and that code may be wired to real credentials or real data. Only make it public if you're certain nothing here should be reachable by a stranger.";

function schemeFor(tlsEnabled: boolean): string {
  return tlsEnabled ? "https://" : "http://";
}

/**
 * Confirmation for the one transition in this control that needs one.
 *
 * Going private never needs a dialog — nothing gets easier to reach. Going
 * public does, every time, because the alternative is a checkbox a person
 * can flip without reading anything next to it.
 */
function MakePublicDialog({
  dialogRef,
  onConfirm,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  onConfirm: () => void;
}) {
  return (
    <dialog className="modal" ref={dialogRef}>
      <div className="modal-box">
        <h3 className="flex items-center gap-2 font-bold text-base">
          <TriangleAlert
            aria-hidden="true"
            className="size-4 shrink-0 text-warning"
          />
          Make this preview public?
        </h3>
        <div
          className="alert alert-warning alert-soft alert-vertical mt-4 items-start text-left"
          role="alert"
        >
          <p className="text-sm">{PUBLIC_WARNING}</p>
        </div>
        <div className="modal-action">
          <form method="dialog">
            <button className="btn btn-sm" type="submit">
              Cancel
            </button>
          </form>
          <button
            className="btn btn-sm btn-warning"
            onClick={onConfirm}
            type="button"
          >
            Make it public
          </button>
        </div>
      </div>
      <form className="modal-backdrop" method="dialog">
        <button type="submit">close</button>
      </form>
    </dialog>
  );
}

/**
 * The Preview tab's share control, as a pure function of its state.
 *
 * Split from `PreviewShareControl` (which owns the fetch and the update
 * calls via `usePreviewShare`) so this half can be tested the same way
 * `PreviewRunControls` and `PreviewNotRunning` are: render it with a state
 * value and assert on the markup, no server action or clipboard API in the
 * way.
 *
 * Three states share this space. `"loading"` and `"error"` render a single
 * quiet line rather than a stale URL — a load failure must never show a URL
 * or a visibility badge, because both could be wrong by the time they're
 * read. `"ready"` with `hostname: null` means no preview domain is
 * configured, so this explains that and points at Settings instead of
 * rendering a link that would 404. Every other `"ready"` case shows the
 * real URL, a copy action, and the private/public switch guarded by
 * `MakePublicDialog` above.
 */
export function PreviewShareView({
  state,
  updating,
  copied,
  onCopy,
  onVisibilityChange,
}: {
  state: PreviewShareStatus;
  updating: boolean;
  copied: boolean;
  onCopy: (text: string) => void;
  onVisibilityChange: (next: PreviewVisibility) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 border-base-300 border-b px-3 py-2 text-base-content/60 text-xs">
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        Loading preview link…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex items-center gap-2 border-base-300 border-b px-3 py-2 text-base-content/60 text-xs">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        We couldn&apos;t load this chat&apos;s preview link.
      </div>
    );
  }

  const { hostname, tlsEnabled, visibility } = state;

  if (!hostname) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-base-300 border-b px-3 py-2 text-xs">
        <Globe
          aria-hidden="true"
          className="size-3.5 shrink-0 text-base-content/40"
        />
        <span className="text-base-content/60">
          No preview domain is configured, so this chat has no link to share
          yet.
        </span>
        <Link className="btn btn-ghost btn-xs" href={SETTINGS_HREF}>
          Configure in Settings
        </Link>
      </div>
    );
  }

  const previewUrl = `${schemeFor(tlsEnabled)}${hostname}`;
  const isPublic = visibility === "public";

  return (
    <div className="border-base-300 border-b px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Globe
            aria-hidden="true"
            className="size-3.5 shrink-0 text-base-content/40"
          />
          <span
            className="min-w-0 truncate font-mono text-xs"
            title={previewUrl}
          >
            {previewUrl}
          </span>
          <button
            aria-label={copied ? "Copied" : "Copy preview link"}
            className="btn btn-ghost btn-xs btn-square shrink-0"
            onClick={() => onCopy(previewUrl)}
            type="button"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-3.5 text-success" />
            ) : (
              <Copy aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div aria-label="Preview visibility" className="join" role="group">
            <button
              aria-pressed={!isPublic}
              className={cn("btn btn-xs join-item", !isPublic && "btn-active")}
              disabled={updating}
              onClick={() => {
                if (isPublic) {
                  onVisibilityChange("private");
                }
              }}
              type="button"
            >
              Private
            </button>
            <button
              aria-pressed={isPublic}
              className={cn(
                "btn btn-xs join-item",
                isPublic && "btn-active btn-warning",
              )}
              disabled={updating}
              onClick={() => {
                if (!isPublic) {
                  dialogRef.current?.showModal();
                }
              }}
              type="button"
            >
              Public
            </button>
          </div>

          <span className="text-base-content/60 text-xs">
            {isPublic
              ? "Anyone with the link can open this — no sign-in."
              : "Private (the default) — only you can open this link."}
          </span>
        </div>
      </div>

      <p className="mt-1 text-base-content/50 text-xs">
        This link serves whatever is running on port 3000 in this chat&apos;s
        session — a sibling chat&apos;s dev server can answer it instead. That
        port, and 5173/4321/8000 in this sandbox, are also reachable directly on
        this host, unauthenticated, regardless of this setting.
      </p>

      <MakePublicDialog
        dialogRef={dialogRef}
        onConfirm={() => {
          dialogRef.current?.close();
          onVisibilityChange("public");
        }}
      />
    </div>
  );
}
