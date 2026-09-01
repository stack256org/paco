import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));

let sessionRecord: { id: string } | null = null;
let chats: Array<{ id: string }> = [];
let githubProfile: { login: string } | null = null;

const originalAppUrl = process.env.APP_URL;

function restoreEnv() {
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }
}

mock.module("@/app/api/generate-pr/_lib/generate-pr-helpers", () => ({
  getConversationContext: async () => "",
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRecord,
  getChatsBySessionId: async () => chats,
}));

mock.module("@/lib/db/github-tokens", () => ({
  getGithubConnection: async () => githubProfile,
}));

const prContentModulePromise = import("./pr-content");

describe("pr-content", () => {
  beforeEach(() => {
    sessionRecord = null;
    chats = [];
    githubProfile = null;
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  test("resolvePullRequestContextSection returns a single-line footer with chat link and attribution", async () => {
    const { resolvePullRequestContextSection } = await prContentModulePromise;

    sessionRecord = { id: "session-1" };
    chats = [{ id: "chat-2" }, { id: "chat-1" }];
    githubProfile = { login: "nicoalbanese10" };

    const section = await resolvePullRequestContextSection({
      sessionId: "session-1",
      appBaseUrl: "https://paco.local",
    });

    expect(section).toBe(
      "[Chat](https://paco.local/sessions/session-1/chats/chat-2) - Built with guidance from [nicoalbanese10](https://github.com/nicoalbanese10)",
    );
  });

  test("resolvePullRequestContextSection omits attribution when no GitHub account is connected", async () => {
    const { resolvePullRequestContextSection } = await prContentModulePromise;

    sessionRecord = { id: "session-1" };

    const section = await resolvePullRequestContextSection({
      sessionId: "session-1",
    });

    expect(section).toBe("");
  });

  test("resolvePullRequestAppBaseUrl prefers an explicit base url over the configured one", async () => {
    const { resolvePullRequestAppBaseUrl } = await prContentModulePromise;

    process.env.APP_URL = "paco.example";

    expect(resolvePullRequestAppBaseUrl("https://override.example")).toBe(
      "https://override.example",
    );
  });

  test("resolvePullRequestAppBaseUrl falls back to the configured app url", async () => {
    // A self-hosted install has a single public URL, so there is no
    // preview-vs-production deployment to choose between.
    const { resolvePullRequestAppBaseUrl } = await prContentModulePromise;

    process.env.APP_URL = "paco.example";

    expect(resolvePullRequestAppBaseUrl()).toBe("https://paco.example");
  });

  test("resolvePullRequestAppBaseUrl returns null when no app url is configured", async () => {
    const { resolvePullRequestAppBaseUrl } = await prContentModulePromise;

    delete process.env.APP_URL;

    expect(resolvePullRequestAppBaseUrl()).toBeNull();
  });

  test("appendPullRequestContextSection appends the footer after a horizontal rule", async () => {
    const { appendPullRequestContextSection } = await prContentModulePromise;

    expect(
      appendPullRequestContextSection(
        "## Summary\n\nInitial body\n",
        "[Chat](https://example.com) - Built with guidance from Nico",
      ),
    ).toBe(`## Summary

Initial body

---

[Chat](https://example.com) - Built with guidance from Nico`);
  });
});
