/**
 * Quote a value so a POSIX shell reads it as one literal argument.
 *
 * Every sandbox command is a *string*: `sandbox.exec` runs `bash -lc <command>`,
 * so anything interpolated into it is shell source, not data.
 *
 * `JSON.stringify` looks like quoting and is not. Double quotes leave `$VAR`,
 * `` `cmd` `` and `$(cmd)` live, and they encode a newline as the two
 * characters `\` and `n`. A commit message of ``fix: use `printf hi` here`` was
 * therefore executed — the commit landed as `fix: use hi here` — and every
 * multi-line commit body arrived flattened onto the subject line with a literal
 * `\n` in it. That message can be written by the model and
 * committed without a human reading it first.
 *
 * Single quotes suppress every expansion bash has. The one character that
 * cannot appear between them is the single quote itself, so it is closed,
 * escaped and reopened: the standard `'"'"'` dance.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
