/**
 * The display name for a better-auth user.
 *
 * `username` is a required additional field on the user table, so it is
 * normally present; `name` is the fallback for a row written before that field
 * existed. This lived as a private copy in each of the two modules that build a
 * `Session` — identical down to the whitespace, which is how they stayed in
 * step by luck rather than by construction.
 */
export function extractUsername(user: {
  name?: string | null;
  [key: string]: unknown;
}): string {
  if (typeof user.username === "string" && user.username) {
    return user.username;
  }
  return user.name ?? "";
}
