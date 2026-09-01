import { instanceMemoryDir, projectMemoryDir } from "./paths";
import { renderMemorySection, selectMemory } from "./retrieve";
import { listMemory } from "./store";

/**
 * Load this turn's "## Memory" system-prompt section.
 *
 * Reads both scopes, scores them against the turn's prompt, and renders the
 * survivors — the same additive-context path `store.ts`'s `listMemory`
 * already uses for a missing or unreadable directory (empty list, not an
 * error).
 *
 * `sessionRepoDir` is optional: it is resolved from the sandbox state on
 * every turn, and a caller for whom that resolution failed still has
 * instance scope to fall back on — instance scope is unrelated to the repo
 * directory, so only project scope drops out.
 *
 * Never throws (see the plan's memory invariants: a failed retrieval must
 * never block or fail a turn) — any unexpected failure is logged and this
 * resolves to `undefined`, the same "nothing to add" signal as an empty
 * selection.
 */
export async function loadMemorySectionForTurn(params: {
  /** The session's repository directory — shared across a session's chats. */
  sessionRepoDir?: string;
  prompt: string;
}): Promise<string | undefined> {
  try {
    const [project, instance] = await Promise.all([
      params.sessionRepoDir
        ? listMemory(projectMemoryDir(params.sessionRepoDir))
        : Promise.resolve([]),
      listMemory(instanceMemoryDir()),
    ]);

    const selected = selectMemory({
      project,
      instance,
      prompt: params.prompt,
    });

    return renderMemorySection(selected) || undefined;
  } catch (error) {
    console.error("[memory] failed to load memory for turn:", error);
    return undefined;
  }
}
