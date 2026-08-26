"use client";

import { useParams, useRouter } from "next/navigation";
import { FileText, GitCompare, Pencil, Plus, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSessionLayout } from "@/app/sessions/[sessionId]/session-layout-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { EvalsTabLink } from "@/app/sessions/[sessionId]/evals/evals-tab-link";
import { ChatTabsWorkspaceNote } from "./chat-tabs-workspace-note";
import { useGitPanel } from "./git-panel-context";

type ChatTabsProps = {
  activeChatId: string;
};

export function ChatTabs({ activeChatId }: ChatTabsProps) {
  const router = useRouter();
  const params = useParams<{ sessionId?: string }>();
  const sessionId = params.sessionId ?? "";
  const { chats, createChat, switchChat, deleteChat, renameChat } =
    useSessionLayout();
  const {
    activeView,
    setActiveView,
    focusedDiffFile,
    setFocusedDiffFile,
    changesTabDismissed,
    setChangesTabDismissed,
    focusedFilePath,
    setFocusedFilePath,
    fileTabDismissed,
    setFileTabDismissed,
  } = useGitPanel();

  const isMobile = useIsMobile();

  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeChatTabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (container.scrollWidth <= container.clientWidth) return;

      if (e.deltaY !== 0) {
        e.preventDefault();
        container.scrollLeft += e.deltaY;
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    activeChatTabRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeChatId, activeView, chats.length]);

  const prefetchedChatHrefsRef = useRef(new Set<string>());

  const prefetchChat = useCallback(
    (chatId: string) => {
      if (!sessionId) {
        return;
      }

      const href = `/sessions/${sessionId}/chats/${chatId}`;
      if (prefetchedChatHrefsRef.current.has(href)) {
        return;
      }

      prefetchedChatHrefsRef.current.add(href);
      router.prefetch(href);
    },
    [router, sessionId],
  );

  const [changesTabIndex, setChangesTabIndex] = useState<number | null>(null);
  useEffect(() => {
    const isChangesVisible = !changesTabDismissed && !!focusedDiffFile;
    if (isChangesVisible && changesTabIndex === null) {
      setChangesTabIndex(chats.length);
    } else if (!isChangesVisible) {
      setChangesTabIndex(null);
    }
  }, [focusedDiffFile, changesTabDismissed, chats.length, changesTabIndex]);

  const [fileTabIndex, setFileTabIndex] = useState<number | null>(null);
  useEffect(() => {
    const isFileVisible = !fileTabDismissed && !!focusedFilePath;
    if (isFileVisible && fileTabIndex === null) {
      setFileTabIndex(
        chats.length + (!changesTabDismissed && !!focusedDiffFile ? 1 : 0),
      );
    } else if (!isFileVisible) {
      setFileTabIndex(null);
    }
  }, [
    focusedFilePath,
    fileTabDismissed,
    chats.length,
    fileTabIndex,
    changesTabDismissed,
    focusedDiffFile,
  ]);

  const handleNewChat = () => {
    const { chat } = createChat();
    switchChat(chat.id);
    setActiveView("chat");
  };

  const handleCloseChanges = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setActiveView("chat");
      setFocusedDiffFile(null);
      setChangesTabDismissed(true);
    },
    [setActiveView, setFocusedDiffFile, setChangesTabDismissed],
  );

  const handleCloseFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setActiveView("chat");
      setFocusedFilePath(null);
      setFileTabDismissed(true);
    },
    [setActiveView, setFocusedFilePath, setFileTabDismissed],
  );

  const handleStartRename = useCallback(
    (chatId: string, currentTitle: string) => {
      setRenamingChatId(chatId);
      setRenameValue(currentTitle || "");
      setTimeout(() => renameInputRef.current?.select(), 0);
    },
    [],
  );

  const handleFinishRename = useCallback(async () => {
    if (!renamingChatId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      try {
        await renameChat(renamingChatId, trimmed);
      } catch (err) {
        console.error("Failed to rename chat:", err);
      }
    }
    setRenamingChatId(null);
  }, [renamingChatId, renameValue, renameChat]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingChatId) return;
    const idToDelete = deletingChatId;
    setDeletingChatId(null);

    try {
      await deleteChat(idToDelete);
    } catch (err) {
      console.error("Failed to delete chat:", err);
    }

    if (idToDelete === activeChatId) {
      const remaining = chats.filter((c) => c.id !== idToDelete);
      if (remaining.length > 0) {
        switchChat(remaining[0].id);
      }
    }
  }, [deletingChatId, activeChatId, chats, deleteChat, switchChat]);

  const canDelete = chats.length > 1;
  /*
   * The Changes and file tabs are gone from this strip.
   *
   * They used to swap the conversation out for a diff or a file in this same
   * column. Both now open in the workspace pane on the right, beside the
   * conversation instead of on top of it, so a tab here would only offer a
   * worse version of somewhere the content already is.
   */
  const showChangesTab = false;
  const insertAt = showChangesTab ? (changesTabIndex ?? chats.length) : null;
  const showFileTab = false;
  const fileInsertAt = showFileTab
    ? (fileTabIndex ?? chats.length + (showChangesTab ? 1 : 0))
    : null;
  const fileTabFileName =
    focusedFilePath?.split("/").pop() ?? focusedFilePath ?? "";

  const tabElements = useMemo(() => {
    const changesTabEl = showChangesTab ? (
      <div
        key="__changes__"
        className={cn(
          "group relative flex shrink-0 items-center border-b-2 transition-colors",
          activeView === "diff"
            ? "border-base-content text-base-content"
            : "border-transparent text-base-content/60 hover:text-base-content",
        )}
      >
        <button
          type="button"
          onClick={() => setActiveView("diff")}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
        >
          <GitCompare className="h-3.5 w-3.5" />
          <span>Changes</span>
        </button>
        <button
          type="button"
          onClick={handleCloseChanges}
          className={cn(
            "mr-1 rounded p-0.5 text-base-content/60 transition-opacity hover:bg-base-200 hover:text-base-content",
            isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    ) : null;

    const fileTabEl = showFileTab ? (
      <div
        key="__file__"
        className={cn(
          "group relative flex shrink-0 items-center border-b-2 transition-colors",
          activeView === "file"
            ? "border-base-content text-base-content"
            : "border-transparent text-base-content/60 hover:text-base-content",
        )}
      >
        <button
          type="button"
          onClick={() => setActiveView("file")}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
        >
          <FileText className="h-3.5 w-3.5" />
          <span className="max-w-[120px] truncate">{fileTabFileName}</span>
        </button>
        <button
          type="button"
          onClick={handleCloseFile}
          className={cn(
            "mr-1 rounded p-0.5 text-base-content/60 transition-opacity hover:bg-base-200 hover:text-base-content",
            isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    ) : null;

    const elements: ReactNode[] = [];

    chats.forEach((chat, index) => {
      if (insertAt === index) {
        elements.push(changesTabEl);
      }
      if (fileInsertAt === index) {
        elements.push(fileTabEl);
      }

      const isActive = chat.id === activeChatId && activeView === "chat";
      const isRenaming = renamingChatId === chat.id;

      elements.push(
        <div
          key={chat.id}
          ref={isActive ? activeChatTabRef : undefined}
          className={cn(
            "group relative flex shrink-0 items-center border-b-2 transition-colors",
            isActive
              ? "border-base-content text-base-content"
              : "border-transparent text-base-content/60 hover:text-base-content",
          )}
        >
          {isRenaming ? (
            <div className="flex items-center px-2 py-[7px]">
              <input
                aria-label="New name for this chat"
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void handleFinishRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleFinishRename();
                  }
                  if (e.key === "Escape") {
                    setRenamingChatId(null);
                  }
                }}
                className="max-w-[130px] rounded border border-base-300 bg-base-100 px-1.5 py-0 text-sm font-medium outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
            </div>
          ) : (
            <button
              type="button"
              onMouseEnter={() => prefetchChat(chat.id)}
              onFocus={() => prefetchChat(chat.id)}
              onClick={() => {
                if (chat.id !== activeChatId) {
                  switchChat(chat.id);
                }
                setActiveView("chat");
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
            >
              <span className="max-w-[120px] truncate">
                {chat.title || "New Chat"}
              </span>
              {chat.hasUnread && (
                <span className="h-1.5 w-1.5 rounded-full bg-info" />
              )}
            </button>
          )}

          {!isRenaming && (
            <div
              className={cn(
                "flex items-center gap-0.5 pr-1 transition-opacity",
                isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartRename(chat.id, chat.title || "");
                }}
                className="rounded p-0.5 text-base-content/60 hover:bg-base-200 hover:text-base-content"
                aria-label="Rename chat"
              >
                <Pencil className="h-3 w-3" />
              </button>
              {canDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingChatId(chat.id);
                  }}
                  className="rounded p-0.5 text-base-content/60 hover:bg-base-200 hover:text-base-content"
                  aria-label="Close chat"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>,
      );
    });

    if (insertAt !== null && insertAt >= chats.length) {
      elements.push(changesTabEl);
    }

    if (fileInsertAt !== null && fileInsertAt >= chats.length) {
      elements.push(fileTabEl);
    }

    return elements;
  }, [
    activeChatId,
    activeView,
    canDelete,
    chats,
    fileInsertAt,
    fileTabFileName,
    handleCloseChanges,
    handleCloseFile,
    handleFinishRename,
    handleStartRename,
    insertAt,
    isMobile,
    prefetchChat,
    renameValue,
    renamingChatId,
    setActiveView,
    showChangesTab,
    showFileTab,
    switchChat,
  ]);

  return (
    <>
      <div className="flex items-center gap-0 border-b border-base-300 bg-base-200/30 px-1">
        <div
          ref={scrollContainerRef}
          className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabElements}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleNewChat}
                className="ml-1 flex shrink-0 items-center justify-center rounded p-1.5 text-base-content/60 transition-colors hover:bg-base-200 hover:text-base-content"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              New chat on its own branch
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Outside the scrolling container, so a session with a dozen chats
            open does not push the only way into Evals off the strip. */}
        <EvalsTabLink />
      </div>

      <ChatTabsWorkspaceNote />

      <Dialog
        open={deletingChatId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingChatId(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            {/*
              Titled for what it does, not what the X suggests. "Close" reads
              as putting a tab away; this deletes the chat and there is no
              reopening it.
            */}
            <DialogTitle>Delete this chat?</DialogTitle>
            <DialogDescription>
              This chat and everything said in it are deleted for good — there
              is no reopening it. The workspace and the other chats in it are
              not affected, and any work this chat already saved to its branch
              stays saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingChatId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
            >
              Delete this chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
