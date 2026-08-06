import { isReasoningUIPart, isToolUIPart } from "ai";
import type { WebAgentUIMessage, WebAgentUIMessagePart } from "@/app/types";
import { isGitDataPart } from "@/lib/chat-streaming-state";

/**
 * Turn a message's flat part list into what the transcript actually renders.
 *
 * Two things happen here. Consecutive reasoning parts collapse into one group,
 * because the model emits thinking in many small pieces and rendering each as
 * its own block produces a stuttering wall of boxes. And every group gets a
 * render key that is stable across streaming updates: parts arrive
 * incrementally and their array index shifts, so keying by index remounts
 * components mid-stream and loses their local state — a collapsed tool call
 * springs back open on the next token.
 */

type ReasoningMessagePart = Extract<
  WebAgentUIMessagePart,
  { type: "reasoning" }
>;

export type MessageRenderGroup =
  | {
      type: "part";
      part: WebAgentUIMessagePart;
      index: number;
      renderKey: string;
    }
  | {
      type: "reasoning-group";
      parts: ReasoningMessagePart[];
      startIndex: number;
      renderKey: string;
    };

export interface GroupedRenderMessage {
  message: WebAgentUIMessage;
  groups: MessageRenderGroup[];
  isStreaming: boolean;
}

/**
 * What a part *is*, independent of where it sits in the array.
 *
 * A tool call's id is genuinely unique; everything else is identified by kind
 * and disambiguated by an occurrence counter, which is enough to stay stable
 * as later parts stream in.
 */
function getPartIdentity(part: WebAgentUIMessagePart): string {
  if (isToolUIPart(part)) {
    return part.toolCallId ? `tool:${part.toolCallId}` : `tool:${part.type}`;
  }

  if (isReasoningUIPart(part)) {
    return "reasoning";
  }

  if (part.type === "text") {
    return "text";
  }

  if (part.type === "file") {
    if (part.url) return `file:${part.url}`;
    if (part.filename) return `file:${part.filename}`;
    return "file";
  }

  if (isGitDataPart(part)) {
    return part.id ? `data:${part.type}:${part.id}` : `data:${part.type}`;
  }

  return `part:${part.type}`;
}

/** The text of a collapsed reasoning group, blank pieces dropped. */
export function getReasoningGroupText(parts: ReasoningMessagePart[]): string {
  return parts
    .map((part) => part.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function groupMessagesForRender(
  messages: WebAgentUIMessage[],
  isChatInFlight: boolean,
): GroupedRenderMessage[] {
  return messages.map((message, messageIndex) => {
    const groups: MessageRenderGroup[] = [];
    let currentReasoningGroup: ReasoningMessagePart[] = [];
    let reasoningGroupStartIndex = 0;
    const partIdentityCounts = new Map<string, number>();

    const getStablePartRenderKey = (part: WebAgentUIMessagePart): string => {
      const identity = getPartIdentity(part);

      if (isToolUIPart(part) && part.toolCallId) {
        return identity;
      }

      const count = partIdentityCounts.get(identity) ?? 0;
      partIdentityCounts.set(identity, count + 1);
      return `${identity}:${count}`;
    };

    const flushReasoningGroup = () => {
      if (currentReasoningGroup.length === 0) return;

      groups.push({
        type: "reasoning-group",
        parts: currentReasoningGroup,
        startIndex: reasoningGroupStartIndex,
        renderKey: `reasoning-group:${getStablePartRenderKey(currentReasoningGroup[0])}`,
      });
      currentReasoningGroup = [];
    };

    message.parts.forEach((part, index) => {
      if (isReasoningUIPart(part)) {
        if (currentReasoningGroup.length === 0) {
          reasoningGroupStartIndex = index;
        }
        currentReasoningGroup.push(part);
        return;
      }

      flushReasoningGroup();
      groups.push({
        type: "part",
        part,
        index,
        renderKey: getStablePartRenderKey(part),
      });
    });

    flushReasoningGroup();

    return {
      message,
      groups,
      isStreaming: isChatInFlight && messageIndex === messages.length - 1,
    };
  });
}
