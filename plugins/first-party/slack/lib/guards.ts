/**
 * Narrows `unknown` to a plain object. Shared by every module in this
 * plugin that reads a webhook body, a kv value, or a Slack API response --
 * none of which the plugin worker can trust the shape of.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
