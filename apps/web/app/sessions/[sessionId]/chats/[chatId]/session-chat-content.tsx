"use client";

import type { AskUserQuestionInput } from "@paco/claude-code";
import { isReasoningUIPart, isToolUIPart, type FileUIPart } from "ai";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  Globe,
  Loader2,
  Mic,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import type { ChatRefreshResponse } from "@/app/api/sessions/[sessionId]/chats/[chatId]/route";
import type { MergePullRequestResult } from "@/lib/github/actions/pr";
import {
  getDeploymentUrl,
  type PrDeploymentResponse,
} from "@/lib/github/queries/deployment";
import type { CheckRun } from "@/lib/github/queries/pr";
import type { PluginRendererInfo } from "@/app/lib/render-tool";
import type {
  WebAgentSnippetDataPart,
  WebAgentUIMessage,
  WebAgentUIMessagePart,
  WebAgentUIToolPart,
} from "@/app/types";
import {
  AssistantFileLink,
  type AssistantFileLinkProps,
} from "@/components/assistant-file-link";
import { FileSuggestionsDropdown } from "@/components/file-suggestions-dropdown";
import { ImageAttachmentsPreview } from "@/components/image-attachments-preview";
import { UnviewableImageNotice } from "./unviewable-image-notice";
import { TextAttachmentsPreview } from "@/components/text-attachments-preview";
import type { ChatBackendSelection } from "@/components/backend-selector-compact";
import { useInlineQuestion } from "@/components/inline-question-input";
import { SlashCommandDropdown } from "@/components/slash-command-dropdown";
import { SnippetChip } from "@/components/snippet-chip";
import { AssistantMessageGroups } from "@/components/assistant-message-groups";
import { MessageModelPill } from "@/components/message-model-pill";
import { PluginPostedBadge } from "@/components/plugin-posted-badge";
import {
  PinnedTodoPanel,
  getLatestTodos,
} from "@/components/pinned-todo-panel";
import { ThinkingBlock } from "@/components/thinking-block";
import { ToolCall } from "@/components/tool-call";
import { OpenFileProvider } from "@/components/tool-call/open-file-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAudioRecording } from "@/hooks/use-audio-recording";
import { useFileSuggestions } from "@/hooks/use-file-suggestions";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { useTextAttachments } from "@/hooks/use-text-attachments";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import { useSessionChats } from "@/hooks/use-session-chats";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import {
  hasRenderableAssistantPart,
  isChatInFlight as isChatInFlightStatus,
  isGitDataPart,
  shouldKeepCollapsedReasoningStreaming,
  shouldRenderGitDataPart,
  shouldShowThinkingIndicator,
  shouldUseChatListStreamingState,
} from "@/lib/chat-streaming-state";
import { ACCEPT_IMAGE_TYPES, isValidImageType } from "@/lib/image-utils";
import { isLargeText } from "@/lib/text-attachment-utils";
import { DEFAULT_CONTEXT_LIMIT } from "@/lib/models";
import { getPrDeploymentRefreshInterval } from "@/lib/pr-deployment-polling";

import { streamdownPlugins } from "@/lib/streamdown-config";
import { cn } from "@/lib/utils";
import {
  type SandboxInfo,
  useSessionChatMetadataContext,
  useSessionChatRuntimeContext,
  useSessionChatWorkspaceContext,
} from "./session-chat-context";
import {
  getConversationCost,
  getConversationUsage,
  getLatestContextUsage,
} from "./conversation-usage";
import {
  getReasoningGroupText,
  groupMessagesForRender,
} from "./message-render-groups";
import { ArchivedWorkspaceNotice } from "./archived-workspace-notice";
import { ContextUsageIndicator } from "./context-usage-indicator";
import { MessageActions } from "./message-actions";
import { GitDataPartCard } from "./git-data-part-card";
import { DesignPanel } from "@/components/design-mode/design-panel";
import { useDesignModeController } from "@/components/design-mode/design-mode-context";
import { DesignToggle } from "@/components/design-mode/design-toggle";
import type { DesignCandidatePreview } from "@/lib/design/candidate-preview-url";
import { ModelEffortBackendControls } from "./model-effort-backend-controls";
import { useStreamRecovery } from "./hooks/use-stream-recovery";
import { useAutoCommitStatus } from "./hooks/use-auto-commit-status";
import { useDevServer } from "./hooks/use-dev-server";
import { useDestructiveConfirm } from "@/hooks/use-destructive-confirm";
import {
  COMPACT_CHAT_CONFIRM,
  FORK_CONVERSATION_CONFIRM,
} from "./conversation-confirm-copy";
import { useGitPanel } from "./git-panel-context";
import { WorkspacePanel } from "./workspace-panel";
import {
  createSandbox,
  getSandboxCreateErrorDetails,
  type SandboxCreateErrorDetails,
} from "./sandbox-create";
import { ApprovalRequestCard } from "@/components/approval-request-card";
import { usePendingApprovals } from "@/hooks/use-pending-approvals";
import { SandboxCreateErrorBanner } from "./sandbox-create-error-banner";
import { WorkspaceFileViewer } from "./workspace-file-viewer";
import "streamdown/styles.css";
import type { EffortSelection } from "@/lib/effort";
import { toast } from "@/lib/toast";

/** Minimum interval between textarea-focus activity pings (5 minutes). */
const ACTIVITY_PING_THROTTLE_MS = 5 * 60 * 1000;

const DiffViewer = dynamic(
  () => import("./diff-viewer").then((m) => m.DiffViewer),
  { ssr: false },
);

const MergePrDialog = dynamic(
  () => import("@/components/merge-pr-dialog").then((m) => m.MergePrDialog),
  { ssr: false },
);
const ClosePrDialog = dynamic(
  () => import("@/components/close-pr-dialog").then((m) => m.ClosePrDialog),
  { ssr: false },
);

const CreateRepoDialog = dynamic(
  () =>
    import("@/components/create-repo-dialog").then((m) => m.CreateRepoDialog),
  { ssr: false },
);
const Streamdown = dynamic(
  () => import("streamdown").then((m) => m.Streamdown),
  { ssr: false },
);
const DiffTabView = dynamic(
  () => import("./diff-tab-view").then((m) => m.DiffTabView),
  { ssr: false },
);
const FileTabView = dynamic(
  () => import("./file-tab-view").then((m) => m.FileTabView),
  { ssr: false },
);
const GitPanel = dynamic(() => import("./git-panel").then((m) => m.GitPanel), {
  ssr: false,
});

const emptySubscribe = () => () => {};

function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

type SandboxReadinessResult = "connected" | "no_sandbox" | "failed";

function isSandboxValid(sandboxInfo: SandboxInfo | null): boolean {
  if (!sandboxInfo) return false;
  if (sandboxInfo.timeout === null) return true; // No timeout = always valid
  const expiresAt = sandboxInfo.createdAt + sandboxInfo.timeout;
  return Date.now() < expiresAt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function SessionChatContent({
  initialIsOnlyChatInSession,
  messageDurationMap,
  messageStartedAtMap,
  lastUserMessageSentAt,
  pluginRenderers,
  designCandidatePreviews,
}: {
  initialIsOnlyChatInSession: boolean;
  /** Pre-computed generation duration (ms) per assistant message ID */
  messageDurationMap: Record<string, number>;
  /** ISO timestamp of the preceding user message's createdAt, for live timers */
  messageStartedAtMap: Record<string, string>;
  /** Fallback: last user message's createdAt, for refresh-during-stream */
  lastUserMessageSentAt: string | null;
  /**
   * Enabled plugins' registered renderers, resolved server-side
   * (`enabledPluginRenderers`, `lib/plugins/renderer-info.ts`) and threaded
   * straight through to `ToolCall`'s `pluginRenderers` prop — see that
   * prop's own doc for why a tool call whose name matches one of these
   * renders in a sandboxed iframe instead of the generic fallback.
   */
  pluginRenderers: PluginRendererInfo[];
  /**
   * Where each design candidate's preview would be reachable, derived on the
   * server from the configured preview base domain
   * (`lib/design/candidate-preview-url.ts`). Empty when no base domain is
   * configured — the design panel then says so rather than embedding a URL
   * that routes nowhere.
   */
  designCandidatePreviews: DesignCandidatePreview[];
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [isCreatingSandbox, setIsCreatingSandbox] = useState(false);
  const [isResumingWorkspace, setIsResumingWorkspace] = useState(false);
  const [_isUnarchiving, _setIsUnarchiving] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [showDiffPanel, setShowDiffPanel] = useState(false);
  const [selectedWorkspaceFile, setSelectedWorkspaceFile] = useState<
    string | null
  >(null);
  const [mobileArchiveDialogOpen, setMobileArchiveDialogOpen] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [copiedAssistantMessageId, setCopiedAssistantMessageId] = useState<
    string | null
  >(null);
  const [forkingAssistantMessageId, setForkingAssistantMessageId] = useState<
    string | null
  >(null);
  const [branchPreviewUrlChangeBaseline, setBranchPreviewUrlChangeBaseline] =
    useState<string | null | undefined>(undefined);
  const hasMounted = useHasMounted();
  const {
    activeView,
    setHasActionNeeded,
    setChangesCount,
    setHasCommittedChanges,
    panelPortalRef,
    workspacePortalRef,
    headerActionsRef,
  } = useGitPanel();
  const { preferences } = useUserPreferences();
  const isIosDevice = useMemo(() => {
    if (typeof navigator === "undefined") {
      return false;
    }

    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isMountedRef = useRef(true);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const lastActivityPingRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);
  const {
    state: recordingState,
    error: recordingError,
    clearError: clearRecordingError,
    toggleRecording,
    isSupported: isDictationSupported,
  } = useAudioRecording();

  const handleMicClick = async () => {
    clearRecordingError();
    const transcribedText = await toggleRecording();
    if (transcribedText) {
      setInput((prev) =>
        prev ? `${prev} ${transcribedText}` : transcribedText,
      );
      inputRef.current?.focus();
    }
  };

  const handleCopyAssistantMessage = useCallback(
    async (messageId: string, text: string) => {
      const trimmedText = text.trim();
      if (trimmedText.length === 0) {
        return;
      }

      if (typeof navigator === "undefined" || !navigator.clipboard) {
        return;
      }

      try {
        await navigator.clipboard.writeText(trimmedText);
        setCopiedAssistantMessageId(messageId);
        if (copyResetTimeoutRef.current !== null) {
          window.clearTimeout(copyResetTimeoutRef.current);
        }
        copyResetTimeoutRef.current = window.setTimeout(() => {
          setCopiedAssistantMessageId((currentMessageId) =>
            currentMessageId === messageId ? null : currentMessageId,
          );
          copyResetTimeoutRef.current = null;
        }, 2000);
      } catch (copyError) {
        console.error("Failed to copy assistant message:", copyError);
      }
    },
    [],
  );

  // Auto-resize textarea up to 3 lines
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    const computedStyle = getComputedStyle(textarea);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 24;
    const maxLines = 3;
    const maxHeight = lineHeight * maxLines;

    // Store current height to avoid flicker
    const currentHeight = textarea.offsetHeight;

    // Temporarily set height to 0 to measure scrollHeight accurately
    textarea.style.height = "0";
    const scrollHeight = textarea.scrollHeight;

    // Set new height, capped at max
    const newHeight = Math.min(scrollHeight, maxHeight);

    // Only update if height actually changed to minimize reflows
    if (Math.abs(newHeight - currentHeight) > 1) {
      textarea.style.height = `${newHeight}px`;
    } else {
      textarea.style.height = `${currentHeight}px`;
    }
  }, [input]);

  const {
    images,
    addImage,
    addImages,
    removeImage,
    clearImages,
    getFileParts,
    fileInputRef,
    openFilePicker,
  } = useImageAttachments();
  const {
    textAttachments,
    addTextAttachment,
    removeTextAttachment,
    clearTextAttachments,
  } = useTextAttachments();
  const { containerRef, isAtBottom, scrollToBottom } =
    useScrollToBottom<HTMLDivElement>();
  const {
    session,
    chatInfo,
    chatCapabilities,
    setSandboxInfo,
    archiveSession,
    unarchiveSession,
    updateChatModel,
    updateChatEffort,
    updateChatBackend,
    updateSessionTitle,
    hasRuntimeSandboxState,
    hasPausedWorkspace,
    reconnectionStatus,
    lifecycleTiming,
    syncSandboxStatus,
    attemptReconnection,
    updateSessionRepo,
    updateSessionPullRequest,
    checkBranchAndPr,
    modelOptions,
    modelOptionsLoading,
  } = useSessionChatMetadataContext();
  const {
    chat,
    contextLimit,
    stopChatStream,
    retryChatStream,
    workspaceStatus,
    hadInitialMessages,
    initialMessages,
  } = useSessionChatRuntimeContext();
  const {
    sandboxInfo,
    diff,
    refreshDiff,
    gitStatus,
    refreshGitStatus,
    files,
    filesLoading,
    refreshFiles,
    skills,
    skillsLoading,
    refreshSkills,
  } = useSessionChatWorkspaceContext();

  // Ping the server to refresh the inactivity timer when the user focuses
  // the textarea. Throttled to at most once every 5 minutes so we don't
  // spam the endpoint on repeated focus/blur cycles.
  const handleTextareaFocus = useCallback(() => {
    const now = Date.now();
    if (now - lastActivityPingRef.current < ACTIVITY_PING_THROTTLE_MS) {
      return;
    }
    lastActivityPingRef.current = now;
    void fetch("/api/sandbox/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    }).catch(() => {
      // Fire-and-forget – don't block the UI on failures.
    });
  }, [session.id]);

  const autoCommitEnabled = Boolean(
    session.cloneUrl &&
    session.repoOwner &&
    session.repoName &&
    (session.autoCommitPushOverride ?? preferences?.autoCommitPush ?? false),
  );
  const { isAutoCommitting, markAutoCommitStarted } = useAutoCommitStatus(
    autoCommitEnabled,
    gitStatus,
    () => {
      void refreshGitStatus().catch(() => undefined);
      void refreshDiff().catch(() => undefined);
      void refreshFiles().catch(() => undefined);
      void checkBranchAndPr().catch(() => undefined);
    },
  );
  const {
    messages,
    error,
    clearError,
    sendMessage,
    setMessages,
    status,
    addToolApprovalResponse,
    addToolOutput,
  } = chat;
  const {
    chats,
    markChatRead,
    setChatStreaming,
    setChatTitle,
    clearChatTitle,
    refreshChats,
    forkChat,
  } = useSessionChats(session.id);
  const currentChatListItem = useMemo(
    () => chats.find((candidate) => candidate.id === chatInfo.id) ?? null,
    [chatInfo.id, chats],
  );
  /*
   * Questions worth asking before doing, in Paco's own dialog rather than the
   * browser's. See `use-destructive-confirm` for why `window.confirm` had to
   * go — the short version is that a browser can switch it off, and a guard
   * that can be switched off is not a guard.
   *
   * Declared here rather than beside the first destructive handler because
   * forking is the earliest caller.
   */
  const { confirm: confirmDestructive, dialog: destructiveConfirmDialog } =
    useDestructiveConfirm();

  const handleForkAssistantMessage = useCallback(
    async (messageId: string) => {
      if (forkingAssistantMessageId !== null) {
        return;
      }

      // Forking takes nothing away, but it opens the new chat straight away
      // and the button is an unlabelled icon — so being moved somewhere else
      // is the surprise the dialog exists to remove.
      const confirmed = await confirmDestructive(FORK_CONVERSATION_CONFIRM);
      if (!confirmed) {
        return;
      }

      setForkingAssistantMessageId(messageId);
      try {
        const { persisted } = forkChat(chatInfo.id, messageId);
        const forkedChat = await persisted;
        router.push(`/sessions/${session.id}/chats/${forkedChat.id}`, {
          scroll: false,
        });
      } catch (forkError) {
        console.error("Failed to fork chat:", forkError);
      } finally {
        if (isMountedRef.current) {
          setForkingAssistantMessageId((currentMessageId) =>
            currentMessageId === messageId ? null : currentMessageId,
          );
        }
      }
    },
    [
      chatInfo.id,
      confirmDestructive,
      forkChat,
      forkingAssistantMessageId,
      router,
      session.id,
    ],
  );
  const upsertSyntheticAssistantGitMessage = useCallback(
    async (message: WebAgentUIMessage) => {
      setMessages((currentMessages) => {
        const existingIndex = currentMessages.findIndex(
          (currentMessage) => currentMessage.id === message.id,
        );

        if (existingIndex < 0) {
          return [...currentMessages, message];
        }

        const nextMessages = [...currentMessages];
        nextMessages[existingIndex] = message;
        return nextMessages;
      });

      try {
        const response = await fetch(
          `/api/sessions/${session.id}/chats/${chatInfo.id}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          },
        );

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            body?.error ?? "Failed to persist synthetic assistant message",
          );
        }

        await refreshChats().catch(() => undefined);
        await markChatRead(chatInfo.id).catch(() => undefined);
      } catch (error) {
        console.error(
          "Failed to persist synthetic assistant git message:",
          error,
        );
      }
    },
    [chatInfo.id, markChatRead, refreshChats, session.id, setMessages],
  );
  const renderMessages = useMemo(
    () => (hasMounted ? messages : initialMessages),
    [hasMounted, messages, initialMessages],
  );
  // Track explicit user-initiated stops so the UI can immediately reflect the
  // idle state even if the AI SDK `status` is stuck (common on iOS/Safari where
  // fetch abort doesn't cleanly settle the hook status).
  const [userStopped, setUserStopped] = useState(false);
  const isChatInFlight = isChatInFlightStatus(status) && !userStopped;

  const { approvals: pendingApprovals, decide: decideApprovalRequest } =
    usePendingApprovals({
      sessionId: session.id,
      chatId: chatInfo.id,
    });
  const lastMessage = useMemo(
    () => renderMessages[renderMessages.length - 1],
    [renderMessages],
  );
  const hasAssistantRenderableContent = useMemo(
    () =>
      lastMessage?.role === "assistant"
        ? lastMessage.parts.some(hasRenderableAssistantPart)
        : false,
    [lastMessage],
  );
  const shouldUseChatListStreaming = useMemo(
    () =>
      shouldUseChatListStreamingState({
        status,
        hasChatListStreaming: currentChatListItem?.isStreaming ?? false,
        userStopped,
        hasAssistantRenderableContent,
        lastMessageRole: lastMessage?.role,
      }),
    [
      currentChatListItem?.isStreaming,
      hasAssistantRenderableContent,
      lastMessage?.role,
      status,
      userStopped,
    ],
  );
  const hasSeenAssistantRenderableContentRef = useRef(false);
  const [hasPendingResponse, setHasPendingResponse] = useState(false);
  /** Captures Date.now() when the user sends a message, so the streaming
   *  summary bar can show an accurate live timer from the actual send time. */
  const lastSendTimestampRef = useRef<number | null>(null);

  // Ensure a stop action from one chat does not suppress the in-flight state
  // after switching to a different chat.
  useEffect(() => {
    setUserStopped(false);
  }, [chatInfo.id]);

  // Sync hasPendingResponse with the AI SDK status.
  // IMPORTANT: hasPendingResponse is intentionally excluded from the dependency
  // array. The form submit handler sets it to true optimistically (before
  // sendMessage is called), and including it here would cause the effect to
  // immediately clear it because status is still "ready" at that point —
  // resulting in a visible flicker of the thinking indicator and stop button.
  useEffect(() => {
    if (isChatInFlight || shouldUseChatListStreaming) {
      setHasPendingResponse(true);
      return;
    }

    if (status === "error" || status === "ready") {
      setHasPendingResponse(false);
      setUserStopped(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [isChatInFlight, shouldUseChatListStreaming, status]);

  useEffect(() => {
    if (!isChatInFlight && !hasPendingResponse) {
      hasSeenAssistantRenderableContentRef.current = false;
      return;
    }
    // Only mark content as "seen" once we're actually in-flight — not during
    // the optimistic pending phase where messages are still stale from the
    // previous turn (due to experimental_throttle).  Without this guard the
    // ref gets set to true from the *old* assistant message, which causes the
    // thinking indicator to disappear prematurely when the new (empty)
    // assistant message arrives.
    if (isChatInFlight && hasAssistantRenderableContent) {
      hasSeenAssistantRenderableContentRef.current = true;
    }
  }, [isChatInFlight, hasPendingResponse, hasAssistantRenderableContent]);

  const hasSeenAssistantRenderableContent =
    hasAssistantRenderableContent ||
    hasSeenAssistantRenderableContentRef.current;
  const effectiveStatus = userStopped
    ? "ready"
    : hasPendingResponse || shouldUseChatListStreaming
      ? "streaming"
      : status;
  const showThinkingIndicator = useMemo(() => {
    // During the optimistic pending phase (user just clicked send but the
    // AI SDK status hasn't caught up yet due to throttling), always show
    // the thinking indicator.  The messages are stale at this point so
    // shouldShowThinkingIndicator would make the wrong decision based on
    // the previous turn's content.
    if (hasPendingResponse && !isChatInFlight) {
      return true;
    }
    return shouldShowThinkingIndicator({
      status: effectiveStatus,
      hasAssistantRenderableContent: hasSeenAssistantRenderableContent,
      lastMessageRole: lastMessage?.role,
    });
  }, [
    effectiveStatus,
    hasSeenAssistantRenderableContent,
    lastMessage?.role,
    hasPendingResponse,
    isChatInFlight,
  ]);
  const latestTodos = useMemo(() => getLatestTodos(messages), [messages]);

  const groupedRenderMessages = useMemo(
    () => groupMessagesForRender(renderMessages, isChatInFlight),
    [renderMessages, isChatInFlight],
  );
  // Markdown renderer component map, not a component defined during render:
  // the map is memoized, so its identity is stable and nothing remounts.
  const streamdownComponents = useMemo(
    () => ({
      // oxlint-disable-next-line react/no-unstable-nested-components
      a: (props: AssistantFileLinkProps) => (
        <AssistantFileLink
          {...props}
          onOpenFile={(filePath) => {
            setSelectedWorkspaceFile(filePath);
          }}
        />
      ),
    }),
    [],
  );
  const [isUpdatingModel, setIsUpdatingModel] = useState(false);
  const lastStatusSyncAtRef = useRef(0);
  const statusSyncInFlightRef = useRef(false);
  const pendingOptimisticTitleChatIdRef = useRef<string | null>(null);
  const hasRequestedSessionTitleGenerationRef = useRef(false);
  const markReadRef = useRef<{
    lastAt: number;
    lastChatId: string | null;
    inFlight: boolean;
  }>({
    lastAt: 0,
    lastChatId: null,
    inFlight: false,
  });
  const requestStatusSync = useCallback(
    async (mode: "normal" | "force" = "normal"): Promise<void> => {
      const now = Date.now();
      if (statusSyncInFlightRef.current) return;
      if (mode === "normal" && now - lastStatusSyncAtRef.current < 5_000) {
        return;
      }

      statusSyncInFlightRef.current = true;
      try {
        await syncSandboxStatus();
        lastStatusSyncAtRef.current = Date.now();
      } finally {
        statusSyncInFlightRef.current = false;
      }
    },
    [syncSandboxStatus],
  );

  const requestMarkChatRead = useCallback(
    async (mode: "normal" | "force" = "normal"): Promise<void> => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }

      // For passive/background-triggered marks, require focus too.
      // Force marks run on route entry/turn completion and should not wait for
      // focus when the tab is already visible.
      if (
        mode === "normal" &&
        typeof document !== "undefined" &&
        !document.hasFocus()
      ) {
        return;
      }

      const now = Date.now();
      const isSameChat = markReadRef.current.lastChatId === chatInfo.id;
      if (markReadRef.current.inFlight) return;
      if (
        mode === "normal" &&
        isSameChat &&
        now - markReadRef.current.lastAt < 3_000
      ) {
        return;
      }

      markReadRef.current.inFlight = true;
      try {
        await markChatRead(chatInfo.id);
        markReadRef.current.lastAt = Date.now();
        markReadRef.current.lastChatId = chatInfo.id;
      } catch (err) {
        console.error("Failed to mark chat read:", err);
      } finally {
        markReadRef.current.inFlight = false;
      }
    },
    [chatInfo.id, markChatRead],
  );
  const requestMarkChatReadRef = useRef(requestMarkChatRead);
  const tabResumeRefreshRef = useRef({
    pending: false,
    inFlight: false,
    lastAt: 0,
  });
  const shouldSkipServerSnapshotOverwriteRef = useRef(false);
  const sandboxActionReadyPromiseRef = useRef<Promise<boolean> | null>(null);

  const refreshCurrentChatSnapshot = useCallback(async (): Promise<void> => {
    if (shouldSkipServerSnapshotOverwriteRef.current) {
      return;
    }

    const response = await fetch(
      `/api/sessions/${session.id}/chats/${chatInfo.id}`,
      {
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as ChatRefreshResponse;
    if (data.isStreaming) {
      return;
    }

    clearError();
    setMessages(data.messages);
  }, [chatInfo.id, clearError, session.id, setMessages]);

  const refreshAfterTabResume = useCallback(async (): Promise<void> => {
    if (
      typeof document !== "undefined" &&
      (document.visibilityState !== "visible" || !document.hasFocus())
    ) {
      return;
    }

    tabResumeRefreshRef.current.pending = false;

    const now = Date.now();
    if (tabResumeRefreshRef.current.inFlight) {
      return;
    }
    if (now - tabResumeRefreshRef.current.lastAt < 3_000) {
      return;
    }

    tabResumeRefreshRef.current.inFlight = true;
    try {
      await Promise.allSettled([
        requestStatusSync("force"),
        refreshCurrentChatSnapshot(),
        refreshChats(),
        refreshGitStatus(),
        refreshDiff(),
        refreshFiles(),
        refreshSkills(),
        checkBranchAndPr(),
      ]);
    } finally {
      tabResumeRefreshRef.current.lastAt = Date.now();
      tabResumeRefreshRef.current.inFlight = false;
    }
  }, [
    checkBranchAndPr,
    refreshChats,
    refreshCurrentChatSnapshot,
    refreshDiff,
    refreshFiles,
    refreshGitStatus,
    refreshSkills,
    requestStatusSync,
  ]);

  useEffect(() => {
    requestMarkChatReadRef.current = requestMarkChatRead;
  }, [requestMarkChatRead]);

  useEffect(() => {
    hasRequestedSessionTitleGenerationRef.current = false;
  }, [session.id]);

  // Refresh chats list when the first message completes to pick up the auto-generated title
  useEffect(() => {
    if (
      !hadInitialMessages &&
      status === "ready" &&
      messages.some((m) => m.role === "assistant")
    ) {
      refreshChats();
    }
  }, [hadInitialMessages, status, messages, refreshChats]);

  useEffect(() => {
    void requestMarkChatReadRef.current("force");
  }, [chatInfo.id]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        tabResumeRefreshRef.current.pending = true;
        return;
      }

      void requestMarkChatRead("normal");
      if (!tabResumeRefreshRef.current.pending) {
        return;
      }

      void refreshAfterTabResume();
    };
    const handleWindowBlur = () => {
      tabResumeRefreshRef.current.pending = true;
    };
    const handleWindowFocus = () => {
      void requestMarkChatRead("normal");
      if (!tabResumeRefreshRef.current.pending) {
        return;
      }

      void refreshAfterTabResume();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [refreshAfterTabResume, requestMarkChatRead]);

  useStreamRecovery({
    sessionId: session.id,
    chatId: chatInfo.id,
    status,
    isChatInFlight,
    hasAssistantRenderableContent,
    retryChatStream,
  });

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!modelId || modelId === chatInfo.modelId) return;
      try {
        setIsUpdatingModel(true);
        await updateChatModel(modelId);
      } catch (err) {
        console.error("Failed to update chat model:", err);
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [chatInfo.modelId, updateChatModel],
  );

  const [revertingMessageId, setRevertingMessageId] = useState<string | null>(
    null,
  );

  const handleRevertTurn = useCallback(
    async (messageId: string, checkpointSha: string) => {
      // Destructive and not undoable, so it is confirmed rather than
      // optimistic — and the wording says what actually goes, including any
      // edits made by hand since the turn.
      const confirmed = await confirmDestructive({
        confirmLabel: "Revert this turn",
        description:
          "Every file change made since — by the agent and by you — will be discarded. This cannot be undone.",
        title: "Revert this turn?",
      });
      if (!confirmed) return;

      setRevertingMessageId(messageId);
      try {
        const response = await fetch(
          `/api/sessions/${session.id}/chats/${chatInfo.id}/revert`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ checkpointSha }),
          },
        );

        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          toast.error(data.error ?? "Could not revert this turn.");
          return;
        }

        toast.success("Reverted to before this turn.");
        // The workspace views are now showing a tree that no longer exists.
        await Promise.all([
          refreshDiff().catch(() => undefined),
          refreshFiles().catch(() => undefined),
          refreshGitStatus().catch(() => undefined),
        ]);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not revert this turn.",
        );
      } finally {
        setRevertingMessageId(null);
      }
    },
    [
      session.id,
      chatInfo.id,
      confirmDestructive,
      refreshDiff,
      refreshFiles,
      refreshGitStatus,
    ],
  );

  const [isCompacting, setIsCompacting] = useState(false);

  const handleCompact = useCallback(async () => {
    // Compaction trades the conversation for a summary of it and spends a
    // model call doing so, so it asks first — and then works with the dialog
    // still open, because it is slow enough that a dismissed dialog and a
    // quiet composer read as nothing having happened.
    await confirmDestructive({
      ...COMPACT_CHAT_CONFIRM,
      run: async () => {
        setIsCompacting(true);
        try {
          const response = await fetch(
            `/api/sessions/${session.id}/chats/${chatInfo.id}/compact`,
            { method: "POST" },
          );
          const data = (await response.json()) as {
            error?: string;
            summary?: string;
          };

          if (!response.ok) {
            // "Not enough messages to compact" is the normal answer on a short
            // conversation, so this is information rather than a failure — and
            // it belongs on the dialog, where the person is still looking.
            return data.error ?? "Could not compact this chat.";
          }

          toast.success("Context compacted.");
          return null;
        } catch (error) {
          return error instanceof Error
            ? error.message
            : "Could not compact this chat.";
        } finally {
          setIsCompacting(false);
        }
      },
    });
  }, [session.id, chatInfo.id, confirmDestructive]);

  const handleEffortChange = useCallback(
    async (effort: EffortSelection) => {
      if (effort === (chatInfo.effort ?? null)) return;
      try {
        setIsUpdatingModel(true);
        await updateChatEffort(effort);
      } catch (err) {
        console.error("Failed to update reasoning effort:", err);
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [chatInfo.effort, updateChatEffort],
  );

  const handleBackendChange = useCallback(
    async (backend: ChatBackendSelection) => {
      if (backend === chatInfo.backend) return;
      try {
        setIsUpdatingModel(true);
        await updateChatBackend(backend);
      } catch (err) {
        console.error("Failed to update agent backend:", err);
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [chatInfo.backend, updateChatBackend],
  );

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.id === chatInfo.modelId),
    [modelOptions, chatInfo.modelId],
  );

  const handleFileSelect = (
    value: string,
    mentionStart: number,
    cursorPos: number,
  ) => {
    const before = input.slice(0, mentionStart);
    const after = input.slice(cursorPos);
    const newInput = `${before}@${value} ${after}`;
    setInput(newInput);
    // Move cursor to after the inserted value + space
    const newCursorPos = mentionStart + value.length + 2; // @ + value + space
    setCursorPosition(newCursorPos);
    // Focus input and set cursor position after React renders
    setTimeout(() => {
      // Only set cursor if input hasn't changed (user didn't type in between)
      if (inputRef.current && inputRef.current.value === newInput) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  const {
    showSuggestions,
    suggestions,
    selectedIndex,
    handleKeyDown: handleSuggestionsKeyDown,
    mentionInfo,
  } = useFileSuggestions({
    inputValue: input,
    cursorPosition,
    files,
    onSelect: handleFileSelect,
  });

  const handleSlashCommandSelect = (
    skillName: string,
    slashStart: number,
    cursorPos: number,
  ) => {
    const before = input.slice(0, slashStart);
    const after = input.slice(cursorPos);
    const newInput = `${before}/${skillName} ${after}`;
    setInput(newInput);
    const newCursorPos = slashStart + skillName.length + 2; // / + name + space
    setCursorPosition(newCursorPos);
    setTimeout(() => {
      if (inputRef.current && inputRef.current.value === newInput) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  const {
    showSlashCommands,
    slashSuggestions,
    selectedSlashIndex,
    handleSlashKeyDown,
    slashInfo,
  } = useSlashCommands({
    inputValue: input,
    cursorPosition,
    skills,
    onSelect: handleSlashCommandSelect,
  });

  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [sandboxCreateError, setSandboxCreateError] =
    useState<SandboxCreateErrorDetails | null>(null);
  const [deleteMessageError, setDeleteMessageError] = useState<string | null>(
    null,
  );
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(
    null,
  );
  const [resendingMessageId, setResendingMessageId] = useState<string | null>(
    null,
  );

  const hasMessageActionInFlight =
    deletingMessageId !== null || resendingMessageId !== null || isChatInFlight;

  shouldSkipServerSnapshotOverwriteRef.current =
    hasPendingResponse ||
    deletingMessageId !== null ||
    resendingMessageId !== null;

  const sendMessageWithPendingState = useCallback(
    async (
      message: Parameters<typeof sendMessage>[0],
      // Per-send request-body extras. Design mode is the only caller: the
      // composer's toggle decides how *this* message runs, so `mode` travels
      // with the send rather than living on the chat.
      options?: Parameters<typeof sendMessage>[1],
    ) => {
      setHasPendingResponse(true);
      setUserStopped(false);
      lastSendTimestampRef.current = Date.now();
      hasSeenAssistantRenderableContentRef.current = false;
      void setChatStreaming(chatInfo.id, true);

      try {
        await sendMessage(message, options);
      } catch (error) {
        setHasPendingResponse(false);
        void setChatStreaming(chatInfo.id, false);
        throw error;
      }
    },
    [chatInfo.id, sendMessage, setChatStreaming],
  );

  /*
   * Design mode: the composer's toggle, and the panel a design turn opens.
   *
   * All of its state lives in `useDesignModeController`
   * (`components/design-mode/design-mode-context.tsx`) rather than here —
   * this file is already long enough that AGENTS.md asks for new feature
   * behaviour to arrive as a colocated hook.
   */
  const sendDesignMessage = useCallback(
    async (text: string, extraBody: Record<string, unknown>) => {
      await sendMessageWithPendingState({ text }, { body: extraBody });
    },
    [sendMessageWithPendingState],
  );

  const appendDesignMessage = useCallback(
    (message: WebAgentUIMessage) => {
      setMessages((current) => [...current, message]);
    },
    [setMessages],
  );

  const design = useDesignModeController({
    appendMessage: appendDesignMessage,
    candidatePreviews: designCandidatePreviews,
    chatId: chatInfo.id,
    messages,
    sendDesignMessage,
    sessionId: session.id,
    turnInFlight: isChatInFlight,
  });

  // Aliased only so the JSX handler prop reads as a handler: it is the
  // `useState` setter the controller hands back, already stable.
  const handleDesignToggle = design.setDesignModeEnabled;

  const handleFixChecks = useCallback(
    async (failedRuns: CheckRun[]) => {
      const names = failedRuns.map((run) => run.name).join(", ");
      const fallbackPrompt = `# Fix Failing Checks\n\nThe following checks are failing: ${names}. Please investigate and push a fix.`;
      let messagePayload: Parameters<typeof sendMessageWithPendingState>[0] = {
        text: fallbackPrompt,
      };

      try {
        const res = await fetch(`/api/sessions/${session.id}/checks/fix`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkRuns: failedRuns }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            prompt?: string;
            snippets?: Array<{ filename: string; content: string }>;
            message?: string;
          };
          const prompt = data.prompt?.trim() || data.message?.trim();
          const snippets = Array.isArray(data.snippets) ? data.snippets : [];

          if (prompt && snippets.length > 0) {
            messagePayload = {
              parts: [
                {
                  type: "text" as const,
                  text: prompt,
                },
                ...snippets.map((snippet, index) => ({
                  type: "data-snippet" as const,
                  id: `fix-check-${index}`,
                  data: snippet,
                })),
              ],
            };
          } else if (prompt) {
            messagePayload = { text: prompt };
          }
        }
      } catch {
        // Fall through to fallback
      }

      await sendMessageWithPendingState(messagePayload);
    },
    [sendMessageWithPendingState, session.id],
  );

  const handleFixConflicts = useCallback(
    async (baseBranchRef: string, closeMergeDialog = false) => {
      if (closeMergeDialog) {
        setMergeDialogOpen(false);
      }

      await sendMessageWithPendingState({
        text: `# Resolve Merge Conflicts\n\nThere is a merge conflict with ${baseBranchRef}. Fetch and then fix the conflicts. Do not rebase.`,
      });
    },
    [sendMessageWithPendingState],
  );

  const handleDeleteUserMessage = useCallback(
    async (messageId: string) => {
      if (hasMessageActionInFlight) {
        return;
      }

      const targetMessageIndex = messages.findIndex(
        (message) => message.id === messageId,
      );
      if (
        targetMessageIndex < 0 ||
        messages[targetMessageIndex]?.role !== "user"
      ) {
        return;
      }

      const confirmed = await confirmDestructive({
        confirmLabel: "Delete them",
        description:
          "This message and every reply after it will be removed from the conversation. Files in your workspace are left alone.",
        title: "Delete this message and everything after it?",
      });
      if (!confirmed) {
        return;
      }

      setDeleteMessageError(null);
      setDeletingMessageId(messageId);

      try {
        const response = await fetch(
          `/api/sessions/${session.id}/chats/${chatInfo.id}/messages/${messageId}`,
          { method: "DELETE" },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          success?: boolean;
        };

        if (!response.ok || !payload.success) {
          throw new Error(payload.error ?? "Failed to delete message");
        }

        setMessages(messages.slice(0, targetMessageIndex));
        await refreshChats();
      } catch (err) {
        console.error("Failed to delete message:", err);
        setDeleteMessageError(
          err instanceof Error ? err.message : "Failed to delete message",
        );
      } finally {
        setDeletingMessageId(null);
      }
    },
    [
      hasMessageActionInFlight,
      messages,
      session.id,
      chatInfo.id,
      confirmDestructive,
      setMessages,
      refreshChats,
    ],
  );

  const handleResendUserMessage = useCallback(
    async (messageId: string) => {
      if (hasMessageActionInFlight) {
        return;
      }

      const targetMessageIndex = messages.findIndex(
        (message) => message.id === messageId,
      );
      const targetMessage = messages[targetMessageIndex];
      if (!targetMessage || targetMessage.role !== "user") {
        return;
      }

      const resendTextParts = targetMessage.parts
        .filter(
          (part): part is Extract<WebAgentUIMessagePart, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => ({
          type: "text" as const,
          text: part.text,
        }));
      const resendText = resendTextParts.map((part) => part.text).join("");
      const resendFiles = targetMessage.parts
        .filter((part): part is FileUIPart => part.type === "file")
        .map((part) => ({
          type: "file" as const,
          mediaType: part.mediaType,
          url: part.url,
          ...(part.filename ? { filename: part.filename } : {}),
        }));
      const resendSnippets = targetMessage.parts
        .filter(
          (part): part is WebAgentSnippetDataPart =>
            part.type === "data-snippet",
        )
        .map((part) => ({
          type: "data-snippet" as const,
          id: part.id,
          data: {
            content: part.data.content,
            filename: part.data.filename,
          },
        }));

      if (
        !resendText.trim() &&
        resendFiles.length === 0 &&
        resendSnippets.length === 0
      ) {
        return;
      }

      const confirmed = await confirmDestructive({
        confirmLabel: "Send it again",
        description:
          "Everything after this message will be removed from the conversation first, so the assistant answers it fresh. Files in your workspace are left alone.",
        title: "Send this message again?",
      });
      if (!confirmed) {
        return;
      }

      setDeleteMessageError(null);
      setResendingMessageId(messageId);

      try {
        const response = await fetch(
          `/api/sessions/${session.id}/chats/${chatInfo.id}/messages/${messageId}`,
          { method: "DELETE" },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          success?: boolean;
        };

        if (!response.ok || !payload.success) {
          throw new Error(payload.error ?? "Failed to resend message");
        }

        setMessages(messages.slice(0, targetMessageIndex));
        await sendMessageWithPendingState(
          resendSnippets.length > 0
            ? {
                parts: [...resendTextParts, ...resendFiles, ...resendSnippets],
              }
            : {
                text: resendText,
                files: resendFiles.length > 0 ? resendFiles : undefined,
              },
        );

        await refreshChats();
      } catch (err) {
        console.error("Failed to resend message:", err);
        setDeleteMessageError(
          err instanceof Error ? err.message : "Failed to resend message",
        );
      } finally {
        setResendingMessageId(null);
      }
    },
    [
      hasMessageActionInFlight,
      messages,
      session.id,
      chatInfo.id,
      confirmDestructive,
      setMessages,
      sendMessageWithPendingState,
      refreshChats,
    ],
  );

  const waitForSandboxReady = useCallback(
    async (maxAttempts = 8): Promise<boolean> => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await attemptReconnection();
        if (result === "connected") {
          return true;
        }

        // Keep lifecycle timing fresh during restore retries, but do not treat
        // DB-only "active" as fully ready until reconnect confirms connectivity.
        await syncSandboxStatus();
        if (attempt < maxAttempts) {
          await sleep(attempt * 350);
        }
      }
      return false;
    },
    [attemptReconnection, syncSandboxStatus],
  );

  const checkSandboxReadiness =
    useCallback(async (): Promise<SandboxReadinessResult> => {
      const result = await attemptReconnection();
      if (result === "connected" || result === "no_sandbox") {
        return result;
      }

      await syncSandboxStatus();
      return "failed";
    }, [attemptReconnection, syncSandboxStatus]);

  const refreshWorkspaceAfterRestore = useCallback(async () => {
    await requestStatusSync("force").catch(() => undefined);
    await Promise.all([
      refreshGitStatus().catch(() => undefined),
      refreshDiff().catch(() => undefined),
      refreshFiles().catch(() => undefined),
      checkBranchAndPr().catch(() => undefined),
    ]);
  }, [
    requestStatusSync,
    refreshGitStatus,
    refreshDiff,
    refreshFiles,
    checkBranchAndPr,
  ]);

  /**
   * Wake a workspace that has gone to sleep.
   *
   * This used to PUT `/api/sandbox/snapshot`, an endpoint that was deleted when
   * sandboxes became named Docker containers backed by a directory on the host:
   * there is no snapshot to restore any more, because nothing is ever thrown
   * away. The call stayed behind and answered 404 on every attempt, so waking a
   * workspace always ended at "Sandbox resume failed: Unknown error" — and it
   * said so even when the container came back anyway, because the reconnect
   * that followed had nothing to do with this request.
   *
   * Reconnecting *is* resuming now. `waitForSandboxReady` starts the container
   * if it is stopped and polls until it answers, which is the whole operation.
   */
  const handleResumeSandbox = useCallback(async () => {
    setIsResumingWorkspace(true);
    setRestoreError(null);

    try {
      const reconnected = await waitForSandboxReady();
      shouldRefreshRestoredWorkspaceRef.current = reconnected;

      if (!reconnected) {
        setRestoreError(
          "This workspace is taking longer than usual to wake up. Try again in a moment — nothing has been lost.",
        );
      }
    } catch (err) {
      shouldRefreshRestoredWorkspaceRef.current = false;
      const errorMsg = err instanceof Error ? err.message : String(err);
      setRestoreError(`We couldn't wake this workspace: ${errorMsg}`);
    } finally {
      setIsResumingWorkspace(false);
    }
  }, [waitForSandboxReady]);

  const handleCreateNewSandbox = useCallback(async () => {
    setIsCreatingSandbox(true);
    setSandboxCreateError(null);

    try {
      const branchExistsOnOrigin = session.prNumber != null;
      const shouldCreateNewBranch =
        session.isNewBranch && !branchExistsOnOrigin;
      const newSandbox = await createSandbox(
        session.cloneUrl ?? undefined,
        session.branch ?? undefined,
        shouldCreateNewBranch,
        session.id,
      );
      setSandboxInfo(newSandbox);
      setSandboxCreateError(null);
      void requestStatusSync("force");
    } catch (err) {
      const details = getSandboxCreateErrorDetails(err);
      setSandboxCreateError(details);
      console.error("Failed to create sandbox:", err);
    } finally {
      setIsCreatingSandbox(false);
    }
  }, [
    session.prNumber,
    session.isNewBranch,
    session.cloneUrl,
    session.branch,
    session.id,
    setSandboxInfo,
    requestStatusSync,
  ]);

  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
  }, [messages, isAtBottom, scrollToBottom]);

  useEffect(() => {
    if (!isChatInFlight) {
      inputRef.current?.focus();
    }
  }, [isChatInFlight]);

  // After a chat turn completes, immediately sync state from the server.
  // Auto-commit itself runs server-side so it still happens when this page is
  // not open; the client just reconciles git, diff, and PR state.
  // Initialize to null (not `status`) so the first render always reconciles.
  // When navigating back to a chat whose stream finished in the background,
  // status is already "ready" but the optimistic streaming overlay may still
  // be set. Starting from null makes `becameReady` true on mount, which clears
  // the stale overlay immediately.
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const wasStreaming = prevStatus === "streaming";
    const wasSubmitted = prevStatus === "submitted";
    const becameReady = status === "ready" && prevStatus !== "ready";
    const becameError = status === "error" && prevStatus !== "error";
    const shouldClearStreaming = status === "error" || becameReady;
    prevStatusRef.current = status;

    // Skip clearing the streaming overlay during unmount. Route teardown aborts
    // local transport connections, which can still trigger a transient status
    // transition before React finishes unmounting. Clearing here would remove
    // the optimistic streaming badge even though the server-side stream may
    // still be running. SWR polling + overlay reconciliation clear it once the
    // server confirms the stream has actually ended.
    if (shouldClearStreaming && isMountedRef.current) {
      void setChatStreaming(chatInfo.id, false);
    }
    if (becameError && pendingOptimisticTitleChatIdRef.current) {
      void clearChatTitle(pendingOptimisticTitleChatIdRef.current);
      pendingOptimisticTitleChatIdRef.current = null;
    }
    if (becameReady) {
      pendingOptimisticTitleChatIdRef.current = null;
    }

    let followUpTimeout: ReturnType<typeof setTimeout> | null = null;
    if (
      (wasStreaming || wasSubmitted) &&
      status === "ready" &&
      isMountedRef.current
    ) {
      if (!userStopped) {
        markAutoCommitStarted();
      }

      const refreshCompletedTurnState = async () => {
        await requestStatusSync("force").catch(() => undefined);
        await refreshGitStatus().catch(() => undefined);
        await refreshDiff().catch(() => undefined);
        await refreshFiles().catch(() => undefined);
        await checkBranchAndPr().catch(() => undefined);
      };

      void refreshCompletedTurnState();
      void requestMarkChatRead("force");
      void refreshChats();

      if (session.cloneUrl && session.repoOwner && session.repoName) {
        followUpTimeout = setTimeout(() => {
          void refreshCompletedTurnState();
        }, 3000);
      }
    }

    return () => {
      if (followUpTimeout !== null) {
        clearTimeout(followUpTimeout);
      }
    };
  }, [
    status,
    chatInfo.id,
    setChatStreaming,
    clearChatTitle,
    requestStatusSync,
    refreshGitStatus,
    refreshDiff,
    refreshFiles,
    checkBranchAndPr,
    requestMarkChatRead,
    refreshChats,
    session.cloneUrl,
    session.repoOwner,
    session.repoName,
    markAutoCommitStarted,
    userStopped,
  ]);

  const shouldRefreshRestoredWorkspaceRef = useRef(false);

  const isArchived = session.status === "archived";

  // After a snapshot restore, wait for the live workspace hooks to be active
  // again before forcing refreshes. Calling the pre-restore callbacks inside
  // the async restore handler can be a no-op because they were created while
  // the sandbox was still offline.
  useEffect(() => {
    if (!shouldRefreshRestoredWorkspaceRef.current) {
      return;
    }
    if (!sandboxInfo || reconnectionStatus !== "connected") {
      return;
    }

    shouldRefreshRestoredWorkspaceRef.current = false;
    void refreshWorkspaceAfterRestore();
  }, [sandboxInfo, reconnectionStatus, refreshWorkspaceAfterRestore]);

  // Attempt a single reconnect probe on entry to pick up authoritative server state
  // (connected sandbox, no sandbox, and snapshot availability).
  // Skip for archived sessions -- they should never spin up a sandbox.
  useEffect(() => {
    if (isArchived) return;
    if (
      !sandboxInfo &&
      !isCreatingSandbox &&
      !isResumingWorkspace &&
      reconnectionStatus === "idle"
    ) {
      void attemptReconnection();
    }
  }, [
    isArchived,
    sandboxInfo,
    isCreatingSandbox,
    isResumingWorkspace,
    reconnectionStatus,
    attemptReconnection,
  ]);

  // Server-authoritative lifecycle state: lightweight status poll every 15s.
  useEffect(() => {
    if (isCreatingSandbox || isResumingWorkspace) return;

    const poll = () => {
      if (reconnectionStatus === "checking") return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void requestStatusSync("normal");
    };

    poll();
    const interval = setInterval(poll, 15_000);
    return () => clearInterval(interval);
  }, [
    isCreatingSandbox,
    isResumingWorkspace,
    reconnectionStatus,
    requestStatusSync,
  ]);

  // Track tool completions to trigger diff refresh
  const prevToolStatesRef = useRef<Map<string, string>>(new Map());
  const hasInitializedToolStatesRef = useRef(false);

  // Extract current tool states from messages
  const currentToolStates = useMemo(() => {
    const states = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (isToolUIPart(part)) {
          states.set(part.toolCallId, part.state);
        }
      }
    }
    return states;
  }, [messages]);

  useEffect(() => {
    if (!hasInitializedToolStatesRef.current) {
      prevToolStatesRef.current = currentToolStates;
      hasInitializedToolStatesRef.current = true;
      return;
    }

    let hasFileChange = false;
    const fileModifyingTools = ["tool-write", "tool-edit"];

    for (const message of messages) {
      if (message.role !== "assistant") continue;

      for (const part of message.parts) {
        if (!isToolUIPart(part)) continue;

        const toolId = part.toolCallId;
        const toolState = part.state;
        const prevState = prevToolStatesRef.current.get(toolId);
        const isFileModifyingTool = fileModifyingTools.includes(part.type);
        const justCompleted =
          toolState === "output-available" && prevState !== "output-available";

        if (isFileModifyingTool && justCompleted) {
          hasFileChange = true;
        }
      }
    }

    prevToolStatesRef.current = currentToolStates;

    if (hasFileChange) {
      // Refresh diff and files when files change.
      // Fire-and-forget with error handling - SWR updates error state internally,
      // but we catch here to prevent unhandled rejection warnings.
      refreshDiff().catch(() => {});
      refreshGitStatus().catch(() => {});
      refreshFiles().catch(() => {});
    }
  }, [
    currentToolStates,
    messages,
    refreshDiff,
    refreshGitStatus,
    refreshFiles,
  ]);

  // Note: SWR handles automatic fetching when sandbox becomes available
  // and caching/deduplication of requests

  const tokenUsage = useMemo(
    () => getLatestContextUsage(renderMessages),
    [renderMessages],
  );
  const conversationUsage = useMemo(
    () => getConversationUsage(renderMessages),
    [renderMessages],
  );
  const conversationCost = useMemo(
    () => getConversationCost(renderMessages, selectedModelOption?.cost),
    [renderMessages, selectedModelOption?.cost],
  );

  // Detect pending AskUserQuestion tool calls
  const { hasPendingQuestion, pendingQuestionPart, questionToolCallId } =
    useMemo(() => {
      const lastMessage = renderMessages[renderMessages.length - 1];
      if (lastMessage?.role === "assistant") {
        for (const p of lastMessage.parts) {
          if (
            isToolUIPart(p) &&
            p.type === "tool-ask_user_question" &&
            p.state === "input-available"
          ) {
            return {
              hasPendingQuestion: true,
              pendingQuestionPart: p as {
                type: "tool-ask_user_question";
                toolCallId: string;
                input: AskUserQuestionInput;
              },
              questionToolCallId: p.toolCallId,
            };
          }
        }
      }
      return {
        hasPendingQuestion: false,
        pendingQuestionPart: null,
        questionToolCallId: null,
      };
    }, [renderMessages]);

  // Handle question submission
  const handleQuestionSubmit = useCallback(
    (answers: Record<string, string | string[]>) => {
      if (questionToolCallId) {
        addToolOutput({
          tool: "ask_user_question",
          toolCallId: questionToolCallId,
          output: { answers },
        });
      }
    },
    [questionToolCallId, addToolOutput],
  );

  // Handle question cancellation
  const handleQuestionCancel = useCallback(() => {
    if (questionToolCallId) {
      addToolOutput({
        tool: "ask_user_question",
        toolCallId: questionToolCallId,
        output: { declined: true },
      });
    }
  }, [questionToolCallId, addToolOutput]);

  // Stable empty array so the hook doesn't reset on every render when there's no question
  const emptyQuestions = useMemo(
    () => [] as AskUserQuestionInput["questions"],
    [],
  );

  const inlineQuestion = useInlineQuestion({
    questions:
      hasPendingQuestion && pendingQuestionPart
        ? pendingQuestionPart.input.questions
        : emptyQuestions,
    onSubmit: handleQuestionSubmit,
    onCancel: handleQuestionCancel,
    textareaValue: input,
    onTextareaChange: setInput,
  });

  // Inline question UI is integrated into the prompt box on all viewports
  const showInlineQuestion = inlineQuestion.isActive;

  const isReconnectingSandbox =
    reconnectionStatus === "checking" &&
    !sandboxInfo &&
    !isCreatingSandbox &&
    !isResumingWorkspace;
  const isHibernatingTransition =
    isReconnectingSandbox && hasPausedWorkspace && !hasRuntimeSandboxState;
  const isArchiveSnapshotPending = isArchived && hasRuntimeSandboxState;
  const isServerHibernating = lifecycleTiming.state === "hibernating";
  const isHibernatingUi = isHibernatingTransition || isServerHibernating;

  // Sandbox is active only when BOTH the local connection info is valid AND
  // the server agrees the lifecycle is active (not hibernating/hibernated/failed).
  const serverSaysActive =
    lifecycleTiming.state === null ||
    lifecycleTiming.state === "active" ||
    lifecycleTiming.state === "provisioning";
  const isSandboxActive = isSandboxValid(sandboxInfo) && serverSaysActive;

  /*
   * Whether a lifecycle transition is already under way.
   *
   * Shared by both flags below, because "the sandbox is halfway through
   * something" disqualifies every button either of them guards.
   */
  const isSandboxBusy =
    isCreatingSandbox ||
    isResumingWorkspace ||
    isReconnectingSandbox ||
    isHibernatingUi;

  const canRunDevServer = !isArchived && isSandboxActive && !isSandboxBusy;

  /*
   * Whether to *offer* Start / Stop, which is a weaker condition than
   * `canRunDevServer`.
   *
   * Requiring an already-active sandbox was circular: an idle workspace showed
   * "The workspace has to be running before your app can be previewed" and no
   * button to run it with — a dead end, and the only way out was to send the
   * agent a message. Starting the dev server calls `ensureSandboxReady` first,
   * so pressing Start on an idle workspace wakes it and then starts the app.
   *
   * Archived is still excluded: an archived session has no workspace to wake.
   */
  const canOfferDevServerControls = !isArchived && !isSandboxBusy;
  const ensureSandboxReadyForAction =
    useCallback(async (): Promise<boolean> => {
      if (isSandboxActive) {
        return true;
      }

      if (isArchived) {
        return false;
      }

      if (sandboxActionReadyPromiseRef.current) {
        return sandboxActionReadyPromiseRef.current;
      }

      const readyPromise = (async () => {
        if (isCreatingSandbox || isResumingWorkspace) {
          return waitForSandboxReady(12);
        }

        if (isReconnectingSandbox) {
          const readiness = await checkSandboxReadiness();
          if (readiness === "connected") {
            return true;
          }
          if (readiness === "failed") {
            return false;
          }
        }

        if (hasPausedWorkspace || hasRuntimeSandboxState || isHibernatingUi) {
          await handleResumeSandbox();
        } else {
          await handleCreateNewSandbox();
        }

        return waitForSandboxReady(12);
      })();

      sandboxActionReadyPromiseRef.current = readyPromise;
      try {
        return await readyPromise;
      } finally {
        sandboxActionReadyPromiseRef.current = null;
      }
    }, [
      handleCreateNewSandbox,
      handleResumeSandbox,
      checkSandboxReadiness,
      hasRuntimeSandboxState,
      hasPausedWorkspace,
      isArchived,
      isCreatingSandbox,
      isHibernatingUi,
      isReconnectingSandbox,
      isResumingWorkspace,
      isSandboxActive,
      waitForSandboxReady,
    ]);
  const devServer = useDevServer({
    sessionId: session.id,
    chatId: chatInfo.id,
    canRun: canRunDevServer,
    ensureSandboxReady: ensureSandboxReadyForAction,
  });

  /*
   * Refs are not reactive, so a portal gated on `ref.current` would never
   * render: the first pass sees null and nothing re-renders to notice it was
   * filled in. Refs are attached during commit and effects run child-first, so
   * by the time this fires the layout shell's nodes exist.
   */
  const [portalTargetsReady, setPortalTargetsReady] = useState(false);
  useEffect(() => {
    setPortalTargetsReady(true);
  }, []);

  const hasRepo = Boolean(session.cloneUrl);
  const hasExistingPr = session.prNumber != null;
  const previewLookupBranch =
    gitStatus?.branch && gitStatus.branch !== "HEAD"
      ? gitStatus.branch
      : session.branch;
  const hasBranchPreviewLookup = Boolean(previewLookupBranch);
  const existingPrUrl =
    hasExistingPr && session.repoOwner && session.repoName
      ? `https://github.com/${session.repoOwner}/${session.repoName}/pull/${session.prNumber}`
      : null;
  const prDeploymentQuery = new URLSearchParams(
    Object.entries({
      ...(hasExistingPr ? { prNumber: String(session.prNumber) } : {}),
      ...(previewLookupBranch ? { branch: previewLookupBranch } : {}),
    }),
  ).toString();
  const { data: prDeploymentData, mutate: refreshPrDeployment } =
    useSWR<PrDeploymentResponse>(
      hasExistingPr || hasBranchPreviewLookup
        ? `/api/sessions/${session.id}/pr-deployment${
            prDeploymentQuery ? `?${prDeploymentQuery}` : ""
          }`
        : null,
      async () =>
        getDeploymentUrl({
          sessionId: session.id,
          ...(hasExistingPr && session.prNumber
            ? { prNumber: session.prNumber }
            : {}),
          ...(previewLookupBranch ? { branch: previewLookupBranch } : {}),
        }),
      {
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        // Poll while we're still waiting for the first deployment, or while a
        // branch preview is rolling forward to a newer deployment after a push.
        refreshInterval: (latestData) =>
          getPrDeploymentRefreshInterval({
            shouldPoll: hasExistingPr || hasBranchPreviewLookup,
            deploymentUrl: latestData?.deploymentUrl,
            documentHasFocus:
              typeof document === "undefined" ? true : document.hasFocus(),
            waitForDeploymentUrlChangeFrom: branchPreviewUrlChangeBaseline,
          }),
        shouldRetryOnError: false,
      },
    );
  const prDeploymentUrl = prDeploymentData?.deploymentUrl ?? null;
  const buildingDeploymentUrl = prDeploymentData?.buildingDeploymentUrl ?? null;
  const failedDeploymentUrl = prDeploymentData?.failedDeploymentUrl ?? null;

  useEffect(() => {
    if (!hasExistingPr && !hasBranchPreviewLookup) {
      if (branchPreviewUrlChangeBaseline !== undefined) {
        setBranchPreviewUrlChangeBaseline(undefined);
      }
      return;
    }

    if (branchPreviewUrlChangeBaseline === undefined) {
      return;
    }

    if (prDeploymentUrl !== branchPreviewUrlChangeBaseline) {
      setBranchPreviewUrlChangeBaseline(undefined);
    }
  }, [
    hasExistingPr,
    hasBranchPreviewLookup,
    branchPreviewUrlChangeBaseline,
    prDeploymentUrl,
  ]);

  const isDeploymentStale = branchPreviewUrlChangeBaseline !== undefined;
  const isDeploymentFailed =
    !prDeploymentUrl &&
    !buildingDeploymentUrl &&
    !hasExistingPr &&
    Boolean(failedDeploymentUrl);

  /*
   * The deployment state as words, not only as a colour.
   *
   * The icon carried the whole message in `text-error` / `text-success`, and
   * the label said "(building)" or nothing — so "failed" and "working" read
   * identically to a screen reader and to anyone who cannot separate red from
   * green. One string now drives the label and the tooltip together.
   */
  const deploymentStatusLabel = isDeploymentFailed
    ? "Open latest preview — the last build failed"
    : isDeploymentStale
      ? "Open latest preview — a new build is running"
      : "Open latest preview — up to date";
  const previewDeploymentTargetUrl =
    (isDeploymentStale ? buildingDeploymentUrl : null) ??
    prDeploymentUrl ??
    (isDeploymentFailed ? failedDeploymentUrl : null);
  const showHeaderActions = Boolean(previewDeploymentTargetUrl);

  // When auto-commit lands (transitions from committing to clean), mark the
  // current preview deployment as stale so the UI shows "Deploying…" until
  // the new deployment reports success.
  const prevIsAutoCommittingRef = useRef(isAutoCommitting);
  useEffect(() => {
    const wasAutoCommitting = prevIsAutoCommittingRef.current;
    prevIsAutoCommittingRef.current = isAutoCommitting;

    if (
      wasAutoCommitting &&
      !isAutoCommitting &&
      (hasExistingPr || hasBranchPreviewLookup)
    ) {
      setBranchPreviewUrlChangeBaseline(prDeploymentUrl);
      refreshPrDeployment().catch(() => undefined);
    }
  }, [
    isAutoCommitting,
    hasExistingPr,
    hasBranchPreviewLookup,
    prDeploymentUrl,
    refreshPrDeployment,
  ]);

  const hasUncommittedGitChanges = gitStatus?.hasUncommittedChanges ?? false;
  const hasUnpushedCommits = gitStatus?.hasUnpushedCommits ?? false;
  const showCommitAction =
    hasRepo &&
    (hasUncommittedGitChanges || (hasExistingPr && hasUnpushedCommits));

  // Sync the "action needed" indicator for the right sidebar toggle button
  useEffect(() => {
    setHasActionNeeded(showCommitAction);
  }, [showCommitAction, setHasActionNeeded]);

  // Sync the file change count for the badge on the toggle button
  const totalChangesCount = diff?.files?.length ?? 0;
  useEffect(() => {
    setChangesCount(totalChangesCount);
  }, [totalChangesCount, setChangesCount]);

  // Sync the "committed changes" indicator (blue dot) — branch has committed
  // changes, no PR created yet, and no uncommitted changes to deal with
  useEffect(() => {
    setHasCommittedChanges(
      hasRepo &&
        totalChangesCount > 0 &&
        !hasExistingPr &&
        !hasUncommittedGitChanges,
    );
  }, [
    hasRepo,
    totalChangesCount,
    hasExistingPr,
    hasUncommittedGitChanges,
    setHasCommittedChanges,
  ]);
  const hasOpenPr = hasExistingPr && session.prStatus === "open";
  const canCloseAndArchive = hasOpenPr && !isArchived;
  const handleCommitted = useCallback(async () => {
    if (hasExistingPr || hasBranchPreviewLookup) {
      setBranchPreviewUrlChangeBaseline(prDeploymentUrl);
    }

    await Promise.all([
      refreshGitStatus().catch(() => undefined),
      refreshDiff().catch(() => undefined),
      refreshFiles().catch(() => undefined),
      checkBranchAndPr().catch(() => undefined),
    ]);

    if (hasExistingPr || hasBranchPreviewLookup) {
      await refreshPrDeployment().catch(() => undefined);
    }
  }, [
    hasExistingPr,
    hasBranchPreviewLookup,
    prDeploymentUrl,
    refreshGitStatus,
    refreshDiff,
    refreshFiles,
    checkBranchAndPr,
    refreshPrDeployment,
  ]);

  const handleMerged = useCallback(
    async (mergeResult: MergePullRequestResult) => {
      updateSessionPullRequest({
        prNumber: mergeResult.prNumber,
        prStatus: "merged",
      });

      if (mergeResult.branchDeleteError) {
        console.warn(
          "PR merged but source branch was not deleted:",
          mergeResult.branchDeleteError,
        );
      }

      try {
        await archiveSession();
        router.push("/sessions");
      } catch (archiveError) {
        const archiveMessage =
          archiveError instanceof Error
            ? archiveError.message
            : "Failed to archive session";
        throw new Error(
          `Pull request merged, but archiving the session failed: ${archiveMessage}`,
          {
            cause: archiveError,
          },
        );
      }
    },
    [archiveSession, router, updateSessionPullRequest],
  );

  const handleClosed = useCallback(
    async (closeResult: { closed: boolean; prNumber: number }) => {
      updateSessionPullRequest({
        prNumber: closeResult.prNumber,
        prStatus: "closed",
      });

      try {
        await archiveSession();
        router.push("/sessions");
      } catch (archiveError) {
        const archiveMessage =
          archiveError instanceof Error
            ? archiveError.message
            : "Failed to archive session";
        throw new Error(
          `Pull request closed, but archiving the session failed: ${archiveMessage}`,
          {
            cause: archiveError,
          },
        );
      }
    },
    [archiveSession, router, updateSessionPullRequest],
  );

  /*
   * Always rendered, because the Changes tab is where it belongs.
   *
   * It used to be conditional on a header toggle, which meant the tab could
   * show a diff with no way to commit it while the toggle appeared to do
   * nothing — it was rendering the panel into the hidden half of a tab.
   */
  const gitPanelElement = (
    <GitPanel
      session={session}
      hasRepo={hasRepo}
      hasExistingPr={hasExistingPr}
      existingPrUrl={existingPrUrl}
      hasUncommittedGitChanges={hasUncommittedGitChanges}
      canCloseAndArchive={canCloseAndArchive}
      diffFiles={diff?.files ?? null}
      onCreateRepoClick={() => setRepoDialogOpen(true)}
      refreshDiff={refreshDiff}
      onMerged={handleMerged}
      onCloseAndArchiveClick={() => setCloseDialogOpen(true)}
      onFixChecks={handleFixChecks}
      onFixConflicts={(baseBranchRef) => handleFixConflicts(baseBranchRef)}
      hasSandbox={sandboxInfo !== null}
      gitStatus={gitStatus}
      refreshGitStatus={refreshGitStatus}
      onCommitted={handleCommitted}
      isAgentWorking={hasPendingResponse || isChatInFlight}
      onPrDetected={(pr) => {
        updateSessionPullRequest(pr);
        void refreshGitStatus().catch(() => {});
      }}
      onGitMessage={upsertSyntheticAssistantGitMessage}
    />
  );

  return (
    <>
      {/*
        The workspace pane, portaled into the split the layout shell owns.

        Rendered here because the dev-server and editor URLs come from hooks
        that need this chat's id; placed there because the shell owns the
        split. The portal is the seam between the two.
      */}
      {portalTargetsReady &&
        workspacePortalRef.current &&
        createPortal(
          <WorkspacePanel
            canRunSandboxActions={canOfferDevServerControls}
            chatId={chatInfo.id}
            devServerError={
              devServer.state.status === "error"
                ? devServer.state.message
                : null
            }
            // Separate from the message on purpose: the panel renders it as a
            // monospace block, not as another sentence.
            devServerOutput={
              devServer.state.status === "error"
                ? (devServer.state.lastOutput ?? null)
                : null
            }
            devServerStarting={devServer.state.status === "starting"}
            devServerStopping={devServer.state.status === "stopping"}
            devServerUrl={
              devServer.state.status === "ready"
                ? devServer.state.info.url
                : null
            }
            onStartDevServer={devServer.handlePrimaryAction}
            onStopDevServer={devServer.handleStopAction}
          />,
          workspacePortalRef.current,
        )}

      {/* The commit / PR panels live inside the pane's Changes tab. */}
      {portalTargetsReady &&
        panelPortalRef.current &&
        createPortal(gitPanelElement, panelPortalRef.current)}

      {/* Header actions portaled from chat-level state */}
      {headerActionsRef.current &&
        showHeaderActions &&
        createPortal(
          <div className="flex items-center gap-1">
            {/*
              Starting and stopping the app moved to the Preview tab's toolbar,
              beside Reload and "open in a new tab" — the buttons now sit next
              to the thing they act on. What is left here is the deployed
              preview on GitHub, which is not a pane of this app at all.
            */}
            {previewDeploymentTargetUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="hidden h-7 w-7 sm:inline-flex"
                  >
                    <a
                      href={previewDeploymentTargetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={deploymentStatusLabel}
                    >
                      <Globe
                        className={cn(
                          "h-3.5 w-3.5",
                          isDeploymentFailed && "text-error",
                          !isDeploymentFailed &&
                            !isDeploymentStale &&
                            "text-success",
                          !isDeploymentFailed &&
                            isDeploymentStale &&
                            "animate-pulse text-warning",
                        )}
                      />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {deploymentStatusLabel}
                </TooltipContent>
              </Tooltip>
            )}
          </div>,
          headerActionsRef.current,
        )}
      <div className="flex h-full flex-col overflow-hidden">
        {/* Share dialog (triggered from header) */}

        {/* Archive confirmation dialog */}
        <Dialog
          open={mobileArchiveDialogOpen}
          onOpenChange={setMobileArchiveDialogOpen}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Archive session?</DialogTitle>
              <DialogDescription>
                This will stop the sandbox and archive the session. You can
                still view it in the archive tab.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button
                  onClick={() => {
                    void archiveSession().catch((error: unknown) => {
                      console.error("Failed to archive session:", error);
                    });
                    router.push("/sessions");
                  }}
                >
                  Archive
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Main content: chat, diff, or file */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {activeView === "diff" ? (
            <DiffTabView />
          ) : activeView === "file" ? (
            <FileTabView />
          ) : (
            <>
              {/* Transient error banner (e.g. iOS "Load failed" after sleep) */}
              {error && (
                <div className="flex items-center justify-between gap-3 border-b border-error/20 bg-error/10 px-4 py-2 text-sm text-error">
                  <p className="min-w-0 truncate">{error.message}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5 border-error/30 text-error hover:bg-error/10"
                    onClick={() => retryChatStream()}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </Button>
                </div>
              )}

              {/* Messages */}
              <div className="relative flex-1 overflow-hidden">
                <div ref={containerRef} className="h-full overflow-y-auto">
                  <div className="mx-auto max-w-4xl overflow-hidden px-4 py-8">
                    <OpenFileProvider
                      onOpenFile={(fp) => setSelectedWorkspaceFile(fp)}
                    >
                      <div className="space-y-6">
                        {groupedRenderMessages.length === 0 &&
                          !hasPendingResponse && (
                            <div className="flex h-full min-h-[40vh] items-center justify-center">
                              <p className="text-sm text-base-content/60">
                                Send a message to get started
                              </p>
                            </div>
                          )}
                        {groupedRenderMessages.map(
                          ({
                            message: m,
                            groups,
                            isStreaming: isMessageStreaming,
                          }) => {
                            const renderGroups = (
                              isToolCallsExpanded: boolean,
                            ) =>
                              groups.map((group) => {
                                if (group.type === "reasoning-group") {
                                  if (!isToolCallsExpanded) return null;
                                  const hasRenderableContentAfterGroup = m.parts
                                    .slice(
                                      group.startIndex + group.parts.length,
                                    )
                                    .some(hasRenderableAssistantPart);

                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className="max-w-full pl-[22px]"
                                    >
                                      <ThinkingBlock
                                        text={getReasoningGroupText(
                                          group.parts,
                                        )}
                                        isStreaming={shouldKeepCollapsedReasoningStreaming(
                                          {
                                            isMessageStreaming,
                                            hasStreamingReasoningPart:
                                              group.parts.some(
                                                (part) =>
                                                  part.state === "streaming",
                                              ),
                                            hasRenderableContentAfterGroup,
                                          },
                                        )}
                                        partCount={group.parts.length}
                                      />
                                    </div>
                                  );
                                }

                                const p = group.part;

                                if (isReasoningUIPart(p)) {
                                  if (!isToolCallsExpanded) return null;
                                  const hasRenderableContentAfterGroup = m.parts
                                    .slice(group.index + 1)
                                    .some(hasRenderableAssistantPart);

                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className="max-w-full pl-[22px]"
                                    >
                                      <ThinkingBlock
                                        text={p.text}
                                        isStreaming={shouldKeepCollapsedReasoningStreaming(
                                          {
                                            isMessageStreaming,
                                            hasStreamingReasoningPart:
                                              p.state === "streaming",
                                            hasRenderableContentAfterGroup,
                                          },
                                        )}
                                      />
                                    </div>
                                  );
                                }

                                if (p.type === "text") {
                                  if (p.text.length === 0) {
                                    return null;
                                  }

                                  const isFinalAssistantTextPart =
                                    m.role === "assistant" &&
                                    !m.parts
                                      .slice(group.index + 1)
                                      .some(
                                        (messagePart) =>
                                          messagePart.type === "text",
                                      );

                                  // When collapsed, hide every text part except the
                                  // final one.  The final text part streams in live so
                                  // the user always sees the latest assistant prose.
                                  if (
                                    !isToolCallsExpanded &&
                                    m.role === "assistant" &&
                                    !isFinalAssistantTextPart
                                  ) {
                                    return null;
                                  }

                                  const canCopyAssistantMessage =
                                    isFinalAssistantTextPart &&
                                    !isMessageStreaming &&
                                    p.text.trim().length > 0;

                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className={cn(
                                        "flex min-w-0 py-2",
                                        m.role === "user"
                                          ? "justify-end"
                                          : "justify-start",
                                        // Breathing room above final assistant text after tool calls
                                        isFinalAssistantTextPart &&
                                          group.index > 0 &&
                                          "mt-4",
                                        // Indent non-final text parts (they're collapsible content)
                                        m.role === "assistant" &&
                                          !isFinalAssistantTextPart &&
                                          "pl-[22px]",
                                      )}
                                    >
                                      {m.role === "user" ? (
                                        <div className="group flex w-fit min-w-0 max-w-[85%] flex-col items-end gap-1">
                                          <div className="rounded-3xl bg-base-200 px-4 py-2">
                                            <p className="whitespace-pre-wrap break-words">
                                              {p.text}
                                            </p>
                                          </div>
                                          {group.index === 0 &&
                                            m.metadata?.postedBy?.kind ===
                                              "plugin" && (
                                              <PluginPostedBadge
                                                pluginId={
                                                  m.metadata.postedBy.pluginId
                                                }
                                              />
                                            )}
                                          {group.index === 0 && (
                                            <MessageActions
                                              actions={[
                                                {
                                                  busy:
                                                    resendingMessageId === m.id,
                                                  disabled:
                                                    hasMessageActionInFlight,
                                                  hint: "Removes the replies after it and asks again",
                                                  icon: (
                                                    <RotateCcw
                                                      aria-hidden="true"
                                                      className="size-4"
                                                    />
                                                  ),
                                                  label: "Send this again",
                                                  handleSelect: () =>
                                                    void handleResendUserMessage(
                                                      m.id,
                                                    ),
                                                },
                                                {
                                                  busy:
                                                    deletingMessageId === m.id,
                                                  destructive: true,
                                                  disabled:
                                                    hasMessageActionInFlight,
                                                  hint: "Also removes everything after it",
                                                  icon: (
                                                    <Trash2
                                                      aria-hidden="true"
                                                      className="size-4"
                                                    />
                                                  ),
                                                  label: "Delete this message",
                                                  handleSelect: () =>
                                                    void handleDeleteUserMessage(
                                                      m.id,
                                                    ),
                                                },
                                              ]}
                                              align="end"
                                            />
                                          )}
                                        </div>
                                      ) : (
                                        <div className="group min-w-0 w-full overflow-hidden wrap-anywhere">
                                          <Streamdown
                                            animated={
                                              isMessageStreaming
                                                ? {
                                                    animation: "fadeIn",
                                                    duration: 250,
                                                    easing: "ease-out",
                                                  }
                                                : undefined
                                            }
                                            mode={
                                              isMessageStreaming
                                                ? "streaming"
                                                : "static"
                                            }
                                            isAnimating={isMessageStreaming}
                                            components={streamdownComponents}
                                            plugins={streamdownPlugins}
                                          >
                                            {p.text}
                                          </Streamdown>
                                          {canCopyAssistantMessage ||
                                          (!isMessageStreaming &&
                                            isFinalAssistantTextPart &&
                                            m.metadata) ? (
                                            <MessageActions
                                              actions={[
                                                {
                                                  busy:
                                                    forkingAssistantMessageId ===
                                                    m.id,
                                                  disabled:
                                                    !canCopyAssistantMessage ||
                                                    forkingAssistantMessageId !==
                                                      null,
                                                  hint: "Keeps this answer and carries on separately",
                                                  icon: (
                                                    <GitBranch
                                                      aria-hidden="true"
                                                      className="size-4"
                                                    />
                                                  ),
                                                  label:
                                                    "Start a new chat from here",
                                                  handleSelect: () =>
                                                    void handleForkAssistantMessage(
                                                      m.id,
                                                    ),
                                                },
                                              ]}
                                              className="mt-1"
                                              copied={
                                                copiedAssistantMessageId ===
                                                m.id
                                              }
                                              copyLabel="Copy this answer"
                                              {...(canCopyAssistantMessage
                                                ? {
                                                    onCopy: () =>
                                                      void handleCopyAssistantMessage(
                                                        m.id,
                                                        p.text,
                                                      ),
                                                  }
                                                : {})}
                                              trailing={
                                                !isMessageStreaming &&
                                                isFinalAssistantTextPart &&
                                                m.metadata ? (
                                                  <MessageModelPill
                                                    metadata={m.metadata}
                                                    modelOptions={modelOptions}
                                                  />
                                                ) : null
                                              }
                                            />
                                          ) : null}
                                        </div>
                                      )}
                                    </div>
                                  );
                                }

                                if (isToolUIPart(p)) {
                                  if (!isToolCallsExpanded) return null;
                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className="max-w-full pl-[22px]"
                                    >
                                      <ToolCall
                                        part={p as WebAgentUIToolPart}
                                        isStreaming={isMessageStreaming}
                                        pluginRenderers={pluginRenderers}
                                        onApprove={(id) =>
                                          addToolApprovalResponse({
                                            id,
                                            approved: true,
                                          })
                                        }
                                        onDeny={(id, reason) =>
                                          addToolApprovalResponse({
                                            id,
                                            approved: false,
                                            reason,
                                          })
                                        }
                                      />
                                    </div>
                                  );
                                }

                                if (isGitDataPart(p)) {
                                  if (!shouldRenderGitDataPart(p)) {
                                    return null;
                                  }

                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className="max-w-full"
                                    >
                                      <GitDataPartCard part={p} />
                                    </div>
                                  );
                                }

                                // Render image attachments
                                if (
                                  p.type === "file" &&
                                  p.mediaType?.startsWith("image/")
                                ) {
                                  if (
                                    !isToolCallsExpanded &&
                                    m.role === "assistant"
                                  ) {
                                    return null;
                                  }
                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className="flex justify-end"
                                    >
                                      <div className="group relative w-fit max-w-[80%]">
                                        {/*
                                          The height is capped and the width
                                          follows the image, so the row it sits
                                          in has no size until the bytes
                                          arrive: the conversation jumped every
                                          time one decoded. `aspect-auto` plus
                                          a minimum keeps a place for it, and
                                          `object-contain` means a very wide or
                                          very tall attachment is fitted rather
                                          than cropped — it is the user's own
                                          screenshot, so nothing in it is safe
                                          to cut off.
                                        */}
                                        {/* eslint-disable-next-line @next/next/no-img-element -- Data URLs not supported by next/image */}
                                        <img
                                          alt={p.filename ?? "Attached image"}
                                          className="min-h-16 max-h-64 w-auto rounded-lg object-contain"
                                          src={p.url}
                                        />
                                        {m.role === "user" &&
                                          group.index === 0 && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void handleDeleteUserMessage(
                                                  m.id,
                                                )
                                              }
                                              disabled={
                                                hasMessageActionInFlight
                                              }
                                              aria-label="Delete this message and everything after it"
                                              className="absolute -left-10 top-1/2 -translate-y-1/2 rounded p-1 text-base-content/60 opacity-0 transition hover:text-error group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                              {deletingMessageId === m.id ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                              ) : (
                                                <Trash2 className="h-4 w-4" />
                                              )}
                                            </button>
                                          )}
                                      </div>
                                    </div>
                                  );
                                }

                                if (p.type === "data-snippet") {
                                  if (
                                    !isToolCallsExpanded &&
                                    m.role === "assistant"
                                  ) {
                                    return null;
                                  }
                                  return (
                                    <div
                                      key={`${m.id}-${group.renderKey}`}
                                      className={cn(
                                        "flex",
                                        m.role === "user"
                                          ? "justify-end"
                                          : "justify-start",
                                      )}
                                    >
                                      <div className="group relative w-fit max-w-[80%]">
                                        <SnippetChip
                                          filename={p.data.filename}
                                          content={p.data.content}
                                        />
                                        {m.role === "user" &&
                                          group.index === 0 && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void handleDeleteUserMessage(
                                                  m.id,
                                                )
                                              }
                                              disabled={
                                                hasMessageActionInFlight
                                              }
                                              aria-label="Delete this message and everything after it"
                                              className="absolute -left-10 top-1/2 -translate-y-1/2 rounded p-1 text-base-content/60 opacity-0 transition hover:text-error group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                              {deletingMessageId === m.id ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                              ) : (
                                                <Trash2 className="h-4 w-4" />
                                              )}
                                            </button>
                                          )}
                                      </div>
                                    </div>
                                  );
                                }

                                return null;
                              });

                            if (m.role === "assistant") {
                              return (
                                <AssistantMessageGroups
                                  key={m.id}
                                  message={m}
                                  isStreaming={isMessageStreaming}
                                  durationMs={messageDurationMap[m.id] ?? null}
                                  isReverting={revertingMessageId === m.id}
                                  onRevert={(checkpointSha) => {
                                    void handleRevertTurn(m.id, checkpointSha);
                                  }}
                                  startedAt={
                                    messageStartedAtMap[m.id] ??
                                    (isMessageStreaming
                                      ? lastSendTimestampRef.current
                                        ? new Date(
                                            lastSendTimestampRef.current,
                                          ).toISOString()
                                        : lastUserMessageSentAt
                                      : null)
                                  }
                                >
                                  {renderGroups}
                                </AssistantMessageGroups>
                              );
                            }

                            return (
                              <div key={m.id} className="flex flex-col gap-1">
                                {renderGroups(true)}
                              </div>
                            );
                          },
                        )}
                        {showThinkingIndicator && (
                          <div className="my-1.5 border border-transparent py-0.5">
                            <div className="inline-flex items-center gap-2 rounded-md py-px text-sm text-base-content/60">
                              <span className="flex size-3.5 shrink-0 items-center justify-center">
                                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-base-content/60" />
                              </span>
                              <span className="leading-none">
                                {workspaceStatus?.message ?? "Thinking…"}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </OpenFileProvider>
                  </div>
                </div>
                {!isAtBottom && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-base-200 text-base-content hover:bg-base-200"
                    onClick={scrollToBottom}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                )}
              </div>

              {/* Input */}
              <div className="p-4 pb-2 sm:pb-8">
                {/*
                  Above the composer and outside its column: the candidates
                  are wider than a message, and the whole point of the panel
                  is comparing them side by side.
                */}
                {design.panelProps ? (
                  <DesignPanel {...design.panelProps} />
                ) : null}
                <div className="mx-auto max-w-4xl space-y-2">
                  {/*
                    Above the composer, not in the transcript: the agent is
                    stopped until this is answered, so it has to be where the
                    user is already looking.
                  */}
                  {pendingApprovals.map((approval) => (
                    <ApprovalRequestCard
                      approval={approval}
                      key={approval.id}
                      onDecide={decideApprovalRequest}
                    />
                  ))}
                  {sandboxCreateError && (
                    <SandboxCreateErrorBanner
                      error={sandboxCreateError}
                      onDismiss={() => setSandboxCreateError(null)}
                    />
                  )}
                  {restoreError && (
                    <div className="flex items-center justify-between rounded-md bg-error/10 px-3 py-2 text-sm text-error">
                      <span>{restoreError}</span>
                      <button
                        type="button"
                        onClick={() => setRestoreError(null)}
                        className="ml-2 rounded p-0.5 hover:bg-error/20"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {deleteMessageError && (
                    <div className="flex items-center justify-between rounded-md bg-error/10 px-3 py-2 text-sm text-error">
                      <span>{deleteMessageError}</span>
                      <button
                        type="button"
                        onClick={() => setDeleteMessageError(null)}
                        className="ml-2 rounded p-0.5 hover:bg-error/20"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {/*
                    Hidden, but still a real control: it is what the paperclip
                    button opens, and a screen reader reaching it directly
                    otherwise finds an unnamed file field.
                  */}
                  <input
                    aria-label="Attach images to your message"
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT_IMAGE_TYPES}
                    multiple
                    onChange={(e) => {
                      const files = e.target.files;
                      if (files && files.length > 0) {
                        addImages(files);
                      }
                      e.target.value = "";
                    }}
                    className="hidden"
                  />
                  <div className="relative">
                    {showSuggestions && (
                      <FileSuggestionsDropdown
                        suggestions={suggestions}
                        selectedIndex={selectedIndex}
                        onSelect={(suggestion) => {
                          if (mentionInfo) {
                            handleFileSelect(
                              suggestion.value,
                              mentionInfo.mentionStart,
                              cursorPosition,
                            );
                          }
                        }}
                        isLoading={filesLoading}
                      />
                    )}
                    {showSlashCommands && !showSuggestions && (
                      <SlashCommandDropdown
                        suggestions={slashSuggestions}
                        selectedIndex={selectedSlashIndex}
                        onSelect={(suggestion) => {
                          if (slashInfo) {
                            handleSlashCommandSelect(
                              suggestion.name,
                              slashInfo.slashStart,
                              cursorPosition,
                            );
                          }
                        }}
                        isLoading={skillsLoading}
                      />
                    )}
                    {/* Pinned Todo Panel — sits above the input box */}
                    <PinnedTodoPanel todos={latestTodos} />
                    {/*
                      Archived workspaces get a notice, and a way out of the
                      archive. Above the composer rather than over it: the
                      composer clips its own children, and it is shorter than
                      this notice.
                    */}
                    {isArchived ? (
                      <ArchivedWorkspaceNotice
                        hasRuntimeSandboxState={isArchiveSnapshotPending}
                        onRestore={unarchiveSession}
                      />
                    ) : null}
                    {/* Input form */}
                    <div
                      className={cn(
                        "overflow-hidden rounded-2xl bg-base-200 transition-colors",
                        isDragging && "ring-2 ring-info/50",
                      )}
                    >
                      {/* onSubmit on a form is the standard submit path; the rule
                          treats <form> as non-interactive. */}
                      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          // When inline question is active, don't send a chat message
                          if (showInlineQuestion) return;
                          if (
                            isArchived ||
                            isChatInFlight ||
                            hasPendingResponse
                          ) {
                            return;
                          }
                          const hasContent =
                            input.trim() ||
                            images.length > 0 ||
                            textAttachments.length > 0;
                          if (!hasContent) return;

                          const messageText = input;
                          const files = getFileParts();

                          // Build the message payload. When text attachments are
                          // present we use the parts-based form so we can include
                          // data-snippet parts alongside text and file parts.
                          const hasSnippets = textAttachments.length > 0;
                          let messagePayload: Parameters<
                            typeof sendMessageWithPendingState
                          >[0];

                          if (hasSnippets) {
                            const parts: WebAgentUIMessage["parts"] = [];
                            if (messageText.trim()) {
                              parts.push({
                                type: "text" as const,
                                text: messageText,
                              });
                            }
                            if (files) {
                              for (const f of files) {
                                parts.push(f);
                              }
                            }
                            for (const attachment of textAttachments) {
                              parts.push({
                                type: "data-snippet" as const,
                                id: attachment.id,
                                data: {
                                  content: attachment.content,
                                  filename: attachment.filename,
                                },
                              });
                            }
                            messagePayload = { parts };
                          } else {
                            messagePayload = {
                              text: messageText,
                              files,
                            };
                          }

                          setInput("");
                          clearImages();
                          clearTextAttachments();

                          const isFirstChatInSession =
                            initialIsOnlyChatInSession;
                          const shouldSetOptimisticTitle =
                            isFirstChatInSession &&
                            !hadInitialMessages &&
                            messages.length === 0;
                          const trimmedText = messageText.trim();
                          const shouldGenerateSessionTitle =
                            shouldSetOptimisticTitle &&
                            trimmedText.length > 0 &&
                            !hasRequestedSessionTitleGenerationRef.current;
                          if (
                            shouldSetOptimisticTitle &&
                            trimmedText.length > 0
                          ) {
                            const nextTitle =
                              trimmedText.length > 80
                                ? `${trimmedText.slice(0, 80)}...`
                                : trimmedText;
                            pendingOptimisticTitleChatIdRef.current =
                              chatInfo.id;
                            void setChatTitle(chatInfo.id, nextTitle);

                            if (shouldGenerateSessionTitle) {
                              hasRequestedSessionTitleGenerationRef.current = true;
                              // Generate a title in parallel and persist it as soon as it
                              // resolves, without waiting for the assistant response.
                              const generatedTitlePromise = fetch(
                                "/api/generate-title",
                                {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    message: trimmedText,
                                  }),
                                },
                              )
                                .then(async (res) => {
                                  if (!res.ok) {
                                    return null;
                                  }

                                  const data = (await res
                                    .json()
                                    .catch(() => null)) as {
                                    title?: unknown;
                                  } | null;
                                  if (typeof data?.title !== "string") {
                                    return null;
                                  }

                                  const title = data.title.trim();
                                  return title.length > 0 ? title : null;
                                })
                                .catch(() => null);

                              void generatedTitlePromise
                                .then((generatedTitle) => {
                                  if (!generatedTitle) {
                                    return;
                                  }
                                  return updateSessionTitle(generatedTitle);
                                })
                                .catch(() => {
                                  // Ignore failures and keep the existing session title.
                                });
                            }
                          }
                          /*
                            Design mode is per message: the toggle arms the
                            next send and disarms itself once that send is
                            away, so the expensive N-candidate turn is always
                            a deliberate press rather than a mode the chat
                            sits in and forgets about.
                          */
                          const designSendBody = design.sendBody;
                          if (designSendBody) {
                            design.setDesignModeEnabled(false);
                          }

                          try {
                            await sendMessageWithPendingState(
                              messagePayload,
                              designSendBody
                                ? { body: designSendBody }
                                : undefined,
                            );
                          } catch (err) {
                            if (pendingOptimisticTitleChatIdRef.current) {
                              void clearChatTitle(
                                pendingOptimisticTitleChatIdRef.current,
                              );
                              pendingOptimisticTitleChatIdRef.current = null;
                            }
                            console.error("Failed to send message:", err);
                          }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setIsDragging(true);
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          // Only set isDragging to false if we're leaving the form entirely
                          // (not just moving to a child element)
                          if (
                            !e.currentTarget.contains(e.relatedTarget as Node)
                          ) {
                            setIsDragging(false);
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          setIsDragging(false);
                          const files = e.dataTransfer.files;
                          if (files.length > 0) {
                            addImages(files);
                          }
                        }}
                      >
                        {/* Attachments preview */}
                        {(images.length > 0 || textAttachments.length > 0) && (
                          <div className="flex min-w-0 flex-wrap items-start gap-2 px-2 pb-1 pt-2">
                            {images.length > 0 && (
                              <ImageAttachmentsPreview
                                images={images}
                                onRemove={removeImage}
                                className="p-0"
                              />
                            )}
                            {textAttachments.length > 0 && (
                              <TextAttachmentsPreview
                                attachments={textAttachments}
                                onRemove={removeTextAttachment}
                                className="p-0"
                              />
                            )}
                            {/*
                              Under the thumbnails, inside the same row, so it
                              reads as a caption on the images it is about —
                              and only when this chat's backend actually
                              cannot see them (`capabilities.images`, the same
                              capability-driven rule that hides the effort
                              control). It renders nothing otherwise.
                            */}
                            <UnviewableImageNotice
                              capabilities={chatCapabilities}
                              imageCount={images.length}
                            />
                          </div>
                        )}

                        {/* Inline question UI for mobile — rendered inside prompt box */}
                        {showInlineQuestion && inlineQuestion.questionHeaderUI}

                        {/* Textarea area */}
                        <div className="px-4 pb-2 pt-3">
                          <textarea
                            aria-label="Your message to the assistant"
                            ref={inputRef}
                            value={input}
                            placeholder={
                              showInlineQuestion
                                ? inlineQuestion.placeholder
                                : "Request changes or ask a question..."
                            }
                            rows={1}
                            onFocus={handleTextareaFocus}
                            onChange={(e) => {
                              setInput(e.currentTarget.value);
                              setCursorPosition(
                                e.currentTarget.selectionStart ?? 0,
                              );
                            }}
                            onKeyDown={(e) => {
                              // When inline question is active, Enter advances the question
                              if (
                                showInlineQuestion &&
                                e.key === "Enter" &&
                                !e.shiftKey
                              ) {
                                e.preventDefault();
                                inlineQuestion.handleNext();
                                return;
                              }
                              // Let suggestions handle keyboard events first
                              if (handleSuggestionsKeyDown(e)) {
                                return;
                              }
                              if (handleSlashKeyDown(e)) {
                                return;
                              }
                              // On iOS, Return should insert a newline (send via submit button)
                              if (
                                e.key === "Enter" &&
                                !e.shiftKey &&
                                !isIosDevice &&
                                !isChatInFlight &&
                                !hasPendingResponse
                              ) {
                                e.preventDefault();
                                if (!isArchived) {
                                  e.currentTarget.form?.requestSubmit();
                                }
                              }
                            }}
                            onKeyUp={(e) => {
                              setCursorPosition(
                                e.currentTarget.selectionStart ?? 0,
                              );
                            }}
                            onClick={(e) => {
                              setCursorPosition(
                                e.currentTarget.selectionStart ?? 0,
                              );
                            }}
                            onPaste={(e) => {
                              const items = e.clipboardData?.items;
                              if (items) {
                                for (const item of items) {
                                  if (isValidImageType(item.type)) {
                                    const file = item.getAsFile();
                                    if (file) {
                                      e.preventDefault();
                                      addImage(file).catch(() => {
                                        // Silently ignore paste errors - rare edge case
                                      });
                                      return;
                                    }
                                  }
                                }
                              }

                              // Handle large text pastes – convert to file attachment
                              const pastedText =
                                e.clipboardData?.getData("text/plain");
                              if (pastedText && isLargeText(pastedText)) {
                                e.preventDefault();
                                addTextAttachment(pastedText);
                              }
                            }}
                            disabled={isArchived}
                            className="w-full resize-none overflow-y-auto bg-transparent text-base-content placeholder:text-base-content/60 focus:outline-none"
                            style={{ minHeight: "24px" }}
                          />
                        </div>

                        {/* Bottom toolbar */}
                        <div className="@container flex items-center justify-between gap-2 px-3 pb-2">
                          <div className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={openFilePicker}
                              disabled={isArchived}
                              className="h-8 w-8 rounded-full text-base-content/60 hover:text-base-content"
                            >
                              <Paperclip className="h-4 w-4" />
                            </Button>
                            {/* Hidden rather than disabled where the browser has
                                no speech recognition (Firefox): a permanently
                                dead control invites the click that produces the
                                error. */}
                            {isDictationSupported && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                title={
                                  recordingState === "recording"
                                    ? "Stop dictation"
                                    : "Dictate a message"
                                }
                                aria-label={
                                  recordingState === "recording"
                                    ? "Stop dictation"
                                    : "Dictate a message"
                                }
                                onClick={handleMicClick}
                                disabled={
                                  isArchived || recordingState === "processing"
                                }
                                className={cn(
                                  "relative h-8 w-8 rounded-full",
                                  recordingState === "recording"
                                    ? "text-error"
                                    : "text-base-content/60 hover:text-base-content",
                                )}
                              >
                                {recordingState === "recording" && (
                                  <span className="absolute inset-0 animate-pulse rounded-full bg-error/30" />
                                )}
                                {recordingState === "processing" ? (
                                  <Loader2 className="h-5 w-5 animate-spin" />
                                ) : (
                                  <Mic className="h-5 w-5" />
                                )}
                              </Button>
                            )}
                            <DesignToggle
                              active={design.designModeEnabled}
                              disabled={isArchived || design.toggleDisabled}
                              onToggle={handleDesignToggle}
                            />
                            {chatInfo.modelId && (
                              /*
                               * Model, effort, and backend read as one
                               * setting, so they sit on one line — see
                               * `ModelEffortBackendControls`'s own doc. This
                               * wrapper exists only to dim the row while a
                               * turn is in flight, and without a flex here
                               * its children stacked vertically in a row
                               * with space to spare.
                               *
                               * The rule before it separates two kinds of
                               * control that had been sharing one undivided
                               * row: to its left, ways of putting something
                               * into the message; to its right, how the
                               * message will be answered. The microphone used
                               * to sit on the far right beside Send, which
                               * grouped it with submitting rather than with
                               * typing.
                               */
                              <ModelEffortBackendControls
                                backend={
                                  (chatInfo.backend ??
                                    "claude-code") as ChatBackendSelection
                                }
                                capabilities={chatCapabilities}
                                disabled={
                                  isChatInFlight ||
                                  isUpdatingModel ||
                                  modelOptionsLoading
                                }
                                effort={chatInfo.effort ?? null}
                                modelId={chatInfo.modelId}
                                modelOptions={modelOptions}
                                onBackendChange={(backend) => {
                                  void handleBackendChange(backend);
                                }}
                                onEffortChange={(effort) => {
                                  void handleEffortChange(effort);
                                }}
                                onModelChange={(modelId) => {
                                  void handleModelChange(modelId);
                                }}
                                onModelCloseAutoFocus={() => {
                                  window.requestAnimationFrame(() => {
                                    const textarea = inputRef.current;
                                    if (!textarea) {
                                      return;
                                    }

                                    textarea.focus();
                                    const nextCursorPosition = Math.min(
                                      cursorPosition,
                                      textarea.value.length,
                                    );
                                    textarea.setSelectionRange(
                                      nextCursorPosition,
                                      nextCursorPosition,
                                    );
                                  });
                                }}
                              />
                            )}
                            <ContextUsageIndicator
                              isCompacting={isCompacting}
                              {...(isChatInFlight
                                ? {}
                                : {
                                    onCompact: () => {
                                      void handleCompact();
                                    },
                                  })}
                              inputTokens={tokenUsage.inputTokens}
                              conversationInputTokens={
                                conversationUsage.inputTokens
                              }
                              conversationCachedInputTokens={
                                conversationUsage.cachedInputTokens
                              }
                              conversationOutputTokens={
                                conversationUsage.outputTokens
                              }
                              conversationCost={conversationCost}
                              contextLimit={
                                contextLimit ?? DEFAULT_CONTEXT_LIMIT
                              }
                            />
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {showInlineQuestion ? (
                              <Button
                                type="button"
                                size="sm"
                                onClick={(e) => {
                                  e.preventDefault();
                                  inlineQuestion.handleNext();
                                }}
                                disabled={!inlineQuestion.hasCurrentAnswer}
                                className="h-8 rounded-full bg-primary px-3 text-xs text-primary-content hover:bg-primary/90 disabled:opacity-30"
                              >
                                <Check className="h-3 w-3" />
                                <span className="sm:hidden">
                                  {inlineQuestion.compactButtonLabel}
                                </span>
                                <span className="hidden sm:inline">
                                  {inlineQuestion.buttonLabel}
                                </span>
                              </Button>
                            ) : isChatInFlight || hasPendingResponse ? (
                              <Button
                                type="button"
                                size="icon"
                                onClick={() => {
                                  stopChatStream();
                                  setHasPendingResponse(false);
                                  setUserStopped(true);
                                  void setChatStreaming(chatInfo.id, false);
                                }}
                                aria-label="Stop the agent"
                                className="h-8 w-8 rounded-full bg-error text-error-content hover:bg-error/90"
                                style={{ touchAction: "manipulation" }}
                              >
                                <Square className="h-3 w-3 fill-current" />
                              </Button>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      type="submit"
                                      size="icon"
                                      onTouchEnd={() => {
                                        // On iOS, tapping submit while the textarea is focused
                                        // causes the keyboard to briefly flash open then closed.
                                        // Blur the textarea immediately to prevent this.
                                        inputRef.current?.blur();
                                      }}
                                      disabled={
                                        isArchived ||
                                        isChatInFlight ||
                                        (!input.trim() &&
                                          images.length === 0 &&
                                          textAttachments.length === 0) ||
                                        isUpdatingModel
                                      }
                                      className="h-8 w-8 rounded-full bg-primary text-primary-content hover:bg-primary/90 disabled:opacity-30"
                                    >
                                      <ArrowUp className="h-4 w-4" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                      </form>
                    </div>

                    {/* Recording error message */}
                    {recordingError && (
                      <p className="mt-2 text-sm text-error">
                        {recordingError}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {destructiveConfirmDialog}

      {/* Merge PR Dialog */}
      {session && (
        <MergePrDialog
          open={mergeDialogOpen}
          onOpenChange={setMergeDialogOpen}
          session={session}
          onMerged={handleMerged}
          onViewDiff={() => setShowDiffPanel(true)}
          canViewDiff={Boolean(diff || session.cachedDiff)}
          isAgentWorking={hasPendingResponse || isChatInFlight}
          onFixChecks={async (failedRuns) => {
            setMergeDialogOpen(false);
            await handleFixChecks(failedRuns);
          }}
          onFixConflicts={(baseBranchRef) =>
            handleFixConflicts(baseBranchRef, true)
          }
        />
      )}

      {/* Close PR Dialog */}
      {session && (
        <ClosePrDialog
          open={closeDialogOpen}
          onOpenChange={setCloseDialogOpen}
          session={session}
          onClosed={handleClosed}
        />
      )}

      {/* Create Repo Dialog */}
      {session && (
        <CreateRepoDialog
          open={repoDialogOpen}
          onOpenChange={setRepoDialogOpen}
          session={session}
          hasSandbox={sandboxInfo !== null}
          onRepoCreated={(result) => {
            updateSessionRepo({
              cloneUrl: result.cloneUrl,
              repoOwner: result.owner,
              repoName: result.repoName,
              branch: result.branch,
            });
          }}
        />
      )}

      {/* Diff Viewer Modal */}
      <DiffViewer open={showDiffPanel} onOpenChange={setShowDiffPanel} />
      <WorkspaceFileViewer
        sessionId={session.id}
        filePath={selectedWorkspaceFile}
        open={selectedWorkspaceFile !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedWorkspaceFile(null);
          }
        }}
        onAddToPrompt={(filePath, selectedText, comment) => {
          // Build a single snippet with file ref, selected text, and the user's comment
          const parts = [`File: ${filePath}`, "```", selectedText, "```"];
          if (comment) {
            parts.push("", `> ${comment}`);
          }
          const basename = filePath.split("/").pop() ?? filePath;
          addTextAttachment(parts.join("\n"), `comment-on-${basename}`);
          // Focus the input after a brief delay (keep file viewer open)
          setTimeout(() => {
            inputRef.current?.focus();
          }, 100);
        }}
      />
    </>
  );
}
