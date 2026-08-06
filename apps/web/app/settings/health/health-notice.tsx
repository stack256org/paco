import { AlertTriangle, CircleAlert, HelpCircle } from "lucide-react";

/**
 * The three tones a card ever needs: quiet, wrong, or unknown.
 *
 * There is no "good" tone on purpose — a healthy state reads as plain text
 * with no alert box at all, so this list only has the tones a card reaches
 * for when there is something to say.
 */
export type HealthTone = "warning" | "error" | "unavailable";

/**
 * Complete class strings, chosen by a switch — never assembled from a
 * variable, so Tailwind's scanner sees every class it needs to keep.
 */
const TONE_CLASSES: Record<HealthTone, string> = {
  warning: "alert alert-warning alert-soft",
  error: "alert alert-error alert-soft",
  // Deliberately not `alert-warning`: an unavailable metric is not a known
  // problem, it is a gap. Giving it the same color as a real warning would
  // make "we don't know" look exactly like "we know it's bad".
  unavailable: "alert alert-soft",
};

const TONE_ICONS: Record<HealthTone, typeof AlertTriangle> = {
  warning: AlertTriangle,
  error: CircleAlert,
  unavailable: HelpCircle,
};

/**
 * A card's "something is wrong, or unknown" banner.
 *
 * Every card leads with this — or nothing at all when there is nothing to
 * report — never with a banner celebrating a healthy state. See the module
 * doc on each card for why.
 */
export function HealthNotice({
  tone,
  children,
}: {
  tone: HealthTone;
  children: React.ReactNode;
}) {
  const Icon = TONE_ICONS[tone];
  return (
    <div className={TONE_CLASSES[tone]} role="alert">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** The one sentence every "unavailable" metric shows — never a bare gap. */
export function UnavailableNotice({ reason }: { reason: string }) {
  return (
    <HealthNotice tone="unavailable">
      Unavailable — {reason} This is unknown, not zero.
    </HealthNotice>
  );
}
