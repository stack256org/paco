"use client";

import { PreviewShareView } from "./preview-share-view";
import { usePreviewShare } from "./use-preview-share";

/**
 * Mounts the Preview tab's share control for one chat.
 *
 * Everything that can be tested without a server action or the clipboard
 * API lives in `PreviewShareView`; this just wires `usePreviewShare`'s state
 * and handlers into it.
 */
export function PreviewShareControl({ chatId }: { chatId: string }) {
  const { state, updating, copied, copy, setVisibility } =
    usePreviewShare(chatId);

  return (
    <PreviewShareView
      copied={copied}
      onCopy={copy}
      onVisibilityChange={(next) => {
        void setVisibility(next);
      }}
      state={state}
      updating={updating}
    />
  );
}
