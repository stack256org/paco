import "server-only";

import * as path from "node:path";
import { discoverPlugin } from "@paco/plugin-kit";
import type { PluginRendererInfo } from "@/app/lib/render-tool";
import { listPlugins } from "@/lib/db/plugins";
import { pluginDir } from "@/lib/plugins/install";

/**
 * The grant a renderer needs.
 *
 * Serving plugin-authored HTML into a sandboxed iframe on Paco's origin IS
 * `ui:panel`; nothing else in the product is. Enablement is a separate
 * question — an operator can enable a plugin while denying this one
 * capability at the consent dialog, and a denied capability that keeps
 * working is worse than one that never worked.
 */
const RENDERER_CAPABILITY = "ui:panel";

/**
 * One enabled plugin's `renderers/<toolName>.html` slot, turned into the
 * `PluginRendererInfo` shape `ToolCall` (`components/tool-call/tool-call.tsx`)
 * dispatches against — the second dead-code fix from the plan's Task 12
 * brief: `pluginRenderers` had a prop and a default but no caller, so a
 * plugin's renderer never actually rendered no matter how a tool call's
 * name matched it.
 *
 * `discoverPlugin`'s `slots.renderers` is a list of absolute
 * `renderers/<toolName>.html` paths (`packages/plugin-kit/discovery.ts`);
 * this strips each down to the bare tool name. Bare is correct and must
 * stay that way: a plugin author names a renderer file after the tool they
 * registered, not after the `mcp__paco-plugins__<pluginId>__` name Claude
 * Code later exposes it under. `resolvePluginRenderer`
 * (`app/lib/render-tool.tsx`) rebuilds that full name from `pluginId` plus
 * each entry here and compares it to the incoming tool name, so this half
 * of the pair stays the file name on disk. A plugin that discovers with no
 * renderer files at all is left out entirely rather than included with an
 * empty `toolNames` — nothing downstream needs to know it exists as a
 * renderer candidate if it isn't one.
 *
 * Never throws: this is discovery, run once per page load
 * (`app/sessions/[sessionId]/chats/[chatId]/page.tsx`), and a chat page must
 * never fail to render because one plugin's directory went missing or its
 * manifest stopped parsing — the failure is logged and that plugin is
 * simply absent from the result, the same posture `pluginSkillContributions`
 * /`pluginAgentContributions` (`lib/plugins/contributions.ts`) already take.
 */
export async function enabledPluginRenderers(): Promise<PluginRendererInfo[]> {
  try {
    const rows = await listPlugins();
    // Enabled AND actually granted `ui:panel`. Filtering here is what keeps a
    // plugin whose grant was denied from contributing a renderer to the UI at
    // all; the route that serves the file checks the same grant again, since
    // its URL is directly navigable and "nothing links to it" is not a gate.
    const enabledIds = rows
      .filter(
        (row) =>
          row.enabled && row.grantedCapabilities.includes(RENDERER_CAPABILITY),
      )
      .map((row) => row.id);

    const perPlugin = await Promise.all(
      enabledIds.map(async (id): Promise<PluginRendererInfo | undefined> => {
        const discovered = await discoverPlugin(pluginDir(id));
        if (!discovered.ok) {
          console.error(
            "enabledPluginRenderers: failed to discover an enabled plugin, skipping",
            { id, error: discovered.error },
          );
          return;
        }
        const toolNames = discovered.plugin.slots.renderers.map((filePath) =>
          path.basename(filePath, path.extname(filePath)),
        );
        if (toolNames.length === 0) {
          return;
        }
        return { pluginId: id, toolNames };
      }),
    );

    return perPlugin.filter(
      (entry): entry is PluginRendererInfo => entry !== undefined,
    );
  } catch (error) {
    console.error(
      "enabledPluginRenderers: failed to load plugin renderers",
      error,
    );
    return [];
  }
}
