import type { SkillMetadata } from "@paco/sandbox";

/**
 * Rules the agent cannot infer from the workspace.
 *
 * Stated because leaving them implicit produced the wrong result: asked for a
 * Next.js app, the agent reached for npm and, on an empty workspace, decided
 * plain HTML was simpler than the stack it had been given.
 */
const TOOLCHAIN = [
  "## Toolchain",
  "",
  "Use **pnpm** for every JavaScript and TypeScript project. Never use npm or yarn.",
  "",
  "- Install: `pnpm install` — add a package with `pnpm add <name>`",
  "- Run a script: `pnpm <script>`",
  "- Scaffold with the pnpm flag rather than letting a generator choose, e.g.",
  "  `pnpm create next-app@latest . --use-pnpm`",
  "- Commit the `pnpm-lock.yaml` it produces.",
  "",
  "If a project already has a `package-lock.json` or `yarn.lock`, convert it:",
  "delete the old lockfile and `node_modules`, then run `pnpm install`.",
  "",
  "When the user names a stack, build with that stack. Do not substitute",
  "something simpler because the workspace is empty — an empty workspace is the",
  "normal starting point, not a reason to reduce scope.",
].join("\n");

/**
 * How to start something that the user can actually open.
 *
 * The agent runs on the host while preview URLs are published from the
 * container, so a server started the obvious way is unreachable. This was not
 * hypothetical: the first app built this way ran on the host and the preview
 * showed nothing.
 */
const RUNNING_THE_APP = [
  "## Running the app",
  "",
  "Your commands run on the host. The preview URLs above are published from the",
  "sandbox container, so a server started on the host is not reachable through",
  "them. Start long-running processes inside the container:",
  "",
  "```",
  'docker exec -d <container> sh -lc "cd /workspace && pnpm dev --port 3000 --host 0.0.0.0"',
  "```",
  "",
  "Bind to `0.0.0.0` rather than localhost, or the published port refuses",
  "connections. The container name is in the Environment section above.",
].join("\n");

/**
 * What the agent can do with GitHub, and what it must not.
 *
 * Included only when the user has connected an account, because `gh` without
 * a token fails in a way that looks like a bug rather than a missing setting —
 * and an agent told a tool exists will keep trying it.
 *
 * The prohibitions are the point. The agent runs with `bypassPermissions`, so
 * nothing stops it from deleting a repository or force-pushing a shared branch
 * except being told not to. Each one is destructive and none is ever the
 * cheapest way to accomplish something the user actually asked for.
 */
const GITHUB = [
  "## GitHub",
  "",
  "The `gh` CLI is installed and already authenticated as the user. Do not run",
  "`gh auth login` — it will fail, and it is not needed.",
  "",
  "- Open a pull request: `gh pr create --fill`",
  "- Check CI: `gh run list --branch <branch>` and `gh run view <id> --log-failed`",
  "- Read an issue: `gh issue view <number>`",
  "- Inspect a repository: `gh repo view --json name,defaultBranchRef`",
  "",
  "Never run `gh repo delete`, never force-push to the default branch, and",
  "never rewrite history that has already been pushed. Push your own branch",
  "and open a pull request instead.",
].join("\n");

/**
 * Build the text appended to Claude Code's own system prompt.
 *
 * Deliberately additive: Claude Code already ships tool descriptions, safety
 * rules, and formatting conventions, so this only supplies what it cannot know
 * — the sandbox topology, preview URLs, project instructions, and the skills
 * discovered in the workspace.
 */
export function buildAppendSystemPrompt(params: {
  environmentDetails?: string;
  currentBranch?: string;
  customInstructions?: string;
  skills?: SkillMetadata[];
  /** Whether the user has connected a GitHub account. */
  hasGithubToken?: boolean;
  /**
   * Rendered "## Memory" section (see `lib/memory/retrieve.ts`'s
   * `renderMemorySection`), already scored and budget-trimmed for this turn.
   *
   * Placed right after Environment and ahead of the Toolchain rules: it is
   * context about this project/user/org, same tier as the sandbox topology,
   * not an instruction like the rules that follow it.
   */
  memorySection?: string;
}): string {
  const sections: string[] = [];

  if (params.environmentDetails) {
    sections.push(`## Environment\n\n${params.environmentDetails}`);
  }

  if (params.memorySection) {
    sections.push(params.memorySection);
  }

  sections.push(TOOLCHAIN, RUNNING_THE_APP);

  if (params.hasGithubToken) {
    sections.push(GITHUB);
  }

  if (params.currentBranch) {
    sections.push(`## Git\n\nCurrent branch: \`${params.currentBranch}\``);
  }

  const invocableSkills = (params.skills ?? []).filter(
    (skill) => !skill.options.disableModelInvocation,
  );

  if (invocableSkills.length > 0) {
    const lines = invocableSkills
      .map(
        (skill) =>
          `- \`${skill.name}\` — ${skill.description} (read \`${skill.path}/${skill.filename}\` before using it)`,
      )
      .join("\n");

    sections.push(
      `## Project skills\n\nThese skills are available in this workspace. Read a skill's file before following it.\n\n${lines}`,
    );
  }

  if (params.customInstructions) {
    sections.push(`## Project instructions\n\n${params.customInstructions}`);
  }

  return sections.join("\n\n");
}
