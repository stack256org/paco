/**
 * Tool rendering with a simple switch statement.
 *
 * This provides type-safe rendering of tool parts without the indirection
 * of a registry pattern. TypeScript's exhaustive checking ensures all
 * tool types are handled.
 */
import type { WebAgentUIToolPart } from "../types";
import {
  extractRenderState,
  type ToolRenderState,
} from "@paco/shared/lib/tool-state";

/**
 * All possible tool part types derived from the agent.
 */
type ToolPartType = WebAgentUIToolPart["type"];

/**
 * Extract the specific part type for a given tool part type string.
 */
type ExtractToolPart<T extends ToolPartType> = Extract<
  WebAgentUIToolPart,
  { type: T }
>;

/**
 * Props for a tool renderer component.
 */
export type ToolRendererProps<T extends ToolPartType> = {
  part: ExtractToolPart<T>;
  state: ToolRenderState;
  cwd?: string;
  onApprove?: (id: string) => void;
  onDeny?: (id: string, reason?: string) => void;
};

/**
 * Get tool name from a tool part type.
 * Handles both dynamic-tool and tool-* types.
 */
export function getToolName(part: WebAgentUIToolPart): string {
  if (part.type === "dynamic-tool") {
    return part.toolName;
  }
  // Static tools have type like "tool-read", "tool-bash", etc.
  return part.type.slice(5);
}

/**
 * The slice of an enabled plugin's discovery result that tool dispatch
 * needs: its id, and the tool names it has registered a sandboxed renderer
 * for.
 *
 * `toolNames` is derived elsewhere from `PluginDescriptor.slots.renderers`
 * (`packages/plugin-kit/discovery.ts`) — each entry is a
 * `renderers/<toolName>.html` path with the directory and extension
 * stripped — not from the manifest, since discovery, not the manifest, is
 * the source of truth for which renderer files actually exist on disk.
 */
export type PluginRendererInfo = {
  pluginId: string;
  toolNames: string[];
};

/** Where `PluginRenderer` should point its iframe for a matched tool. */
export type PluginRendererMatch = {
  pluginId: string;
  file: string;
};

/**
 * Finds the enabled plugin, if any, that registered a renderer for
 * `toolName` — by convention, a renderer file named `<toolName>.html`
 * (spec Section 2). Pure and side-effect-free so `ToolCall`'s dispatch
 * switch (`components/tool-call/tool-call.tsx`) can call it directly in
 * its `default` case: a match routes to `PluginRenderer`, no match falls
 * through to the existing generic renderer unchanged.
 *
 * The caller is responsible for only ever passing already-enabled plugins
 * here (see `getPlugin`/`listPlugins`, `apps/web/lib/db/plugins.ts`) — this
 * function does no enabling/authorization check of its own, since dispatch
 * has no way to look that up itself; it only resolves a name to a
 * candidate. The actual iframe request still goes through
 * `app/api/plugins/renderer/[pluginId]/[file]/route.ts`, which re-checks
 * the plugin is enabled server-side regardless of what this function was
 * told.
 */
export function resolvePluginRenderer(
  toolName: string,
  plugins: PluginRendererInfo[],
): PluginRendererMatch | undefined {
  const plugin = plugins.find((candidate) =>
    candidate.toolNames.includes(toolName),
  );
  if (!plugin) {
    return undefined;
  }
  return { pluginId: plugin.pluginId, file: `${toolName}.html` };
}

// Re-export extractRenderState for convenience
export { extractRenderState, type ToolRenderState };
