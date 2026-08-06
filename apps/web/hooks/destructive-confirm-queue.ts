/**
 * The bookkeeping behind a one-at-a-time "are you sure?" question.
 *
 * This is deliberately free of React so the awkward part can be tested: a
 * caller `await`s an answer, and every path out — pressing the button, pressing
 * Cancel, dismissing the dialog, or a second question arriving on top of the
 * first — has to resolve that promise exactly once. A question that is left
 * hanging looks to the caller like a "no" that never comes, so the action
 * silently never happens and nothing says why.
 */

export type DestructiveConfirmRequest = {
  /** The question itself: "Compact this chat?" */
  title: string;
  /** What is lost and what survives, in words that assume no git or terminal. */
  description: string;
  /** Labels the button with the action, never "OK". */
  confirmLabel: string;
  /** Shown on that button while `run` is in flight. */
  busyLabel?: string;
  /**
   * The way out, when "Cancel" is not the most useful word for it.
   *
   * On a question like "delete this even though the work exists nowhere else?",
   * the safe answer is not an absence of action — it is a different one ("Keep
   * it"). Naming it makes the pair read as two choices rather than one action
   * and an escape hatch.
   */
  cancelLabel?: string;
  /** Red styling. On by default: most of these questions are about deletion. */
  destructive?: boolean;
  /**
   * Optional work to do while the dialog stays open, so the spinner and any
   * failure land on the dialog the person is already looking at. Resolve with a
   * readable sentence when it failed, or null when it worked.
   */
  run?: () => Promise<string | null>;
};

export type DestructiveConfirmQueue = {
  /** Ask, and resolve once the question has an answer. */
  ask: (request: DestructiveConfirmRequest) => Promise<boolean>;
  /** Answer the open question. Ignored when nothing is open. */
  settle: (confirmed: boolean) => void;
  /** The question on screen, or null. */
  current: () => DestructiveConfirmRequest | null;
};

export function createDestructiveConfirmQueue(
  onChange: (request: DestructiveConfirmRequest | null) => void,
): DestructiveConfirmQueue {
  let request: DestructiveConfirmRequest | null = null;
  let resolvePending: ((confirmed: boolean) => void) | null = null;

  const settle = (confirmed: boolean) => {
    const resolve = resolvePending;
    resolvePending = null;
    request = null;
    onChange(null);
    resolve?.(confirmed);
  };

  return {
    ask(next) {
      // A second question while one is open would strand the first `await`
      // forever. Answering it "no" is the safe resolution: nothing destructive
      // happens without someone actually pressing the button.
      resolvePending?.(false);
      resolvePending = null;

      request = next;
      onChange(next);

      return new Promise<boolean>((resolve) => {
        resolvePending = resolve;
      });
    },
    settle,
    current: () => request,
  };
}
