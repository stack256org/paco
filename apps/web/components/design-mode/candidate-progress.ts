import type {
  WebAgentDesignProgressData,
  WebAgentUIMessage,
} from "@/app/types";
import type { DesignCandidatePreview } from "@/lib/design/candidate-preview-url";

/** Everything one frame in the design panel renders from. */
export interface DesignCandidateView {
  index: number;
  status: WebAgentDesignProgressData["status"];
  error?: string;
  /**
   * Where this candidate's dev server is reachable, or `null` when no
   * preview base domain is configured — there is then nothing to embed.
   */
  previewUrl: string | null;
}

/**
 * The `data-design-progress` parts of the newest assistant message.
 *
 * Only the newest: an older design turn's parts are still in the transcript
 * (they are persisted with the message), and treating those as live would
 * reopen the panel on candidates that were merged or discarded turns ago.
 */
function latestDesignProgress(
  messages: WebAgentUIMessage[],
): WebAgentDesignProgressData[] {
  const lastAssistant = messages.findLast(
    (message) => message.role === "assistant",
  );
  if (!lastAssistant) {
    return [];
  }

  return lastAssistant.parts
    .filter((part) => part.type === "data-design-progress")
    .map((part) => part.data);
}

/**
 * The id of the assistant message the current design turn is streaming into,
 * or `null` when the turn on screen is not a design turn.
 *
 * The panel is scoped to that id rather than to "a design turn is happening":
 * dismissing the panel has to stick for the turn it was dismissed on and
 * still let the next design turn open a fresh one, and the annotations taken
 * on one turn's candidates mean nothing on the next turn's.
 */
export function designTurnMessageId(
  messages: WebAgentUIMessage[],
): string | null {
  const lastAssistant = messages.findLast(
    (message) => message.role === "assistant",
  );
  if (!lastAssistant) {
    return null;
  }
  const hasProgress = lastAssistant.parts.some(
    (part) => part.type === "data-design-progress",
  );
  return hasProgress ? lastAssistant.id : null;
}

/** Whether the turn the user is looking at is a design turn. */
export function isDesignTurn(messages: WebAgentUIMessage[]): boolean {
  return designTurnMessageId(messages) !== null;
}

/**
 * One view per candidate the current design turn is streaming, index order.
 *
 * The workflow emits one part per candidate per status change, all under the
 * same `design-candidate-<index>` id, so the same candidate appears several
 * times in a message's parts. The last part for an index is the current
 * state — parts are appended in the order they streamed.
 */
export function designCandidateViews(
  messages: WebAgentUIMessage[],
  previews: DesignCandidatePreview[],
): DesignCandidateView[] {
  const latest = new Map<number, WebAgentDesignProgressData>();
  for (const progress of latestDesignProgress(messages)) {
    latest.set(progress.candidate, progress);
  }

  return [...latest.values()]
    .sort((a, b) => a.candidate - b.candidate)
    .map((progress) => ({
      index: progress.candidate,
      status: progress.status,
      ...(progress.error ? { error: progress.error } : {}),
      previewUrl:
        previews.find((preview) => preview.index === progress.candidate)?.url ??
        null,
    }));
}
