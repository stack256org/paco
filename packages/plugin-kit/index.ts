export type { Capability } from "./capabilities.ts";
export { CAPABILITIES, capabilitySchema } from "./capabilities.ts";
export type { PluginDescriptor } from "./discovery.ts";
export { discoverPlugin } from "./discovery.ts";
export type {
  ChannelAuthMode,
  ChannelDeclaration,
  PluginManifest,
} from "./manifest.ts";
export {
  CHANNEL_AUTH_MODES,
  channelAuthMode,
  channelSlotKey,
  checkChannelDeclarations,
  checkChannelsCapability,
  parsePluginManifest,
  pluginManifestSchema,
} from "./manifest.ts";
