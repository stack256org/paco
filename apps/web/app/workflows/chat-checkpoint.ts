import { connectSandbox, type SandboxState } from "@paco/sandbox";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { type Checkpoint, createCheckpoint } from "@/lib/git/checkpoint";

/**
 * Take a restore point for the turn that is about to run.
 *
 * The post-turn counterpart is `runTurnSnapshotStep` in `chat-post-finish.ts`;
 * both write commit objects under `refs/paco/turns/<chatId>/` and neither
 * touches the branch, the index, or the working tree.
 *
 * A workflow step because it touches the sandbox and `node:path`, neither of
 * which the workflow function itself can reach.
 *
 * Never throws. A checkpoint is a safety net, and a net that can stop the turn
 * it is protecting is worse than no net — a failure here costs the revert
 * control on one turn, which is strictly better than costing the turn.
 */
export async function takeChatCheckpoint(params: {
  sandboxState: SandboxState;
  chatId: string;
}): Promise<Checkpoint | null> {
  "use step";

  try {
    const sandbox = await connectSandbox(params.sandboxState);
    const cwd = resolveWorkCwd(params.sandboxState, params.chatId);
    return await createCheckpoint(sandbox, cwd, params.chatId);
  } catch (error) {
    console.error(
      `[checkpoint] Could not take a checkpoint for chat ${params.chatId}:`,
      error,
    );
    return null;
  }
}
