import { describe, expect, test } from "bun:test";
import { decidePreviewAccess, type PreviewChatOwner } from "./decide-access";

const PUBLIC_CHAT: PreviewChatOwner = {
  chatId: "chat-1",
  ownerUserId: "owner-1",
  visibility: "public",
};

const PRIVATE_CHAT: PreviewChatOwner = {
  chatId: "chat-1",
  ownerUserId: "owner-1",
  visibility: "private",
};

describe("decidePreviewAccess", () => {
  test("denies an unmappable host — no matching chat", () => {
    expect(
      decidePreviewAccess({ chat: null, requesterUserId: undefined }),
    ).toBe("deny");
  });

  test("denies an unmappable host even with a valid session", () => {
    // Whoever is asking, "no such preview" is not theirs to open.
    expect(
      decidePreviewAccess({ chat: null, requesterUserId: "someone" }),
    ).toBe("deny");
  });

  test("allows a public preview with no session", () => {
    expect(
      decidePreviewAccess({ chat: PUBLIC_CHAT, requesterUserId: undefined }),
    ).toBe("allow");
  });

  test("allows a public preview regardless of who is asking", () => {
    expect(
      decidePreviewAccess({
        chat: PUBLIC_CHAT,
        requesterUserId: "someone-else",
      }),
    ).toBe("allow");
  });

  test("denies a private preview with no session", () => {
    expect(
      decidePreviewAccess({ chat: PRIVATE_CHAT, requesterUserId: undefined }),
    ).toBe("deny");
  });

  test("denies a private preview when the session belongs to someone else", () => {
    expect(
      decidePreviewAccess({
        chat: PRIVATE_CHAT,
        requesterUserId: "not-owner-1",
      }),
    ).toBe("deny");
  });

  test("allows a private preview for its owner's session", () => {
    expect(
      decidePreviewAccess({
        chat: PRIVATE_CHAT,
        requesterUserId: "owner-1",
      }),
    ).toBe("allow");
  });

  test("every denial reduces to the same value — the cause is never observable", () => {
    // The regression this guards: returning distinct reasons ("not-found" vs
    // "forbidden") would let an unauthenticated caller learn which preview
    // slugs exist by comparing responses across hostnames.
    const noSuchChat = decidePreviewAccess({
      chat: null,
      requesterUserId: undefined,
    });
    const notYours = decidePreviewAccess({
      chat: PRIVATE_CHAT,
      requesterUserId: "not-owner-1",
    });

    expect(noSuchChat).toBe(notYours);
    expect(noSuchChat).toBe("deny");
  });
});
