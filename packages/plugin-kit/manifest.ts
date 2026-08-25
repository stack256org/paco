import { z } from "zod";
import { capabilitySchema } from "./capabilities.ts";

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const pluginManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: z.string().min(1),
    description: z.string().min(1),
    pacoApi: z.literal(1),
    capabilities: z.array(capabilitySchema).default([]),
    // required iff "net:fetch" is requested: exact hostnames, no wildcards
    netDomains: z.array(z.string().regex(/^[a-z0-9.-]+$/)).optional(),
    // MCP servers this plugin contributes (bridged to backends with mcp capability)
    mcpServers: z.record(z.string(), mcpServerSchema).optional(),
  })
  .superRefine((manifest, ctx) => {
    const wantsNetFetch = manifest.capabilities.includes("net:fetch");
    const hasNetDomains = (manifest.netDomains?.length ?? 0) > 0;

    if (wantsNetFetch && !hasNetDomains) {
      ctx.addIssue({
        code: "custom",
        path: ["netDomains"],
        message: '"net:fetch" requires a non-empty netDomains list',
      });
    }

    if (!wantsNetFetch && manifest.netDomains !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["netDomains"],
        message: 'netDomains is only allowed when "net:fetch" is requested',
      });
    }

    if (
      manifest.mcpServers !== undefined &&
      !manifest.capabilities.includes("tools:register")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mcpServers"],
        message: 'mcpServers requires the "tools:register" capability',
      });
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * Cross-checks a parsed manifest against the plugin's discovered `channels/`
 * slot: a plugin that ships one or more `channels/*.ts` files must also
 * request the `"channels:ingress"` capability.
 *
 * This cannot be one more branch inside `pluginManifestSchema`'s
 * `superRefine` above, even though it is the same shape of rule as the
 * `net:fetch`/`netDomains` and `mcpServers`/`tools:register` checks there:
 * `superRefine` only ever sees the parsed contents of `plugin.json`, and
 * whether a `channels/` directory exists is a filesystem fact that only
 * `discovery.ts` (`discoverPlugin`) has, once it has walked the plugin's
 * slots. It is still a manifest rule in every other sense — same
 * capability-requires-companion shape, same "declare it or it's rejected"
 * intent — just evaluated one layer up, at the point slots are actually
 * known. `discoverPlugin` calls this immediately after discovering
 * `slots.channels` and folds a violation into the same `{ok: false, error}`
 * result a manifest parse failure returns, so callers see one failure shape
 * either way.
 */
export function checkChannelsCapability(
  manifest: PluginManifest,
  channelSlotFiles: readonly string[],
): string | undefined {
  if (
    channelSlotFiles.length > 0 &&
    !manifest.capabilities.includes("channels:ingress")
  ) {
    return 'a plugin with a "channels/" slot must request the "channels:ingress" capability';
  }
  return undefined;
}

export function parsePluginManifest(
  json: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const result = pluginManifestSchema.safeParse(json);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  return { ok: false, error: result.error.message };
}
