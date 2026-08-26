import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import { discoverPlugin } from "@paco/plugin-kit";
import { PluginHost } from "./host.ts";

/**
 * What `PluginApi` actually offers plugin code, checked from inside a real
 * worker rather than by reading the type.
 *
 * The motivating case is `api.panel()`. `ui:panel` is a grantable capability
 * with real consent-screen copy ("Show a sandboxed panel it controls inside
 * the app"), and the worker exposed `api.panel(payload)` for it — but no
 * host ever implemented a `"ui:panel"` handler, so every call reached
 * `host.ts`'s "capability not available" branch and rejected, unconditionally
 * and forever. A method that can only ever reject is worse than no method:
 * a plugin author reads it, the operator grants the capability, and nothing
 * works with no way to tell that from a bug in their own code.
 *
 * There is also nothing for it to have pushed to. The only plugin-authored
 * surface that reaches a browser is the renderer iframe
 * (`components/tool-call/renderers/plugin-renderer.tsx`), which is driven
 * entirely by a tool call's own input/output and deliberately receives
 * "nothing from Paco's session, other chats, or other tool calls" — there is
 * no panel component, no server-to-browser push channel, and no panel state
 * to push into. Implementing `api.panel` would be building a feature, not
 * closing a gap.
 */

let rootDir: string;
const running: PluginHost[] = [];

const ESM_PACKAGE_JSON = JSON.stringify({ type: "module" });

async function writePlugin(
  name: string,
  capabilities: Capability[],
  files: Record<string, string>,
): Promise<PluginDescriptor> {
  const pluginDir = path.join(rootDir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: "Fixture plugin.",
      pacoApi: 1,
      capabilities,
    }),
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

/** Non-hardened for the same reason as the sibling suites: `bun test` has no permission model. */
function makeHost(descriptor: PluginDescriptor): PluginHost {
  const host = new PluginHost({
    descriptor,
    grantedCapabilities: ["tools:register", "ui:panel"],
    netDomains: [],
    handlers: {},
    hardened: false,
  });
  running.push(host);
  return host;
}

const SURFACE_TOOL = `
  export default {
    name: "api-surface",
    description: "Reports what the capability api actually offers.",
    inputSchema: { type: "object", properties: {} },
    async execute(_input, api) {
      return {
        hasPanel: typeof api.panel,
        hasKvSetSecret: typeof api.kv.setSecret,
        hasPostMessage: typeof api.postMessage,
        hasTasksCreate: typeof api.tasks.create,
      };
    },
  };
`;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "plugin-api-surface-"));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop()));
  await rm(rootDir, { recursive: true, force: true });
});

describe("the capability api handed to plugin code", () => {
  test("offers no api.panel, since ui:panel has no handler to reach", async () => {
    const descriptor = await writePlugin(
      "surface-plugin",
      ["tools:register", "ui:panel"],
      { "tools/api-surface.js": SURFACE_TOOL },
    );
    const host = makeHost(descriptor);
    await host.start();

    const outcome = (await host.invokeTool("api-surface", {})) as {
      ok: boolean;
      output: {
        hasPanel: string;
        hasKvSetSecret: string;
        hasPostMessage: string;
        hasTasksCreate: string;
      };
    };

    expect(outcome.ok).toBe(true);
    expect(outcome.output.hasPanel).toBe("undefined");
    // The capabilities that DO have handlers are still there — this is a
    // removal of one dead method, not of the api.
    expect(outcome.output.hasKvSetSecret).toBe("function");
    expect(outcome.output.hasPostMessage).toBe("function");
    expect(outcome.output.hasTasksCreate).toBe("function");
  });
});
