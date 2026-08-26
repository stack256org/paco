"use client";

import type { BackendCapabilities } from "@paco/agent-backend";
import { EyeOff } from "lucide-react";

/**
 * The composer's warning that this chat's model cannot look at the image the
 * user just attached.
 *
 * Attaching a screenshot to a Poolside chat looked exactly like attaching one
 * to a Claude Code chat, and only one of them worked. Poolside's models are
 * blind — verified live on both `poolside/laguna-s-2.1` and
 * `poolside/laguna-xs-2.1`: an inline image block comes back with
 * `stopReason: "end_turn"` and no error at all while the model answers
 * "IMAGE-NOT-VISIBLE", and the agent's own `Read` on a staged PNG fails with
 * "the configured model does not support image inputs". Silent on one path,
 * a buried tool error on the other; nothing reached the user either way.
 *
 * Driven by `capabilities.images`, never by `chatInfo.backend === "poolside"`
 * — the same rule that hides the effort control on `capabilities.effort ===
 * false`. A backend id check would be wrong the day a Poolside model gains
 * vision, and silent for the next blind backend.
 *
 * Deliberately a line in the composer rather than a dialog or a blocked
 * upload. The attachment is not useless: it is still staged to disk and its
 * path still named in the prompt, so "add this logo to the header" or "what
 * size is this" still work. Only looking at it does not, and the honest
 * thing is to say which — before the user spends a turn finding out.
 */
export function UnviewableImageNotice({
  capabilities,
  imageCount,
}: {
  capabilities: BackendCapabilities;
  /** How many images are staged in the composer right now. */
  imageCount: number;
}) {
  if (imageCount === 0 || capabilities.images) {
    return null;
  }

  const subject =
    imageCount === 1 ? "This image" : `These ${imageCount} images`;

  return (
    <div
      className="alert alert-warning alert-soft w-full gap-2 px-2 py-1.5"
      role="alert"
    >
      <EyeOff aria-hidden="true" className="size-3.5 shrink-0" />
      <p className="text-xs">
        This chat&apos;s model can&apos;t see images. {subject} will reach the
        agent as a file it can move, rename or check the size of — not as a
        picture it can look at. Describe what matters in your message, or switch
        this chat to a backend that can see images.
      </p>
    </div>
  );
}
