import { isReasoningUIPart, isToolUIPart } from "ai";
import type {
  WebAgentCommitDataPart,
  WebAgentPrDataPart,
  WebAgentUIMessagePart,
} from "@/app/types";

export type ChatUiStatus = "submitted" | "streaming" | "ready" | "error";

export function isChatInFlight(status: ChatUiStatus): boolean {
  return status === "submitted" || status === "streaming";
}

export function isGitDataPart(
  part: WebAgentUIMessagePart,
): part is WebAgentCommitDataPart | WebAgentPrDataPart {
  return part.type === "data-commit" || part.type === "data-pr";
}

export function shouldRenderGitDataPart(
  part: WebAgentCommitDataPart | WebAgentPrDataPart,
): boolean {
  if (part.type === "data-commit" && part.data.status === "skipped") {
    return false;
  }

  return true;
}

export function hasRenderableAssistantPart(
  part: WebAgentUIMessagePart,
): boolean {
  if (part.type === "text") {
    return part.text.length > 0;
  }

  if (isToolUIPart(part)) {
    return true;
  }

  if (isReasoningUIPart(part)) {
    return part.text.length > 0 || part.state === "streaming";
  }

  if (isGitDataPart(part)) {
    return shouldRenderGitDataPart(part);
  }

  return false;
}

export function shouldShowThinkingIndicator(options: {
  status: ChatUiStatus;
  hasAssistantRenderableContent: boolean;
  lastMessageRole: "assistant" | "user" | "system" | undefined;
}): boolean {
  const { status, hasAssistantRenderableContent, lastMessageRole } = options;
  if (!isChatInFlight(status)) {
    return false;
  }

  if (lastMessageRole !== "assistant") {
    return true;
  }

  return !hasAssistantRenderableContent;
}

export function shouldUseChatListStreamingState(options: {
  status: ChatUiStatus;
  hasChatListStreaming: boolean;
  userStopped: boolean;
  hasAssistantRenderableContent: boolean;
  lastMessageRole: "assistant" | "user" | "system" | undefined;
}): boolean {
  const {
    status,
    hasChatListStreaming,
    userStopped,
    hasAssistantRenderableContent,
    lastMessageRole,
  } = options;

  if (userStopped || isChatInFlight(status) || !hasChatListStreaming) {
    return false;
  }

  if (lastMessageRole !== "assistant") {
    return true;
  }

  return !hasAssistantRenderableContent;
}

export function shouldKeepCollapsedReasoningStreaming(options: {
  isMessageStreaming: boolean;
  hasStreamingReasoningPart: boolean;
  hasRenderableContentAfterGroup: boolean;
}): boolean {
  const {
    isMessageStreaming,
    hasStreamingReasoningPart,
    hasRenderableContentAfterGroup,
  } = options;

  if (!isMessageStreaming) {
    return false;
  }

  if (hasStreamingReasoningPart) {
    return true;
  }

  return !hasRenderableContentAfterGroup;
}
