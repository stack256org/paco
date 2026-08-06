/**
 * Build a session API URL that is scoped to one chat.
 *
 * A chat is a git worktree of the session repository, so a request that omits
 * `chatId` is answered from the session repository instead — which sits on the
 * default branch and contains none of the chat's work. The route still returns
 * 200, so the mistake reads as "there is nothing here" rather than as an error:
 * the diff download produced an empty patch and the commit-message generator
 * described no changes at all.
 *
 * Kept as a function rather than an inline template so the chat scope is one
 * thing that can be tested, not a string that each call site has to remember.
 */
export function chatScopedUrl(path: string, chatId: string): string {
  if (!chatId) {
    // `useChatId` answers "" outside a chat route; asking for `?chatId=` would
    // be worse than not asking, so fall back to the session-wide route.
    return path;
  }

  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}chatId=${encodeURIComponent(chatId)}`;
}
