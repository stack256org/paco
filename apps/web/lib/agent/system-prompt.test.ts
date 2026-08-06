import { describe, expect, test } from "bun:test";
import { buildAppendSystemPrompt } from "./system-prompt";

/**
 * These pin the instructions the agent cannot infer for itself. Each one exists
 * because its absence produced a concrete failure in a real run.
 */
describe("buildAppendSystemPrompt", () => {
  test("mandates pnpm and rules out npm and yarn", () => {
    // The agent reached for `npm install` unprompted, which is what filled the
    // workspace with an unignored node_modules.
    const prompt = buildAppendSystemPrompt({});

    expect(prompt).toContain("pnpm");
    expect(prompt).toContain("Never use npm or yarn");
    expect(prompt).toContain("pnpm-lock.yaml");
  });

  test("tells the agent not to downgrade the requested stack", () => {
    // Asked for Next.js on an empty workspace, it built plain HTML instead.
    const prompt = buildAppendSystemPrompt({});

    expect(prompt).toContain("build with that stack");
    expect(prompt).toContain("not a reason to reduce scope");
  });

  test("explains that servers must run inside the container", () => {
    // Started on the host, a dev server is not behind the published ports, so
    // the preview shows nothing.
    const prompt = buildAppendSystemPrompt({});

    expect(prompt).toContain("docker exec");
    expect(prompt).toContain("0.0.0.0");
  });

  test("includes the toolchain rules even with no sandbox details", () => {
    // The rules must not depend on optional context being present.
    expect(buildAppendSystemPrompt({})).toContain("## Toolchain");
  });

  test("keeps environment details ahead of the rules that reference them", () => {
    const prompt = buildAppendSystemPrompt({
      environmentDetails: "- Sandbox: Docker container `paco-sbx-abc`",
    });

    expect(prompt.indexOf("## Environment")).toBeLessThan(
      prompt.indexOf("## Toolchain"),
    );
    expect(prompt).toContain("paco-sbx-abc");
  });

  test("still appends branch, skills, and project instructions", () => {
    const prompt = buildAppendSystemPrompt({
      currentBranch: "main",
      customInstructions: "Prefer server components.",
      skills: [
        {
          name: "deploy",
          description: "Ship it",
          path: ".agents/skills/deploy",
          filename: "SKILL.md",
          options: {},
        } as never,
      ],
    });

    expect(prompt).toContain("Current branch: `main`");
    expect(prompt).toContain("Prefer server components.");
    expect(prompt).toContain("`deploy`");
  });

  test("tells the agent gh is authenticated, only once connected", () => {
    // `gh` without a token fails in a way that reads like a bug, and an agent
    // told a tool exists will keep retrying it.
    expect(buildAppendSystemPrompt({})).not.toContain("## GitHub");

    const connected = buildAppendSystemPrompt({ hasGithubToken: true });
    expect(connected).toContain("## GitHub");
    expect(connected).toContain("gh pr create");
    expect(connected).toContain("Do not run");
  });

  test("forbids the destructive gh commands bypassPermissions would allow", () => {
    // Nothing else stops it: the CLI runs with permission prompts disabled.
    const prompt = buildAppendSystemPrompt({ hasGithubToken: true });

    expect(prompt).toContain("gh repo delete");
    expect(prompt).toContain("force-push");
  });

  test("omits a skill that opted out of model invocation", () => {
    const prompt = buildAppendSystemPrompt({
      skills: [
        {
          name: "manual-only",
          description: "Not for the model",
          path: ".agents/skills/manual-only",
          filename: "SKILL.md",
          options: { disableModelInvocation: true },
        } as never,
      ],
    });

    expect(prompt).not.toContain("manual-only");
  });
});
