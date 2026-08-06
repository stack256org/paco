/**
 * Formatting shared by the instance-health cards.
 *
 * Kept separate from the cards themselves — each card has enough branching
 * over `"ok" | "unavailable"` states without also carrying number formatting.
 */

/** Money, the way the profile and conversation pages already show it. */
export function formatUsd(amount: number): string {
  if (amount >= 100) {
    return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (amount >= 0.01) {
    return `$${amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (amount > 0) {
    return "<$0.01";
  }
  return "$0.00";
}

/**
 * A duration the way an operator reads it in a queue, not a stopwatch: "3m",
 * "45s" — never fractional seconds, never a count of days for something that
 * has only been pending for minutes.
 */
export function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${Math.round(seconds / 3600)}h`;
}
