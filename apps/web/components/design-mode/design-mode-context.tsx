"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acceptDesignAction,
  cancelDesignAction,
} from "@/app/sessions/[sessionId]/chats/[chatId]/design-actions";
import type { WebAgentUIMessage } from "@/app/types";
import type { DesignCandidatePreview } from "@/lib/design/candidate-preview-url";
import {
  addAnnotation,
  composeIterationPrompt,
  type DesignAnnotation,
  removeAnnotation,
  setAnnotationNote,
} from "./annotations";
import {
  designCandidateViews,
  designTurnMessageId,
} from "./candidate-progress";
import type { DesignPanelBusy, DesignPanelProps } from "./design-panel";

/**
 * All of the design panel's state, in one place.
 *
 * There is no React context here despite the file name the plan gave it: the
 * only consumer is the chat content component that also owns the composer,
 * because turning design mode on has to change the *send* — the toggle adds
 * `mode: "design"` to that one request body — and a provider whose single
 * consumer is its own parent would be plumbing with nothing at the other
 * end. Everything below the panel (`design-panel.tsx`, `candidate-frame.tsx`,
 * `annotation-chip.tsx`) takes plain props, which is what makes those three
 * testable without a DOM.
 */

/** What the composer adds to a send while design mode is on. */
export interface DesignSendBody {
  mode: "design";
  designCandidateCount: 2 | 3;
}

/**
 * How many candidates the composer asks for.
 *
 * The server is the authority (`DEFAULT_DESIGN_CANDIDATE_COUNT`, defaulted in
 * `app/api/chat/_lib/design-options.ts`), and this is not imported from
 * there: `lib/design/design-turn.ts` starts with `import "server-only"`, so
 * pulling the constant into a client component would break the build. The
 * route defaults an omitted count to the same value, so the two cannot
 * disagree about what a design turn without an explicit count means.
 */
const COMPOSER_CANDIDATE_COUNT: 2 | 3 = 3;

export interface DesignModeControllerParams {
  sessionId: string;
  chatId: string;
  /** The live transcript — the design turn's progress streams into it. */
  messages: WebAgentUIMessage[];
  candidatePreviews: DesignCandidatePreview[];
  /** Whether a turn is currently running, which disables the toggle. */
  turnInFlight: boolean;
  /** Sends a chat message, merging `extraBody` into the request body. */
  sendDesignMessage: (
    text: string,
    extraBody: Record<string, unknown>,
  ) => Promise<void>;
  /** Appends a message to the live transcript, without a round trip. */
  appendMessage: (message: WebAgentUIMessage) => void;
}

export interface DesignModeController {
  /** Whether the composer's Design toggle is on for the next send. */
  designModeEnabled: boolean;
  setDesignModeEnabled: (next: boolean) => void;
  toggleDisabled: boolean;
  /** Extra request-body fields for the next send, or `null` for a normal one. */
  sendBody: DesignSendBody | null;
  /** Props for `DesignPanel`, or `null` when there is no panel to show. */
  panelProps: DesignPanelProps | null;
}

function makeAnnotationId(): string {
  return crypto.randomUUID();
}

/**
 * Where a resolved design turn is remembered, per chat.
 *
 * The panel is anchored to the newest design turn in the transcript rather
 * than to the newest message (see `latestDesignMessage` in
 * `candidate-progress.ts`), which is what keeps Discard reachable after an
 * ordinary chat turn. The cost of that is that a design turn's parts stay in
 * the transcript forever, so "I already adopted or discarded these" has to be
 * remembered somewhere or the panel would reopen on every reload for the rest
 * of the chat's life.
 *
 * `localStorage` and not the database on purpose: the durable answer to
 * "are these candidates still there" is the worktrees on disk, and nothing
 * streams that to the browser today. Getting this wrong in the safe direction
 * means the panel reappears for a set of candidates that are already gone —
 * where Discard is an idempotent no-op and Accept fails with a clear message —
 * rather than hiding the only handle on candidates that are still on disk,
 * which is the bug this replaces.
 */
function dismissedKey(chatId: string): string {
  return `paco:design-panel-resolved:${chatId}`;
}

function readDismissedTurnId(chatId: string): string | null {
  try {
    return window.localStorage.getItem(dismissedKey(chatId));
  } catch {
    // Private mode, or storage disabled. The panel simply stays open.
    return null;
  }
}

function writeDismissedTurnId(chatId: string, turnId: string | null): void {
  try {
    if (turnId) {
      window.localStorage.setItem(dismissedKey(chatId), turnId);
    } else {
      window.localStorage.removeItem(dismissedKey(chatId));
    }
  } catch {
    // Best-effort: failing to remember a dismissal only means the panel
    // reopens on the next load, never that an action did not happen.
  }
}

export function useDesignModeController(
  params: DesignModeControllerParams,
): DesignModeController {
  const {
    sessionId,
    chatId,
    messages,
    candidatePreviews,
    turnInFlight,
    sendDesignMessage,
    appendMessage,
  } = params;

  const [designModeEnabled, setDesignModeEnabled] = useState(false);
  const [annotations, setAnnotations] = useState<DesignAnnotation[]>([]);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
    null,
  );
  const [chosenCandidate, setChosenCandidate] = useState<number | null>(null);
  const [busy, setBusy] = useState<DesignPanelBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedTurnId, setDismissedTurnId] = useState<string | null>(null);

  const turnId = designTurnMessageId(messages);

  // Restored after mount rather than in a `useState` initialiser: reading
  // storage during render would make the server-rendered markup and the first
  // client render disagree.
  useEffect(() => {
    setDismissedTurnId(readDismissedTurnId(chatId));
  }, [chatId]);

  /** Mark this turn resolved, here and for the next load of this chat. */
  const dismissTurn = useCallback(
    (id: string | null) => {
      setDismissedTurnId(id);
      writeDismissedTurnId(chatId, id);
    },
    [chatId],
  );

  const candidates = useMemo(
    () => designCandidateViews(messages, candidatePreviews),
    [messages, candidatePreviews],
  );

  // A new design turn starts from a clean slate: last turn's notes point at
  // elements in worktrees that have since been recreated.
  useEffect(() => {
    setAnnotations([]);
    setEditingAnnotationId(null);
    setChosenCandidate(null);
    setError(null);
  }, [turnId]);

  const selectedCandidate =
    chosenCandidate ??
    candidates.find((candidate) => candidate.status === "completed")?.index ??
    candidates[0]?.index ??
    1;

  const handleInspectClick = useCallback(
    (candidate: number, selector: string, text: string) => {
      const id = makeAnnotationId();
      setAnnotations((current) =>
        addAnnotation(current, { id, candidate, selector, text }),
      );
      // Straight into the input: a chip with no note says nothing, and the
      // click that created it is the moment the user knows what to write.
      setEditingAnnotationId(id);
      setChosenCandidate(candidate);
    },
    [],
  );

  const handleNoteCommit = useCallback((id: string, note: string) => {
    const trimmed = note.trim();
    setAnnotations((current) =>
      trimmed
        ? setAnnotationNote(current, id, trimmed)
        : // An empty note leaves nothing worth keeping — the chip would be a
          // selector with no instruction, which `composeIterationPrompt`
          // skips anyway.
          removeAnnotation(current, id),
    );
    setEditingAnnotationId(null);
  }, []);

  const handleRemove = useCallback((id: string) => {
    setAnnotations((current) => removeAnnotation(current, id));
    setEditingAnnotationId((editing) => (editing === id ? null : editing));
  }, []);

  const handleIterate = useCallback(async () => {
    const prompt = composeIterationPrompt(selectedCandidate, annotations);
    if (!prompt) {
      return;
    }

    setBusy("iterating");
    setError(null);
    try {
      await sendDesignMessage(prompt, {
        mode: "design",
        designCandidateCount: COMPOSER_CANDIDATE_COUNT,
        designIterateCandidate: selectedCandidate,
      });
      setAnnotations((current) =>
        current.filter(
          (annotation) => annotation.candidate !== selectedCandidate,
        ),
      );
    } catch (iterationError) {
      setError(
        iterationError instanceof Error
          ? iterationError.message
          : "We couldn't send that iteration. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }, [annotations, selectedCandidate, sendDesignMessage]);

  const handleAccept = useCallback(
    async (index: number) => {
      if (index !== 1 && index !== 2 && index !== 3) {
        return;
      }

      setBusy("accepting");
      setError(null);
      try {
        const result = await acceptDesignAction({ sessionId, chatId, index });
        if (!result.success) {
          setError(result.error);
          return;
        }
        appendMessage(result.message);
        dismissTurn(turnId);
      } catch (acceptError) {
        setError(
          acceptError instanceof Error
            ? acceptError.message
            : "We couldn't adopt that candidate. Try again.",
        );
      } finally {
        setBusy(null);
      }
    },
    [appendMessage, chatId, dismissTurn, sessionId, turnId],
  );

  const handleDiscard = useCallback(async () => {
    setBusy("discarding");
    setError(null);
    try {
      const result = await cancelDesignAction({ sessionId, chatId });
      if (!result.success) {
        setError(result.error);
        return;
      }
      dismissTurn(turnId);
    } catch (discardError) {
      setError(
        discardError instanceof Error
          ? discardError.message
          : "We couldn't discard those candidates. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }, [chatId, dismissTurn, sessionId, turnId]);

  const panelProps: DesignPanelProps | null =
    turnId && turnId !== dismissedTurnId && candidates.length > 0
      ? {
          candidates,
          annotations,
          selectedCandidate,
          editingAnnotationId,
          busy,
          error,
          onSelectCandidate: setChosenCandidate,
          onInspectClick: handleInspectClick,
          onAnnotationEditStart: setEditingAnnotationId,
          onAnnotationEditCancel: () => setEditingAnnotationId(null),
          onAnnotationNoteCommit: handleNoteCommit,
          onAnnotationRemove: handleRemove,
          onIterate: () => {
            void handleIterate();
          },
          onAccept: (index) => {
            void handleAccept(index);
          },
          onDiscard: () => {
            void handleDiscard();
          },
        }
      : null;

  return {
    designModeEnabled,
    setDesignModeEnabled,
    toggleDisabled: turnInFlight,
    sendBody: designModeEnabled
      ? { mode: "design", designCandidateCount: COMPOSER_CANDIDATE_COUNT }
      : null,
    panelProps,
  };
}
