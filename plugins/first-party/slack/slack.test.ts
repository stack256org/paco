import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { discoverPlugin } from "../../../packages/plugin-kit/discovery.ts";
import { PluginHost } from "../../../packages/plugin-host/host.ts";
import type {
  PluginApi,
  PluginFetchRequest,
  PluginFetchResponse,
  PluginKvApi,
  PluginSessionEvent,
  PluginTaskCreateInput,
  PluginTaskCreateResult,
} from "../../../packages/plugin-host/plugin-api.ts";
import eventsChannel from "./channels/events.ts";
import taskUpdatesHook from "./hooks/task-updates.ts";
import slackSetupTool from "./tools/slack-setup.ts";

/**
 * Unit tests import the channel/tool/hook modules directly against a fake
 * `PluginApi` (fast, and exercises exactly this plugin's own logic). The
 * final `describe` block instead runs a real, fixture-installed copy of
 * this plugin through the actual `PluginHost` -- the same protocol
 * production uses -- to prove the whole path from a signed webhook to a
 * created task actually works end to end.
 */

const SIGNING_SECRET = "test-signing-secret";

/** Computes a real Slack v0 signature, the same way `lib/signature.ts` does. */
function signRequest(
  rawBody: string,
  timestamp: number,
  secret: string = SIGNING_SECRET,
): Record<string, string> {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${createHmac("sha256", secret)
    .update(baseString, "utf8")
    .digest("hex")}`;
  return {
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeApiOptions {
  kv?: Record<string, unknown>;
  fetchImpl?: (
    request: PluginFetchRequest,
  ) => PluginFetchResponse | Promise<PluginFetchResponse>;
  tasksCreateImpl?: (
    input: PluginTaskCreateInput,
  ) => PluginTaskCreateResult | Promise<PluginTaskCreateResult>;
}

interface FakeApi {
  api: PluginApi;
  kvStore: Map<string, unknown>;
  fetchCalls: PluginFetchRequest[];
  postMessageCalls: Array<{ chatId: string; text: string }>;
  /** Set by the hook tests, which replace `api.events.subscribe` to capture
   * the callback instead of storing it nowhere. */
  emit?: (event: PluginSessionEvent) => void;
}

function makeFakeApi(options: FakeApiOptions = {}): FakeApi {
  const kvStore = new Map<string, unknown>(Object.entries(options.kv ?? {}));
  const fetchCalls: PluginFetchRequest[] = [];
  const postMessageCalls: Array<{ chatId: string; text: string }> = [];

  const kv: PluginKvApi = {
    get: (key) => Promise.resolve(kvStore.has(key) ? kvStore.get(key) : null),
    set: (key, value) => {
      kvStore.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      kvStore.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...kvStore.keys()].filter((key) => !prefix || key.startsWith(prefix)),
      ),
  };

  const api: PluginApi = {
    pluginId: "slack",
    stateDir: "/tmp/slack-plugin-test",
    fetch: async (request) => {
      fetchCalls.push(request);
      if (options.fetchImpl) {
        return await options.fetchImpl(request);
      }
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
    },
    kv,
    postMessage: (message) => {
      postMessageCalls.push(message);
      return Promise.resolve({ ok: true });
    },
    events: {
      subscribe: () => () => {
        // No subscribers in the default fake; hook tests replace this.
      },
    },
    panel: () => Promise.resolve(undefined),
    tasks: {
      create: async (input) => {
        if (options.tasksCreateImpl) {
          return await options.tasksCreateImpl(input);
        }
        return { taskId: "task-1", chatId: "chat-1" };
      },
    },
    log: () => {
      // Diagnostics only; tests assert on behavior, not log lines.
    },
  };

  return { api, kvStore, fetchCalls, postMessageCalls };
}

function findFetch(
  fetchCalls: PluginFetchRequest[],
  suffix: string,
): PluginFetchRequest | undefined {
  return fetchCalls.find((call) => call.url.endsWith(suffix));
}

describe("channels/events.ts", () => {
  test("echoes the url_verification challenge when the signature is valid", async () => {
    const { api } = makeFakeApi({
      kv: { "slack:signing-secret": SIGNING_SECRET },
    });
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
    });
    const headers = signRequest(rawBody, nowSeconds());

    const response = await eventsChannel.handle(
      { headers, body: JSON.parse(rawBody), rawBody },
      api,
    );

    expect(response).toEqual({ status: 200, body: { challenge: "abc123" } });
  });

  test("rejects everything with 401 before slack_setup has stored a signing secret", async () => {
    const { api } = makeFakeApi();

    const response = await eventsChannel.handle(
      { headers: {}, body: null, rawBody: "" },
      api,
    );

    expect(response.status).toBe(401);
  });

  test("rejects a bad signature with 401", async () => {
    const { api } = makeFakeApi({
      kv: { "slack:signing-secret": SIGNING_SECRET },
    });
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
    });
    const headers = {
      "x-slack-request-timestamp": String(nowSeconds()),
      "x-slack-signature":
        "v0=0000000000000000000000000000000000000000000000000000000000000000",
    };

    const response = await eventsChannel.handle(
      { headers, body: JSON.parse(rawBody), rawBody },
      api,
    );

    expect(response.status).toBe(401);
  });

  test("rejects a stale timestamp with 401, even with an otherwise-valid signature", async () => {
    const { api } = makeFakeApi({
      kv: { "slack:signing-secret": SIGNING_SECRET },
    });
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
    });
    const staleTimestamp = nowSeconds() - 3600; // one hour old
    const headers = signRequest(rawBody, staleTimestamp);

    const response = await eventsChannel.handle(
      { headers, body: JSON.parse(rawBody), rawBody },
      api,
    );

    expect(response.status).toBe(401);
  });

  test("a signed app_mention creates a task and posts a threaded ack", async () => {
    const { api, fetchCalls } = makeFakeApi({
      kv: {
        "slack:signing-secret": SIGNING_SECRET,
        "slack:bot-token": "xoxb-test",
        "slack:default-session": "session-1",
      },
      tasksCreateImpl: (input) => {
        expect(input).toEqual({
          sessionId: "session-1",
          title: "please build the thing",
          goal: "please build the thing",
          autoStart: true,
        });
        return { taskId: "task-42", chatId: "chat-42" };
      },
    });

    const event = {
      type: "app_mention",
      channel: "C123",
      ts: "1000.001",
      text: "<@U0BOT> please build the thing",
    };
    const rawBody = JSON.stringify({ type: "event_callback", event });
    const headers = signRequest(rawBody, nowSeconds());

    const response = await eventsChannel.handle(
      { headers, body: JSON.parse(rawBody), rawBody },
      api,
    );

    expect(response).toEqual({ status: 200, body: {} });

    const postMessageCall = findFetch(fetchCalls, "/chat.postMessage");
    expect(postMessageCall).toBeDefined();
    expect(JSON.parse(String(postMessageCall?.body))).toEqual({
      channel: "C123",
      thread_ts: "1000.001",
      text: "Started task task-42.",
    });
  });

  test("acknowledges a Slack retry without re-processing the mention", async () => {
    let tasksCreateCalls = 0;
    const { api } = makeFakeApi({
      kv: {
        "slack:signing-secret": SIGNING_SECRET,
        "slack:default-session": "session-1",
      },
      tasksCreateImpl: () => {
        tasksCreateCalls++;
        return { taskId: "task-x" };
      },
    });

    const event = { type: "app_mention", channel: "C1", ts: "1", text: "hi" };
    const rawBody = JSON.stringify({ type: "event_callback", event });
    const headers = {
      ...signRequest(rawBody, nowSeconds()),
      "x-slack-retry-num": "1",
    };

    const response = await eventsChannel.handle(
      { headers, body: JSON.parse(rawBody), rawBody },
      api,
    );

    expect(response).toEqual({ status: 200, body: {} });
    expect(tasksCreateCalls).toBe(0);
  });

  test("routes a follow-up mention in a known thread into the existing chat instead of creating a new task", async () => {
    const { api, postMessageCalls, fetchCalls } = makeFakeApi({
      kv: {
        "slack:signing-secret": SIGNING_SECRET,
        "slack:bot-token": "xoxb-test",
        "slack:thread-index:C1:1000.000": "task-9",
        "slack:thread:task-9": {
          channel: "C1",
          ts: "1000.000",
          threadTs: "1000.000",
          chatId: "chat-9",
        },
      },
      tasksCreateImpl: () => {
        throw new Error("should not create a new task for a known thread");
      },
    });

    const event = {
      type: "app_mention",
      channel: "C1",
      ts: "1000.005",
      thread_ts: "1000.000",
      text: "<@U1> and also do this",
    };
    const rawBody = JSON.stringify({ type: "event_callback", event });
    const headers = signRequest(rawBody, nowSeconds());

    const response = await eventsChannel.handle(
      { headers, body: JSON.parse(rawBody), rawBody },
      api,
    );

    expect(response).toEqual({ status: 200, body: {} });
    expect(postMessageCalls).toEqual([
      { chatId: "chat-9", text: "and also do this" },
    ]);
    const ack = findFetch(fetchCalls, "/chat.postMessage");
    expect(JSON.parse(String(ack?.body)).text).toBe("Added to task task-9.");
  });
});

describe("tools/slack-setup.ts", () => {
  test("validates the token, stores config in kv, and returns the webhook URL", async () => {
    const { api, kvStore } = makeFakeApi({
      fetchImpl: () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, team: "Acme", user_id: "U0BOT" }),
      }),
    });

    const result = await slackSetupTool.execute(
      {
        botToken: "xoxb-real",
        signingSecret: "shh",
        defaultSessionId: "session-1",
        appUrl: "https://paco.example.com/",
        channelMap: { C1: "session-2" },
      },
      api,
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: true,
      webhookUrl: "https://paco.example.com/api/channels/slack/events",
      team: "Acme",
      botUserId: "U0BOT",
    });
    expect(kvStore.get("slack:bot-token")).toBe("xoxb-real");
    expect(kvStore.get("slack:signing-secret")).toBe("shh");
    expect(kvStore.get("slack:default-session")).toBe("session-1");
    expect(kvStore.get("slack:channel-map:C1")).toBe("session-2");
  });

  test("reports Slack's rejection of a bad bot token without storing anything", async () => {
    const { api, kvStore } = makeFakeApi({
      fetchImpl: () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: false, error: "invalid_auth" }),
      }),
    });

    const result = await slackSetupTool.execute(
      {
        botToken: "xoxb-bad",
        signingSecret: "shh",
        defaultSessionId: "session-1",
        appUrl: "https://paco.example.com",
      },
      api,
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: false,
      error: "Slack rejected the bot token: invalid_auth",
    });
    expect(kvStore.size).toBe(0);
  });

  test("rejects malformed input before ever calling Slack", async () => {
    const { api, fetchCalls } = makeFakeApi();

    const result = await slackSetupTool.execute(
      { botToken: "", signingSecret: "shh" },
      api,
      new AbortController().signal,
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("hooks/task-updates.ts", () => {
  function makeFakeApiForHook(options: FakeApiOptions = {}): FakeApi & {
    emit: (event: PluginSessionEvent) => void;
  } {
    const fake = makeFakeApi(options);
    let subscriber: ((event: PluginSessionEvent) => void) | undefined;
    fake.api.events = {
      subscribe(callback) {
        subscriber = callback;
        return () => {
          subscriber = undefined;
        };
      },
    };
    return {
      ...fake,
      emit: (event) => subscriber?.(event),
    };
  }

  test("posts a threaded status update for a task with a stored thread", async () => {
    const { api, fetchCalls, emit } = makeFakeApiForHook({
      kv: {
        "slack:bot-token": "xoxb-test",
        "slack:thread:task-1": {
          channel: "C1",
          ts: "1",
          threadTs: "1",
          chatId: "chat-1",
        },
      },
    });

    taskUpdatesHook(api);
    emit({
      id: 1,
      chatId: "chat-1",
      event: {
        type: "task/status",
        taskId: "task-1",
        from: "todo",
        to: "running",
      },
    });
    await flushMicrotasks();

    const postCall = findFetch(fetchCalls, "/chat.postMessage");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.body)).text).toBe(
      "Task task-1: todo -> running.",
    );
  });

  test("says a task finished when its status transitions to done", async () => {
    const { api, fetchCalls, emit } = makeFakeApiForHook({
      kv: {
        "slack:bot-token": "xoxb-test",
        "slack:thread:task-1": {
          channel: "C1",
          ts: "1",
          threadTs: "1",
          chatId: "chat-1",
        },
      },
    });

    taskUpdatesHook(api);
    emit({
      id: 1,
      chatId: "chat-1",
      event: {
        type: "task/status",
        taskId: "task-1",
        from: "review",
        to: "done",
      },
    });
    await flushMicrotasks();

    const postCall = findFetch(fetchCalls, "/chat.postMessage");
    expect(JSON.parse(String(postCall?.body)).text).toBe(
      "Task task-1 finished: review -> done.",
    );
  });

  test("ignores a task/status event for a task with no stored thread", async () => {
    const { fetchCalls, emit, api } = makeFakeApiForHook();

    taskUpdatesHook(api);
    emit({
      id: 1,
      chatId: "chat-1",
      event: {
        type: "task/status",
        taskId: "unknown-task",
        from: "todo",
        to: "running",
      },
    });
    await flushMicrotasks();

    expect(fetchCalls).toHaveLength(0);
  });

  test("posts a turn/end update for a task correlated by chat id", async () => {
    // KNOWN GAP (see hooks/task-updates.ts): `turn/end` carries no
    // resultSummary text, so this posts the turn's finishReason instead --
    // the closest signal available without a `tasks:read` capability.
    const { api, fetchCalls, emit } = makeFakeApiForHook({
      kv: {
        "slack:bot-token": "xoxb-test",
        "slack:thread:task-1": {
          channel: "C1",
          ts: "1",
          threadTs: "1",
          chatId: "chat-1",
        },
        "slack:chat-task:chat-1": "task-1",
      },
    });

    taskUpdatesHook(api);
    emit({
      id: 2,
      chatId: "chat-1",
      event: {
        type: "turn/end",
        turnId: "turn-1",
        finishReason: "stop",
        isError: false,
      },
    });
    await flushMicrotasks();

    const postCall = findFetch(fetchCalls, "/chat.postMessage");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.body)).text).toBe(
      "Task task-1: turn finished (stop).",
    );
  });

  test("does not post for an errored turn/end (task/status -> failed already covers it)", async () => {
    const { api, fetchCalls, emit } = makeFakeApiForHook({
      kv: {
        "slack:bot-token": "xoxb-test",
        "slack:thread:task-1": {
          channel: "C1",
          ts: "1",
          threadTs: "1",
          chatId: "chat-1",
        },
        "slack:chat-task:chat-1": "task-1",
      },
    });

    taskUpdatesHook(api);
    emit({
      id: 2,
      chatId: "chat-1",
      event: {
        type: "turn/end",
        turnId: "turn-1",
        finishReason: "error",
        isError: true,
      },
    });
    await flushMicrotasks();

    expect(fetchCalls).toHaveLength(0);
  });
});

describe("integration: real PluginHost", () => {
  function handleFakeKv(
    store: Map<string, unknown>,
    payload: unknown,
  ): unknown {
    const op = payload as { op: string; key?: string; value?: unknown };
    switch (op.op) {
      case "get":
        return store.has(op.key as string) ? store.get(op.key as string) : null;
      case "set":
        store.set(op.key as string, op.value);
        return { ok: true };
      case "delete":
        store.delete(op.key as string);
        return { ok: true };
      case "list":
        return {
          items: [...store.entries()].map(([key, value]) => ({ key, value })),
        };
      default:
        throw new Error(`unhandled fake kv op: ${JSON.stringify(op)}`);
    }
  }

  test("a signed app_mention delivered through the real PluginHost creates a task and posts a threaded ack", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "slack-plugin-install-"));
    const installedDir = path.join(rootDir, "slack");
    // Fixture-installs a real copy of this plugin's own source directory,
    // the same way `lib/plugins/install.ts`'s `{kind: "local"}` source
    // copies a plugin into place -- so the worker loads the exact files
    // this task ships, not a hand-written stand-in.
    await cp(path.join(import.meta.dirname), installedDir, { recursive: true });

    const discovered = await discoverPlugin(installedDir);
    if (!discovered.ok) {
      throw new Error(`fixture failed to discover: ${discovered.error}`);
    }

    const kvStore = new Map<string, unknown>();
    const netFetchLog: PluginFetchRequest[] = [];
    let createdTaskInput: PluginTaskCreateInput | undefined;

    const host = new PluginHost({
      descriptor: discovered.plugin,
      grantedCapabilities: discovered.plugin.manifest.capabilities,
      netDomains: ["slack.com"],
      hardened: false,
      handlers: {
        "storage:kv": (_pluginId, payload) => handleFakeKv(kvStore, payload),
        "net:fetch": (_pluginId, payload) => {
          const request = payload as PluginFetchRequest;
          netFetchLog.push(request);
          return Promise.resolve({
            status: 200,
            headers: {},
            body: JSON.stringify({ ok: true, ts: "999.1" }),
          });
        },
        "tasks:create": (_pluginId, payload) => {
          createdTaskInput = payload as PluginTaskCreateInput;
          return Promise.resolve({
            taskId: "task-int-1",
            chatId: "chat-int-1",
          });
        },
        "messages:post": () => Promise.resolve({ ok: true }),
      },
    });

    try {
      await host.start();
      kvStore.set("slack:signing-secret", SIGNING_SECRET);
      kvStore.set("slack:default-session", "session-1");
      kvStore.set("slack:bot-token", "xoxb-integration-test");

      const event = {
        type: "app_mention",
        channel: "C1",
        ts: "1",
        text: "<@U1> integration test task",
      };
      const rawBody = JSON.stringify({ type: "event_callback", event });
      const headers = signRequest(rawBody, nowSeconds());

      const outcome = await host.deliverIngress(
        "events",
        headers,
        JSON.parse(rawBody),
        rawBody,
      );

      expect(outcome).toEqual({ ok: true, status: 200, body: {} });
      expect(createdTaskInput).toEqual({
        sessionId: "session-1",
        title: "integration test task",
        goal: "integration test task",
        autoStart: true,
      });
      expect(findFetch(netFetchLog, "/chat.postMessage")).toBeDefined();
    } finally {
      await host.stop();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("a bad signature delivered through the real PluginHost is rejected with 401, without creating a task", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "slack-plugin-install-"));
    const installedDir = path.join(rootDir, "slack");
    await cp(path.join(import.meta.dirname), installedDir, { recursive: true });

    const discovered = await discoverPlugin(installedDir);
    if (!discovered.ok) {
      throw new Error(`fixture failed to discover: ${discovered.error}`);
    }

    const kvStore = new Map<string, unknown>();
    let tasksCreateCalls = 0;

    const host = new PluginHost({
      descriptor: discovered.plugin,
      grantedCapabilities: discovered.plugin.manifest.capabilities,
      netDomains: ["slack.com"],
      hardened: false,
      handlers: {
        "storage:kv": (_pluginId, payload) => handleFakeKv(kvStore, payload),
        "net:fetch": () =>
          Promise.resolve({ status: 200, headers: {}, body: "{}" }),
        "tasks:create": () => {
          tasksCreateCalls++;
          return Promise.resolve({ taskId: "should-not-happen" });
        },
      },
    });

    try {
      await host.start();
      kvStore.set("slack:signing-secret", SIGNING_SECRET);
      kvStore.set("slack:default-session", "session-1");

      const event = {
        type: "app_mention",
        channel: "C1",
        ts: "1",
        text: "<@U1> should be rejected",
      };
      const rawBody = JSON.stringify({ type: "event_callback", event });

      const outcome = await host.deliverIngress(
        "events",
        {
          "x-slack-request-timestamp": String(nowSeconds()),
          "x-slack-signature": "v0=bad",
        },
        JSON.parse(rawBody),
        rawBody,
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.status).toBe(401);
      expect(tasksCreateCalls).toBe(0);
    } finally {
      await host.stop();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
