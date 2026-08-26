import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import { discoverPlugin } from "@paco/plugin-kit";
import { type CapabilityHandlers, PluginHost } from "./host.ts";

/**
 * Covers `PluginHost.deliverIngress` (the host<->worker ingress protocol —
 * `worker-entry.ts`'s `channels/*` loading and `handleIngress`) and
 * `api.tasks.create` (`plugin-api.ts` + `worker-entry.ts`'s `tasks`
 * namespace, routed through the same `capability-request` path every other
 * capability uses).
 *
 * Kept apart from `host.test.ts` rather than appended to it: ingress is a
 * distinct protocol surface (new message kinds, a new host method) from the
 * tool-invocation / event-fan-out surface that file already covers, and
 * `host.test.ts` is already large. The fixture helpers below are the same
 * shape as `host.test.ts`'s (`writePlugin`/`makeHost`) so a real worker
 * process is spawned against real files on disk, exactly as production
 * would.
 */

let rootDir: string;
const running: PluginHost[] = [];

/** Every fixture plugin root gets this so `.js` slot files load as ESM. */
const ESM_PACKAGE_JSON = JSON.stringify({ type: "module" });

function manifest(name: string, capabilities: Capability[]) {
  return JSON.stringify({
    name,
    version: "1.0.0",
    description: "Fixture plugin.",
    pacoApi: 1,
    capabilities,
  });
}

/**
 * Writes a real plugin directory to a tmp dir and discovers it, so the host
 * under test spawns a real worker process against real files on disk.
 */
async function writePlugin(
  name: string,
  capabilities: Capability[],
  files: Record<string, string>,
): Promise<PluginDescriptor> {
  const pluginDir = path.join(rootDir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "plugin.json"),
    manifest(name, capabilities),
  );
  await writeFile(path.join(pluginDir, "package.json"), ESM_PACKAGE_JSON);

  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(pluginDir, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  const discovered = await discoverPlugin(pluginDir);
  if (!discovered.ok) {
    throw new Error(`fixture ${name} did not discover: ${discovered.error}`);
  }
  return discovered.plugin;
}

interface HostFixtureOptions {
  descriptor: PluginDescriptor;
  grantedCapabilities: Capability[];
  handlers?: CapabilityHandlers;
  readyTimeoutMs?: number;
}

/**
 * Builds a host in NON-hardened mode — see `host.test.ts`'s `makeHost` for
 * why: these tests run under `bun test`, which has no permission model.
 */
function makeHost(options: HostFixtureOptions): PluginHost {
  const host = new PluginHost({
    descriptor: options.descriptor,
    grantedCapabilities: options.grantedCapabilities,
    netDomains: [],
    handlers: options.handlers ?? {},
    hardened: false,
    readyTimeoutMs: options.readyTimeoutMs,
  });
  running.push(host);
  return host;
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "plugin-ingress-"));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop()));
  await rm(rootDir, { recursive: true, force: true });
});

const ECHO_CHANNEL = `export default {
  name: "events",
  handle(request) {
    return {
      status: 200,
      body: {
        headers: request.headers,
        body: request.body,
        rawBody: request.rawBody,
      },
    };
  },
};
`;

describe("PluginHost deliverIngress", () => {
  test("round-trips an ingress request, preserving the exact raw body bytes", async () => {
    const descriptor = await writePlugin(
      "channel-plugin",
      ["channels:ingress"],
      {
        "channels/events.js": ECHO_CHANNEL,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });
    await host.start();

    // Deliberately irregular whitespace and non-ASCII content: JSON.parse
    // followed by JSON.stringify would normalize this away, so an exact
    // match here proves the worker used the raw string, not a
    // re-serialization of the parsed body — which is exactly what an HMAC
    // computed over the raw request (Slack's v0 scheme) needs.
    const rawBody = '{"a":   1,  "b": "café", "c": "tab\\tend"}';
    const body = JSON.parse(rawBody);

    const outcome = await host.deliverIngress(
      "events",
      { "x-test": "1" },
      body,
      rawBody,
    );

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      body: { headers: { "x-test": "1" }, body, rawBody },
    });
  });

  test("falls back to the slot file's basename when no name is exported", async () => {
    const descriptor = await writePlugin(
      "basename-channel-plugin",
      ["channels:ingress"],
      {
        "channels/webhook.js": `export default {
          handle() {
            return { status: 200, body: { ok: true } };
          },
        };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });
    await host.start();

    const outcome = await host.deliverIngress("webhook", {}, null, "");

    expect(outcome).toEqual({ ok: true, status: 200, body: { ok: true } });
  });

  test("answers 404 for an unknown channel key without crashing the worker", async () => {
    const descriptor = await writePlugin(
      "channel-plugin",
      ["channels:ingress"],
      {
        "channels/events.js": ECHO_CHANNEL,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });
    await host.start();

    const outcome = await host.deliverIngress("nope", {}, null, "");

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.status).toBe(404);
    expect(host.state).toBe("running");
  });

  test("reports a thrown channel handler error as a 500, without crashing the worker", async () => {
    const descriptor = await writePlugin(
      "boom-channel-plugin",
      ["channels:ingress"],
      {
        "channels/events.js": `export default {
        handle() {
          throw new Error("kaboom");
        },
      };
      `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });
    await host.start();

    const outcome = await host.deliverIngress("events", {}, null, "");

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.status).toBe(500);
    expect(host.state).toBe("running");
  });

  test("times out a hung channel handler and reports reason: timeout", async () => {
    const descriptor = await writePlugin(
      "hanging-channel-plugin",
      ["channels:ingress"],
      {
        "channels/events.js": `export default {
          handle() {
            return new Promise(() => {});
          },
        };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });
    await host.start();

    const outcome = await host.deliverIngress("events", {}, null, "", 200);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("timeout");
    expect(outcome.ok === false && outcome.error).toContain("timed out");
    expect(host.state).toBe("running");
  });

  test("refuses ingress in the host when channels:ingress is not granted, never reaching the worker", async () => {
    // The manifest requests channels:ingress (required by the discovery
    // rule for any plugin with a channels/ slot), but the operator's grant
    // is the intersection actually enforced — see PluginHost's constructor
    // doc comment.
    const descriptor = await writePlugin(
      "ungranted-channel-plugin",
      ["channels:ingress"],
      { "channels/events.js": ECHO_CHANNEL },
    );
    const host = makeHost({ descriptor, grantedCapabilities: [] });
    await host.start();

    const outcome = await host.deliverIngress("events", {}, null, "");

    expect(outcome).toEqual({
      ok: false,
      reason: "not-granted",
      error: `plugin ungranted-channel-plugin: capability not granted: channels:ingress`,
    });
  });

  test("reports not-running before the host has started", async () => {
    const descriptor = await writePlugin(
      "idle-channel-plugin",
      ["channels:ingress"],
      {
        "channels/events.js": ECHO_CHANNEL,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });

    const outcome = await host.deliverIngress("events", {}, null, "");

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("not-running");
  });

  test("resolves outstanding ingress calls when the worker crashes", async () => {
    const descriptor = await writePlugin(
      "crashy-channel-plugin",
      ["channels:ingress"],
      {
        "channels/events.js": `export default {
        handle() {
          // Never replies: the worker is about to be killed out from under
          // this call.
          return new Promise(() => {});
        },
      };
      `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["channels:ingress"],
    });
    await host.start();

    const pending = host.deliverIngress("events", {}, null, "", 5000);
    await host.stop();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("not-running");
  });
});

describe("PluginApi tasks.create", () => {
  const MAKE_TASK_TOOL = `export default {
    name: "make-task",
    description: "Creates a task via api.tasks.create.",
    inputSchema: {},
    async execute(input, api) {
      try {
        return await api.tasks.create(input);
      } catch (error) {
        return { denied: true, message: String(error.message) };
      }
    },
  };
  `;

  test("routes through the generic capability-request path, so a granted call reaches the handler", async () => {
    const descriptor = await writePlugin(
      "tasker-plugin",
      ["tools:register", "tasks:create"],
      { "tools/make-task.js": MAKE_TASK_TOOL },
    );
    let seenPayload: unknown;
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "tasks:create"],
      handlers: {
        "tasks:create": (_pluginId, payload) => {
          seenPayload = payload;
          return Promise.resolve({ taskId: "task-1", chatId: "chat-1" });
        },
      },
    });
    await host.start();

    const outcome = await host.invokeTool("make-task", {
      sessionId: "s1",
      title: "t",
      goal: "g",
      autoStart: true,
    });

    expect(outcome).toEqual({
      ok: true,
      output: { taskId: "task-1", chatId: "chat-1" },
    });
    expect(seenPayload).toEqual({
      sessionId: "s1",
      title: "t",
      goal: "g",
      autoStart: true,
    });
  });

  test("is denied by the host's grant check when tasks:create is not granted, and never reaches the handler", async () => {
    const descriptor = await writePlugin(
      "tasker-plugin",
      ["tools:register", "tasks:create"],
      { "tools/make-task.js": MAKE_TASK_TOOL },
    );
    let handlerCalls = 0;
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      handlers: {
        "tasks:create": () => {
          handlerCalls++;
          return Promise.resolve({ taskId: "leaked" });
        },
      },
    });
    await host.start();

    const outcome = await host.invokeTool("make-task", {
      sessionId: "s1",
      title: "t",
      goal: "g",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.output).toEqual({
      denied: true,
      message: "capability not granted: tasks:create",
    });
    expect(handlerCalls).toBe(0);
  });
});
