"use client";

import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The way into `/sessions/[sessionId]/evals`.
 *
 * The Evals surface shipped complete — discovery, runner, terminal statuses —
 * and unreachable: nothing anywhere in `app/` or `components/` linked to it,
 * so the only way in was typing the URL. `reachability.test.ts` next to this
 * file is the regression test for that.
 *
 * It belongs on the session tab strip because evals are session-scoped, not
 * organisation-scoped: they discover `evals/*.json` from *this* session's
 * repo and run against *this* session's worktree. Settings would have been
 * the wrong home for the same reason Schedules is the right one for its own
 * page — that surface is org-wide, this one is not.
 *
 * A sibling of the tab strip rather than a tab in it. The strip's contents
 * are chats, one per branch, that the strip itself creates, renames, closes
 * and scrolls; evals is a route, owns none of that behaviour, and would have
 * had to opt out of all of it to sit inside. Keeping it outside the
 * scrolling container also means it stays visible with a dozen chats open,
 * which is precisely when a rarely-used surface is easiest to lose again.
 *
 * Renders nothing when there is no `sessionId` in the route — the component
 * is mounted from a session-scoped layout, so that should not happen, but a
 * link to `/sessions/undefined/evals` is a worse answer than no link.
 */
export function EvalsTabLink() {
  const params = useParams<{ sessionId?: string }>();
  const pathname = usePathname();
  const sessionId = params.sessionId;

  if (!sessionId) {
    return null;
  }

  const href = `/sessions/${sessionId}/evals`;
  const isActive = pathname === href;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          className={cn(
            "mr-1 flex shrink-0 items-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition-colors",
            isActive
              ? "bg-base-200 text-base-content"
              : "text-base-content/60 hover:bg-base-200 hover:text-base-content",
          )}
          href={href}
        >
          <FlaskConical aria-hidden="true" className="h-3.5 w-3.5" />
          <span>Evals</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Run this repo&apos;s eval scenarios against the current roster
      </TooltipContent>
    </Tooltip>
  );
}
