interface PluginPostedBadgeProps {
  pluginId: string;
}

/**
 * Shown next to a user message whose `metadata.postedBy.kind === "plugin"`
 * (`lib/plugins/capability-handlers.ts`'s `messages:post` handler sets it) —
 * so the transcript makes clear the message came from a plugin's
 * `messages:post` call, not from the person using the chat.
 */
export function PluginPostedBadge({ pluginId }: PluginPostedBadgeProps) {
  return (
    <span
      className="badge badge-soft badge-sm"
      title={`Posted by the "${pluginId}" plugin`}
    >
      via {pluginId}
    </span>
  );
}
