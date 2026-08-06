/**
 * Quote a value for `bash -lc`.
 *
 * The sandbox runs commands through a shell, so any path that reaches `exec`
 * has to arrive as a single word no matter what it contains. Single quotes
 * suppress every expansion bash performs; the only character they cannot carry
 * is a single quote itself, which is closed, escaped, and reopened.
 *
 * Never interpolate a caller-supplied path into a command without this.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
