"use client";

import { useParams, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  type SessionChatListItem,
  useSessionChats,
} from "@/hooks/use-session-chats";
import type { Session } from "@/lib/db/schema";
import {
  GitPanelProvider,
  useGitPanel,
} from "./chats/[chatId]/git-panel-context";
import { SessionHeader } from "./chats/[chatId]/session-header";
import { SplitPane } from "@/components/ui/split-pane";
import { ChatTabs } from "./chats/[chatId]/chat-tabs";
import { SessionLayoutContext } from "./session-layout-context";
import { useLiveSession } from "./use-live-session";

type SessionLayoutShellProps = {
  session: Session;
  initialChatsData?: {
    defaultModelId: string | null;
    chats: SessionChatListItem[];
  };
  children: ReactNode;
};

/**
 * Inner component that reads panelContent from context and renders
 * the horizontal split: left column (header + tabs + page) | right panel.
 */
function SessionLayoutInner({
  activeChatId,
  children,
}: {
  activeChatId: string;
  children: ReactNode;
}) {
  const { workspacePortalRef } = useGitPanel();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SessionHeader />

      {/*
        Conversation on the left, workspace on the right.

        The chat used to have the whole width with a narrow drawer that could
        slide over it; the running app and the editor were not here at all, they
        were other browser tabs. Splitting the screen puts the thing being built
        next to the conversation building it, which is the pairing this product
        is for. The divider is draggable and the position is remembered.
      */}
      <SplitPane
        className="min-h-0 flex-1"
        left={
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {activeChatId && <ChatTabs activeChatId={activeChatId} />}
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </div>
        }
        leftLabel="conversation"
        right={<div className="h-full" ref={workspacePortalRef} />}
        rightLabel="workspace"
        storageKey="paco:session-split"
      />
    </div>
  );
}

export function SessionLayoutShell({
  session: initialSession,
  initialChatsData,
  children,
}: SessionLayoutShellProps) {
  const router = useRouter();
  const params = useParams<{ chatId?: string }>();
  const routeChatId = params.chatId ?? "";
  const [optimisticActiveChatId, setOptimisticActiveChatId] = useState<
    string | null
  >(null);
  const [_isNavigatingChat, startChatNavigationTransition] = useTransition();
  const prefetchedChatHrefsRef = useRef(new Set<string>());

  const sessionId = initialSession.id;
  // The server render is only the starting point: sessions are auto-renamed
  // and their diff counts change while the page is open.
  const session = useLiveSession(initialSession);

  const {
    chats,
    loading: chatsLoading,
    createChat,
    deleteChat,
    renameChat,
  } = useSessionChats(sessionId, { initialData: initialChatsData });

  const getChatHref = useCallback(
    (chatId: string) => `/sessions/${sessionId}/chats/${chatId}`,
    [sessionId],
  );

  const switchChat = useCallback(
    (chatId: string) => {
      if (chatId === (optimisticActiveChatId ?? routeChatId)) {
        return;
      }

      const href = getChatHref(chatId);
      prefetchedChatHrefsRef.current.add(href);
      setOptimisticActiveChatId(chatId);
      startChatNavigationTransition(() => {
        router.push(href, { scroll: false });
      });
    },
    [getChatHref, optimisticActiveChatId, routeChatId, router],
  );

  useEffect(() => {
    if (optimisticActiveChatId && optimisticActiveChatId === routeChatId) {
      setOptimisticActiveChatId(null);
    }
  }, [optimisticActiveChatId, routeChatId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const chat of chats.slice(0, 6)) {
        const href = getChatHref(chat.id);
        if (prefetchedChatHrefsRef.current.has(href)) {
          continue;
        }

        prefetchedChatHrefsRef.current.add(href);
        router.prefetch(href);
      }
    }, 150);

    return () => {
      window.clearTimeout(timer);
    };
  }, [chats, getChatHref, router]);

  const activeChatId = optimisticActiveChatId ?? routeChatId;

  const layoutContext = useMemo(
    () => ({
      session: {
        title: session.title,
        repoName: session.repoName,
        repoOwner: session.repoOwner,
        cloneUrl: session.cloneUrl,
        branch: session.branch,
        status: session.status,
        prNumber: session.prNumber,
        prStatus: session.prStatus ?? null,
        linesAdded: session.linesAdded,
        linesRemoved: session.linesRemoved,
      },
      chats,
      chatsLoading,
      createChat,
      switchChat,
      deleteChat,
      renameChat,
    }),
    [
      session,
      chats,
      chatsLoading,
      createChat,
      switchChat,
      deleteChat,
      renameChat,
    ],
  );

  return (
    <SessionLayoutContext.Provider value={layoutContext}>
      <GitPanelProvider>
        <SessionLayoutInner activeChatId={activeChatId}>
          {children}
        </SessionLayoutInner>
      </GitPanelProvider>
    </SessionLayoutContext.Provider>
  );
}
