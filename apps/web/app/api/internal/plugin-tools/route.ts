import { z } from "zod";
import { NOT_YOURS } from "@/lib/error-copy";
import {
  ensurePluginsStarted,
  getPluginRegistry,
} from "@/lib/plugins/registry";
import { pluginToolsToken } from "@/lib/plugins/tools-token";

/**
 * The endpoint `scripts/plugin-mcp-server.ts` calls on every `tools/call`.
 *
 * Internal: called by a process Paco spawned, on this machine — the
 * standalone MCP bridge server the CLI runs over stdio — not by a browser.
 * There is no user session to authenticate against, so it carries a bearer
 * token minted at startup and passed to the bridge server through its
 * environment, mirroring `app/api/internal/approvals/route.ts`. Without that
 * check anything able to reach localhost could invoke a plugin's tools
 * directly.
 */

const bodySchema = z.object({
  pluginId: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
});

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${pluginToolsToken()}`) {
    return Response.json({ error: NOT_YOURS }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid request body: ${parsed.error.message}` },
      { status: 400 },
    );
  }

  const { pluginId, tool, input } = parsed.data;

  // Belt-and-suspenders: the registry is normally already populated by the
  // turn that requested this MCP server in the first place, but starting it
  // here too costs nothing once it already has (ensurePluginsStarted leaves
  // an already-running host alone) and means this route works even if it is
  // ever reached before that.
  await ensurePluginsStarted();

  const host = getPluginRegistry().get(pluginId);
  if (!host) {
    return Response.json(
      { ok: false, error: `Unknown plugin "${pluginId}"` },
      { status: 404 },
    );
  }

  const outcome = await host.invokeTool(tool, input);
  return Response.json(outcome);
}
