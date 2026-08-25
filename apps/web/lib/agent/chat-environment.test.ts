import { beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test now also resolves the org roster and plugin
// contributions, both server-only and DB/filesystem-backed. Mock those out
// before importing it (dynamically, below) so this file stays hermetic and
// never touches a real Postgres client or plugin directory.
mock.module("server-only", () => ({}));

type FakeAgentDefinition = { description: string; prompt: string };

let rosterToReturn: Record<string, FakeAgentDefinition> = {};
const getRosterSpy = mock((_organizationId: string) =>
  Promise.resolve(rosterToReturn),
);
mock.module("@/lib/db/roster", () => ({
  getRoster: getRosterSpy,
}));

type FakeSkill = {
  name: string;
  description: string;
  path: string;
  filename: string;
  options: Record<string, never>;
};

let pluginAgentsToReturn: Record<string, FakeAgentDefinition> = {};
let pluginSkillsToReturn: FakeSkill[] = [];
const pluginAgentContributionsSpy = mock(() =>
  Promise.resolve(pluginAgentsToReturn),
);
const pluginSkillContributionsSpy = mock(() =>
  Promise.resolve(pluginSkillsToReturn),
);
mock.module("@/lib/plugins/contributions", () => ({
  pluginAgentContributions: pluginAgentContributionsSpy,
  pluginSkillContributions: pluginSkillContributionsSpy,
}));

const { buildChatEnvironmentDetails, resolveChatAgents, resolveChatSkills } =
  await import("./chat-environment");

function skill(name: string, description = `${name} description`): FakeSkill {
  return {
    name,
    description,
    path: `/plugins/some-plugin/skills/${name}`,
    filename: "SKILL.md",
    options: {},
  };
}

const SANDBOX_DETAILS = [
  "- Sandbox: Docker container `paco-sbx-session_abc`",
  "- Your working directory (you run here): /home/u/.paco/workspaces/session_abc",
  "- The same files inside the container: /workspace (only commands you run *in* the container see this path)",
  "",
  "- Dev server URLs (start a server on one of these ports inside the sandbox, then share the URL with the user):",
  "  - Port 3000: http://localhost:55111",
].join("\n");

function build(overrides?: { sandboxDetails?: string }) {
  return buildChatEnvironmentDetails({
    sandboxDetails: SANDBOX_DETAILS,
    worktreePath: "/home/u/.paco/workspaces/session_abc/chats/chat1",
    branch: "chat/chat1",
    ...overrides,
  });
}

describe("buildChatEnvironmentDetails", () => {
  test("names the chat's worktree as the working directory", () => {
    // The agent runs on the host, so this path decides which branch its edits
    // land on. Naming the session repository here would silently put every
    // chat's work on one branch.
    expect(build()).toContain(
      "- Your working directory (you run here): /home/u/.paco/workspaces/session_abc/chats/chat1",
    );
  });

  test("drops the session-level working directory lines", () => {
    const prompt = build();

    // Two "working directory" lines would contradict each other, and the
    // agent picked the first one it saw.
    expect(prompt).not.toContain("workspaces/session_abc\n");
    expect(
      prompt
        .split("\n")
        .filter((l) => l.startsWith("- Your working directory")),
    ).toHaveLength(1);
    expect(
      prompt
        .split("\n")
        .filter((l) => l.startsWith("- The same files inside the container")),
    ).toHaveLength(0);
  });

  test("keeps the container name and the preview URLs", () => {
    const prompt = build();

    expect(prompt).toContain("paco-sbx-session_abc");
    expect(prompt).toContain("http://localhost:55111");
  });

  test("states the branch and why the chat is isolated", () => {
    const prompt = build();

    expect(prompt).toContain("`chat/chat1`");
    expect(prompt).toContain("do not touch other chats");
  });

  test("works when the sandbox supplied no details", () => {
    const prompt = build({ sandboxDetails: undefined });

    expect(prompt).toContain(
      "/home/u/.paco/workspaces/session_abc/chats/chat1",
    );
    expect(prompt.startsWith("\n")).toBe(false);
  });
});

describe("resolveChatAgents", () => {
  beforeEach(() => {
    rosterToReturn = {};
    pluginAgentsToReturn = {};
    getRosterSpy.mockClear();
    pluginAgentContributionsSpy.mockClear();
  });

  test("carries roster agents from a mocked getRoster", async () => {
    rosterToReturn = { explorer: { description: "d", prompt: "p" } };

    const agents = await resolveChatAgents("org-1");

    expect(getRosterSpy).toHaveBeenCalledWith("org-1");
    expect(agents.explorer).toEqual({ description: "d", prompt: "p" });
  });

  test("a disabled agent is absent from the resolved roster", async () => {
    // `getRoster` already excludes disabled rows (see roster.test.ts);
    // resolveChatAgents must not reintroduce one that neither the roster
    // nor a plugin currently provides.
    rosterToReturn = { explorer: { description: "d", prompt: "p" } };
    pluginAgentsToReturn = {};

    const agents = await resolveChatAgents("org-1");

    expect(agents.designer).toBeUndefined();
    expect(Object.keys(agents)).toEqual(["explorer"]);
  });

  test("keeps a plugin agent that has no roster counterpart", async () => {
    pluginAgentsToReturn = { helper: { description: "plugin", prompt: "p" } };
    rosterToReturn = {};

    const agents = await resolveChatAgents("org-1");

    expect(agents.helper).toEqual({ description: "plugin", prompt: "p" });
  });

  test("DB roster wins over a plugin contribution with the same name", async () => {
    pluginAgentsToReturn = {
      reviewer: { description: "plugin version", prompt: "plugin prompt" },
    };
    rosterToReturn = {
      reviewer: { description: "org version", prompt: "org prompt" },
    };

    const agents = await resolveChatAgents("org-1");

    expect(agents.reviewer).toEqual({
      description: "org version",
      prompt: "org prompt",
    });
  });
});

describe("resolveChatSkills", () => {
  beforeEach(() => {
    pluginSkillsToReturn = [];
    pluginSkillContributionsSpy.mockClear();
  });

  test("returns the workspace skills unchanged when no plugin contributes any", async () => {
    const workspaceSkills = [skill("deploy")];

    const result = await resolveChatSkills(workspaceSkills);

    expect(result).toEqual(workspaceSkills);
  });

  test("appends plugin skills after the workspace's own", async () => {
    const workspaceSkills = [skill("deploy")];
    pluginSkillsToReturn = [skill("format")];

    const result = await resolveChatSkills(workspaceSkills);

    expect(result.map((s) => s.name)).toEqual(["deploy", "format"]);
  });

  test("the workspace skill wins a name collision with a plugin skill", async () => {
    const workspaceSkills = [skill("deploy", "workspace description")];
    pluginSkillsToReturn = [skill("deploy", "plugin description")];

    const result = await resolveChatSkills(workspaceSkills);

    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("workspace description");
  });
});
