import type { SourceControlApi } from "./source-control-contract";

/**
 * The four things the panel can ask git to do, as plain async functions.
 *
 * They are here rather than inside `useSourceControl` for one reason: this is
 * the layer where "Stage" has to turn into `stageFiles(chatId, paths)` and
 * nothing else, and that mapping is exactly the kind of thing that breaks
 * silently — a button wired to the neighbouring action still looks right and
 * still spins. Outside the hook it can be called directly from a test with a
 * recording stand-in for the server, with no DOM and no React.
 *
 * Every one of them resolves; none throws. A refusal from the server and a
 * network failure both come back as a sentence in `error`, because the panel
 * shows them the same way and the difference is not the person's problem.
 */

export type MutationKind = "stage" | "unstage" | "discard";

const RUN: Record<
  MutationKind,
  (
    api: SourceControlApi,
    chatId: string,
    paths: string[],
  ) => Promise<{
    success: boolean;
    error?: string;
  }>
> = {
  stage: (api, chatId, paths) => api.stageFiles(chatId, paths),
  unstage: (api, chatId, paths) => api.unstageFiles(chatId, paths),
  discard: (api, chatId, paths) => api.discardFiles(chatId, paths),
};

const FALLBACK_ERROR: Record<MutationKind, string> = {
  stage: "Could not stage those files.",
  unstage: "Could not unstage those files.",
  discard: "Could not discard those changes.",
};

/**
 * Which of the two lists a mutation's rows are in.
 *
 * Unstage acts on rows under `STAGED CHANGES`; Stage and Discard act on rows
 * under `CHANGES`. The panel needs this to put a spinner on the row that was
 * actually clicked, and a file that is in both lists at once is the case where
 * guessing gets it wrong.
 */
export const MUTATION_TARGETS_STAGED: Record<MutationKind, boolean> = {
  stage: false,
  unstage: true,
  discard: false,
};

export async function runFileMutation(input: {
  api: SourceControlApi;
  chatId: string;
  kind: MutationKind;
  paths: string[];
}): Promise<{ error: string | null }> {
  if (input.paths.length === 0) {
    return { error: null };
  }
  try {
    const result = await RUN[input.kind](input.api, input.chatId, input.paths);
    if (result.success) {
      return { error: null };
    }
    return { error: result.error ?? FALLBACK_ERROR[input.kind] };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : FALLBACK_ERROR[input.kind],
    };
  }
}

export async function runCommit(input: {
  api: SourceControlApi;
  chatId: string;
  message: string;
}): Promise<{ error: string | null; sha: string | null }> {
  /*
   * Trimmed here as well as in the panel and again on the server. The panel's
   * check disables the button, which is a courtesy; this one is what stops a
   * keyboard shortcut or a stale click from spending a round trip to be told
   * the same thing.
   */
  const message = input.message.trim();
  if (message.length === 0) {
    return { error: "Write a commit message before committing.", sha: null };
  }
  try {
    const result = await input.api.commitStaged(input.chatId, message);
    if (result.success) {
      return { error: null, sha: result.sha ?? null };
    }
    return {
      error: result.error ?? "Could not commit the staged changes.",
      sha: null,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Could not commit the staged changes.",
      sha: null,
    };
  }
}
