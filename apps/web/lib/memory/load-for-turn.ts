import { orgMemoryDir, projectMemoryDir, userMemoryDir } from "./paths";
import { selectMemory, renderMemorySection } from "./retrieve";
import { listMemory } from "./store";

/**
 * Load this turn's "## Memory" system-prompt section.
 *
 * Reads all three scopes, scores them against the turn's prompt, and renders
 * the survivors — the same additive-context path `store.ts`'s `listMemory`
 * already uses for a missing or unreadable directory (empty list, not an
 * error). `organizationId` is optional because a caller with no organisation
 * on hand (or, per the plan's invariants, one that failed to resolve it)
 * simply gets project+user scope instead of failing the turn.
 *
 * Never throws (see the plan's memory invariants: a failed retrieval must
 * never block or fail a turn) — any unexpected failure is logged and this
 * resolves to `undefined`, the same "nothing to add" signal as an empty
 * selection.
 */
export async function loadMemorySectionForTurn(params: {
  /** The session's repository directory — shared across a session's chats. */
  sessionRepoDir: string;
  userId: string;
  organizationId?: string;
  prompt: string;
}): Promise<string | undefined> {
  try {
    const [project, user, org] = await Promise.all([
      listMemory(projectMemoryDir(params.sessionRepoDir)),
      listMemory(userMemoryDir(params.userId)),
      params.organizationId
        ? listMemory(orgMemoryDir(params.organizationId))
        : Promise.resolve([]),
    ]);

    const selected = selectMemory({
      project,
      user,
      org,
      prompt: params.prompt,
    });

    return renderMemorySection(selected) || undefined;
  } catch (error) {
    console.error("[memory] failed to load memory for turn:", error);
    return undefined;
  }
}
