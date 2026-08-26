import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { WebAgentUIMessage } from "@/app/types";
import { DiffsProvider } from "@/components/diffs-provider";
import { capabilitiesForBackend } from "@/lib/agent/backend-capabilities";
import {
  getChatById,
  getChatMessages,
  getChatSummariesBySessionId,
} from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { buildModelOptions } from "@/lib/model-options";
import { listAllModels } from "@/lib/model-catalog";
import { enabledPluginRenderers } from "@/lib/plugins/renderer-info";
import { getServerSession } from "@/lib/session/get-server-session";
import { parseThemePreference, THEME_COOKIE_NAME } from "@/lib/theme";
import { getInitialIsOnlyChatInSession } from "./only-chat-in-session";
import { SessionChatContent } from "./session-chat-content";
import { SessionChatProvider } from "./session-chat-context";

export const maxDuration = 120;

interface SessionChatPageProps {
  params: Promise<{ sessionId: string; chatId: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOptimisticChatId(chatId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    chatId,
  );
}

const OPTIMISTIC_CHAT_RETRY_DELAY_MS = 100;
const OPTIMISTIC_CHAT_RETRY_ATTEMPTS = 50;

/**
 * Every model, across every backend — not just the one this chat currently
 * runs on.
 *
 * The composer filters these client-side against `capabilities.models`
 * (`ModelEffortBackendControls`), and its backend selector can switch the
 * chat after this page was rendered. Narrowing the list here would leave
 * that switch with nothing to reveal.
 */
function getInitialModels() {
  try {
    return listAllModels();
  } catch {
    return [];
  }
}

async function getChatByIdWithRetry(
  chatId: string,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof getChatById>>> {
  const maxAttempts = isOptimisticChatId(chatId)
    ? OPTIMISTIC_CHAT_RETRY_ATTEMPTS
    : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const chat = await getChatById(chatId);
    if (chat && chat.sessionId === sessionId) {
      return chat;
    }
    if (attempt < maxAttempts) {
      await sleep(OPTIMISTIC_CHAT_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

export async function generateMetadata({
  params,
}: SessionChatPageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const sessionRecord = await getSessionByIdCached(sessionId);

  return {
    title: sessionRecord?.title ?? `Session ${sessionId}`,
    description: "Review session progress, chats, and outputs.",
  };
}

export default async function SessionChatPage({
  params,
}: SessionChatPageProps) {
  const { sessionId, chatId } = await params;

  // Start independent fetches in parallel
  const sessionPromise = getServerSession();
  const sessionRecordPromise = getSessionByIdCached(sessionId);

  // Server-side auth check
  const session = await sessionPromise;
  if (!session?.user) {
    redirect("/");
  }

  // Fetch session record
  const sessionRecord = await sessionRecordPromise;
  if (!sessionRecord) {
    notFound();
  }

  // Check ownership
  if (sessionRecord.userId !== session.user.id) {
    redirect("/");
  }
  // Fetch chat, messages, models, the chat list, and enabled plugins'
  // renderer slots in parallel.
  const [chat, dbMessages, initialModels, sessionChats, pluginRenderers] =
    await Promise.all([
      getChatByIdWithRetry(chatId, sessionId),
      getChatMessages(chatId),
      getInitialModels(),
      getChatSummariesBySessionId(sessionId, session.user.id),
      enabledPluginRenderers(),
    ]);

  if (!chat) {
    if (isOptimisticChatId(chatId)) {
      redirect(`/sessions/${sessionId}`);
    }
    notFound();
  }

  const initialMessages = dbMessages.map((m) => m.parts as WebAgentUIMessage);

  // Compute generation duration for each assistant message:
  // duration = assistant.createdAt − preceding user.createdAt
  const messageDurationMap: Record<string, number> = {};
  // Also store the preceding user message's createdAt so that a currently-
  // streaming message can show a live timer relative to when the user sent it.
  const messageStartedAtMap: Record<string, string> = {};
  for (let i = 0; i < dbMessages.length; i++) {
    const m = dbMessages[i];
    if (m.role === "assistant" && i > 0) {
      const prev = dbMessages[i - 1];
      if (prev && prev.role === "user") {
        messageDurationMap[m.id] =
          m.createdAt.getTime() - prev.createdAt.getTime();
        messageStartedAtMap[m.id] = prev.createdAt.toISOString();
      }
    }
  }

  // Fallback for refresh-during-stream: the streaming assistant message may
  // not be in the maps above (not yet persisted or different ID). Use the
  // last user message's createdAt so the timer still starts from the right
  // moment.
  const lastUserMessage = dbMessages
    .toReversed()
    .find((m) => m.role === "user");
  const lastUserMessageSentAt = lastUserMessage
    ? lastUserMessage.createdAt.toISOString()
    : null;
  const initialModelOptions = buildModelOptions(initialModels);

  /*
   * Resolved here rather than in the client provider: the highlighter is built
   * once per page from the first theme it sees, and the client only learns the
   * preference after mount — too late to matter.
   */
  const themePreference = parseThemePreference(
    (await cookies()).get(THEME_COOKIE_NAME)?.value,
  );

  const initialIsOnlyChatInSession = getInitialIsOnlyChatInSession(
    sessionChats,
    chat.id,
  );

  // Computed here, not derived client-side from `chat.backend`: this is the
  // chat bootstrap payload capability-driven UI reads (Section 7 Task 5) —
  // `EffortSelectorCompact` hides itself when `chatCapabilities.effort` is
  // `false`, without ever hardcoding a backend id.
  const initialCapabilities = capabilitiesForBackend(chat.backend);

  return (
    <DiffsProvider themePreference={themePreference}>
      <SessionChatProvider
        session={sessionRecord}
        chat={chat}
        initialCapabilities={initialCapabilities}
        initialMessages={initialMessages}
        initialModelOptions={initialModelOptions}
      >
        <SessionChatContent
          initialIsOnlyChatInSession={initialIsOnlyChatInSession}
          messageDurationMap={messageDurationMap}
          messageStartedAtMap={messageStartedAtMap}
          lastUserMessageSentAt={lastUserMessageSentAt}
          pluginRenderers={pluginRenderers}
        />
      </SessionChatProvider>
    </DiffsProvider>
  );
}
