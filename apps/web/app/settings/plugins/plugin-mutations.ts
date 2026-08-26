import type { Capability } from "@paco/plugin-kit";
import type { PluginListRow } from "./plugin-list-row";

export type PluginActionResult = { ok: boolean; error?: string };

/**
 * Decides — and performs — what the enabled toggle means for one plugin.
 *
 * Turning it ON re-grants exactly the capabilities it already holds (never
 * more: widening a grant is `./consent-dialog.tsx`'s job, not a toggle's)
 * and starts its host; turning it OFF stops the host and marks it disabled.
 *
 * Extracted out of `PluginsPageContent` so "toggling calls the right action
 * with the right arguments" is a plain function call to test, rather than a
 * simulated click on a Base UI `Switch` — this test runner has no DOM (see
 * `agent-editor-dialog.tsx`'s docstring for the same constraint on Dialog).
 */
export async function toggleEnabled(
  plugin: PluginListRow,
  enabled: boolean,
  actions: {
    grantAndEnableAction: (input: {
      pluginId: string;
      grants: Capability[];
    }) => Promise<PluginActionResult>;
    disablePluginAction: (input: {
      pluginId: string;
    }) => Promise<PluginActionResult>;
  },
): Promise<PluginActionResult> {
  return enabled
    ? actions.grantAndEnableAction({
        pluginId: plugin.id,
        grants: plugin.grantedCapabilities,
      })
    : actions.disablePluginAction({ pluginId: plugin.id });
}

/**
 * Asks first, and only calls `remove` when the answer was yes.
 *
 * `confirm` is `useDestructiveConfirm()`'s `confirm` (or a stand-in for it
 * in a test) — a `() => Promise<boolean>` that resolves once the person has
 * answered the dialog. `remove` never runs on a "no", which is the one
 * property this function exists to prove without rendering a real
 * `ConfirmDialog`.
 */
export async function removeWithConfirm(
  pluginId: string,
  confirm: () => Promise<boolean>,
  remove: (input: { pluginId: string }) => Promise<PluginActionResult>,
): Promise<PluginActionResult | null> {
  const confirmed = await confirm();
  if (!confirmed) {
    return null;
  }
  return remove({ pluginId });
}
