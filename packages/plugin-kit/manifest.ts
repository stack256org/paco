import { z } from "zod";
import { capabilitySchema } from "./capabilities.ts";

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

/**
 * How the ingress route authenticates an inbound request for one channel,
 * declared per channel because different providers need different things:
 *
 * - `"shared-secret"` (default): the route itself checks
 *   `x-paco-channel-secret` against `plugins.ingressSecret` before the
 *   worker ever sees the request — unchanged from the original design.
 * - `"self-verified"`: the route skips that check and forwards the request
 *   (raw body + headers) to the channel handler unauthenticated; the
 *   handler verifies it itself. This exists because some real providers —
 *   Slack's Event Subscriptions UI is the motivating case — have no way to
 *   attach a custom header to their webhook, and instead sign the raw body
 *   (Slack's `x-slack-signature` / `x-slack-request-timestamp` HMAC).
 *   `self-verified` does NOT skip the operator's `channels:ingress` grant
 *   check or the plugin-running check — only the shared-secret comparison.
 */
export const CHANNEL_AUTH_MODES = ["shared-secret", "self-verified"] as const;
export type ChannelAuthMode = (typeof CHANNEL_AUTH_MODES)[number];

/**
 * The key a `channels/*` slot file is addressed by when its module exports
 * no `name` override: the file's basename, minus a `.ts`/`.js` extension.
 * Shared between `discovery.ts` (which only ever sees the file path, never
 * the module) and `@paco/plugin-host`'s `worker-entry.ts` (which uses the
 * exported `name` when one exists, and falls back to exactly this), so the
 * two never derive different keys for the same file.
 */
export function channelSlotKey(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  return base.replace(/\.(js|ts)$/, "");
}

/**
 * One `channels/*` slot's declared identity and auth mode. `name` must
 * match the slot file's key — its basename, since discovery never executes
 * plugin code to read an exported `name` override (see
 * `checkChannelDeclarations` below).
 */
const channelDeclarationSchema = z.object({
  name: z.string().min(1),
  auth: z.enum(CHANNEL_AUTH_MODES),
});
export type ChannelDeclaration = z.infer<typeof channelDeclarationSchema>;

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
    /**
     * Per-channel auth mode declarations. Optional, and sparse: a
     * `channels/*` slot file with no entry here defaults to
     * `"shared-secret"` (see `channelAuthMode`) — this field only exists for
     * a channel that needs to opt into `"self-verified"`, which the operator
     * must see on the consent screen (this is what the manifest is for)
     * rather than a plugin quietly deciding it for itself in code.
     */
    channels: z.array(channelDeclarationSchema).optional(),
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

    if (manifest.channels !== undefined) {
      const seen = new Set<string>();
      for (const [index, channel] of manifest.channels.entries()) {
        if (seen.has(channel.name)) {
          ctx.addIssue({
            code: "custom",
            path: ["channels", index, "name"],
            message: `duplicate channel declaration: "${channel.name}"`,
          });
        }
        seen.add(channel.name);
      }
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

/**
 * Cross-checks the manifest's `channels` auth declarations against the
 * plugin's discovered `channels/` slot keys (each slot file's basename,
 * minus its extension — `discovery.ts` derives these the same way
 * `worker-entry.ts`'s `loadChannels` falls back to when a module exports no
 * `name`, since discovery never executes plugin code and so can never see
 * that override).
 *
 * Only checked in one direction, deliberately: a declared channel with no
 * matching slot file is rejected here — declaring `"self-verified"` for a
 * channel that does not exist would otherwise silently do nothing — but a
 * slot file with no declaration is NOT an error. It defaults to
 * `"shared-secret"` (`channelAuthMode`), so a plugin only needs this field
 * at all when a channel wants to opt into `"self-verified"`.
 */
export function checkChannelDeclarations(
  manifest: PluginManifest,
  channelSlotKeys: readonly string[],
): string | undefined {
  const declared = manifest.channels;
  if (!declared || declared.length === 0) {
    return undefined;
  }

  const slotKeys = new Set(channelSlotKeys);
  for (const channel of declared) {
    if (!slotKeys.has(channel.name)) {
      return `manifest declares channel "${channel.name}" with no matching "channels/" slot file`;
    }
  }
  return undefined;
}

/**
 * The auth mode the ingress route must use for one channel. Defaults to
 * `"shared-secret"` for any channel the manifest does not mention — see
 * `channels`' doc comment on `pluginManifestSchema`.
 */
export function channelAuthMode(
  manifest: PluginManifest,
  channel: string,
): ChannelAuthMode {
  return (
    manifest.channels?.find((declaration) => declaration.name === channel)
      ?.auth ?? "shared-secret"
  );
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
