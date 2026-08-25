import "server-only";

import * as path from "node:path";
import { discoverPlugin } from "@paco/plugin-kit";
import type { PluginRendererInfo } from "@/app/lib/render-tool";
import { listPlugins } from "@/lib/db/plugins";
import { pluginDir } from "@/lib/plugins/install";

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
 * this strips each down to the bare tool name `resolvePluginRenderer`
 * matches on. A plugin that discovers with no renderer files at all is left
 * out entirely rather than included with an empty `toolNames` — nothing
 * downstream needs to know it exists as a renderer candidate if it isn't
 * one.
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
    const enabledIds = rows.filter((row) => row.enabled).map((row) => row.id);

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
