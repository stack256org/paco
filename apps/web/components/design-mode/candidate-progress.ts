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
 * The newest assistant message that carries `data-design-progress` parts —
 * however many ordinary turns have happened since.
 *
 * This deliberately scans past later messages, and that is the fix for a
 * real bug rather than a loosening. The panel is the only place in the
 * product that renders a Discard control, and it used to be derived from the
 * newest assistant message full stop: one ordinary chat turn after a design
 * turn hid it permanently, while the candidates it was the handle for — two
 * or three worktrees and branches — stayed on disk with nothing left that
 * could reach them short of deleting the whole chat.
 *
 * Still only ONE design turn, though — the newest. Two design turns in a
 * chat must not merge into a single panel: the second turn's candidates
 * replaced the first turn's on disk, and an annotation taken on one means
 * nothing on the other.
 */
function latestDesignMessage(
  messages: WebAgentUIMessage[],
): WebAgentUIMessage | null {
  return (
    messages.findLast(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "data-design-progress"),
    ) ?? null
  );
}

/** That message's progress parts, in the order they streamed. */
function latestDesignProgress(
  messages: WebAgentUIMessage[],
): WebAgentDesignProgressData[] {
  const designMessage = latestDesignMessage(messages);
  if (!designMessage) {
    return [];
  }

  return designMessage.parts
    .filter((part) => part.type === "data-design-progress")
    .map((part) => part.data);
}

/**
 * The id of the assistant message the newest design turn streamed into, or
 * `null` when this chat has never run one.
 *
 * The panel is scoped to that id rather than to "a design turn is happening":
 * dismissing the panel has to stick for the turn it was dismissed on and
 * still let the next design turn open a fresh one, and the annotations taken
 * on one turn's candidates mean nothing on the next turn's.
 */
export function designTurnMessageId(
  messages: WebAgentUIMessage[],
): string | null {
  return latestDesignMessage(messages)?.id ?? null;
}

/**
 * Whether this chat has a design turn whose candidates the panel should be
 * offering a way out of — adopt one, refine one, or throw them all away.
 *
 * Not "is the newest message a design turn": see `latestDesignMessage`.
 */
export function isDesignTurn(messages: WebAgentUIMessage[]): boolean {
  return designTurnMessageId(messages) !== null;
}

/**
 * One view per candidate the newest design turn produced, index order.
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
