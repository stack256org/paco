const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Bytes as an operator reads them.
 *
 * Base 1024 with the short unit names, matching what `du -h`, Finder's "on
 * disk" figure and Docker all show — the numbers on this page have to be
 * checkable against the terminal, and a page that says 1.6 GB where `du` says
 * 1.5 invites the reader to trust neither.
 *
 * One decimal place from a megabyte up, none below: "1.5 GB" is a real
 * difference to act on, "1.5 KB" is noise.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const decimals = unit >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

/** "1 container" / "3 containers", so no sentence ever reads "1 containers". */
export function pluralize(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}
