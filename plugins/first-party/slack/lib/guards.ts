/**
 * Narrows `unknown` to a plain object. Shared by every module in this
 * plugin that reads a webhook body, a kv value, or a Slack API response --
 * none of which the plugin worker can trust the shape of.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Narrows `unknown` to an array of strings.
 *
 * kv values round-trip through `jsonb`, so a stored allowlist comes back as
 * `unknown` and has to be re-checked before it is used to decide who may
 * start an agent turn. A value that is not a string array is not an empty
 * allowlist — the caller treats it as "no allowlist configured" or refuses,
 * never as "allow everyone".
 */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
