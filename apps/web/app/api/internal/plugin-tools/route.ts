import { z } from "zod";
import { NOT_YOURS } from "@/lib/error-copy";
import {
  ensurePluginsStarted,
  getPluginRegistry,
} from "@/lib/plugins/registry";
import { verifyPluginToolsToken } from "@/lib/plugins/tools-token";

/**
 * The endpoint `scripts/plugin-mcp-server.ts` calls on every `tools/call`.
 *
 * Internal: called by a process Paco spawned, on this machine — the
 * standalone MCP bridge server the CLI runs over stdio — not by a browser.
 * There is no user session to authenticate against, so it carries a bearer
 * token minted for exactly the plugins its bridge was built for
 * (`mintPluginToolsToken`, `lib/plugins/tools-token.ts`) and passed to the
 * bridge server through its environment.
 *
 * The token is scoped, not a single shared secret: a bearer credential good
 * for every enabled plugin would let anything holding it invoke tools on a
 * plugin it was never meant to reach, not just the ones its own bridge
 * fronts. `verifyPluginToolsToken` checks both that the token is genuine and
 * that the requested `pluginId` is inside the set it was minted for —
 * a genuine token naming a plugin outside that set is rejected with 403,
 * distinct from an invalid/expired token's 401, so the two failure modes
 * (wrong credential vs. credential used outside its scope) are
 * distinguishable in logs and in the bridge's own error handling.
 */

const bodySchema = z.object({
  pluginId: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
});

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return authorization.slice(BEARER_PREFIX.length);
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid request body: ${parsed.error.message}` },
      { status: 400 },
    );
  }

  const { pluginId, tool, input } = parsed.data;

  const verification = verifyPluginToolsToken(
    extractBearerToken(request),
    pluginId,
  );
  if (!verification.ok) {
    const status = verification.reason === "out-of-scope" ? 403 : 401;
    return Response.json({ error: NOT_YOURS }, { status });
  }

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
