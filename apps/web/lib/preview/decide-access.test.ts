import { describe, expect, test } from "bun:test";
import {
  decideCandidatePreviewAccess,
  decidePreviewAccess,
  type PreviewChatOwner,
} from "./decide-access";
import {
  candidatePreviewHostname,
  parsePreviewHostSlug,
  previewSlug,
  previewSlugFromHost,
} from "./hostname";

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

describe("decideCandidatePreviewAccess", () => {
  test("behaves identically to decidePreviewAccess for every scenario", () => {
    // The whole point of this wrapper: candidates have no access rules of
    // their own, so nothing about the decision may differ once the caller
    // has already resolved the candidate host down to its owning chat.
    const scenarios: Array<{
      chat: PreviewChatOwner | null;
      requesterUserId: string | undefined;
    }> = [
      { chat: null, requesterUserId: undefined },
      { chat: null, requesterUserId: "someone" },
      { chat: PUBLIC_CHAT, requesterUserId: undefined },
      { chat: PUBLIC_CHAT, requesterUserId: "someone-else" },
      { chat: PRIVATE_CHAT, requesterUserId: undefined },
      { chat: PRIVATE_CHAT, requesterUserId: "not-owner-1" },
      { chat: PRIVATE_CHAT, requesterUserId: "owner-1" },
    ];

    for (const scenario of scenarios) {
      expect(decideCandidatePreviewAccess(scenario)).toBe(
        decidePreviewAccess(scenario),
      );
    }
  });

  test("a candidate hostname resolves to its chat's slug, and inherits that chat's access decision end to end", () => {
    // Simulates what forward auth does for a candidate preview request:
    // strip the base domain, then strip the `-d<n>` suffix, then look the
    // resulting chat slug up (here, just asserted equal to the chat's own
    // slug rather than actually querying the database) and decide access
    // exactly as it would for the chat's own preview.
    const baseDomain = "previews.example.com";
    const hostname = candidatePreviewHostname(
      PRIVATE_CHAT.chatId,
      2,
      baseDomain,
    );
    expect(hostname).not.toBeNull();

    const label = previewSlugFromHost(hostname as string, baseDomain);
    expect(label).not.toBeNull();

    const { chatSlug, candidateIndex } = parsePreviewHostSlug(label as string);
    expect(candidateIndex).toBe(2);

    // The chat lookup itself (`findChatOwnerByPreviewSlug`) is a database
    // call outside this pure module's reach; what matters here is that the
    // slug it would be looked up by matches the chat's own, and that the
    // access decision for that chat is exactly what an ordinary preview
    // request for the same chat would get.
    expect(chatSlug).toBe(previewSlug(PRIVATE_CHAT.chatId));

    const forOwner = decideCandidatePreviewAccess({
      chat: PRIVATE_CHAT,
      requesterUserId: "owner-1",
    });
    const forStranger = decideCandidatePreviewAccess({
      chat: PRIVATE_CHAT,
      requesterUserId: "not-owner-1",
    });

    expect(forOwner).toBe(
      decidePreviewAccess({ chat: PRIVATE_CHAT, requesterUserId: "owner-1" }),
    );
    expect(forStranger).toBe(
      decidePreviewAccess({
        chat: PRIVATE_CHAT,
        requesterUserId: "not-owner-1",
      }),
    );
  });
});
