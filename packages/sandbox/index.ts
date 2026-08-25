// interface
export type {
  ExecResult,
  Sandbox,
  SandboxHook,
  SandboxHooks,
  SandboxStats,
  SandboxType,
} from "./interface.ts";

// shared types
export type { Source, FileEntry, SandboxStatus } from "./types.ts";

// factory
export {
  connectSandbox,
  type SandboxState,
  type ConnectOptions,
  type SandboxConnectConfig,
} from "./factory.ts";

// git helpers
export {
  hasUncommittedChanges,
  stageAll,
  getCurrentBranch,
  getHeadSha,
  getStagedDiff,
  getChangedFiles,
  detectBinaryFiles,
  readFileContents,
  getFileModes,
  syncToRemote,
  syncToRemotePreservingChanges,
  withTemporaryGitHubAuth,
  type FileChange,
  type FileChangeStatus,
  type FileWithContent,
} from "./git.ts";

// skills (SKILL.md discovery inside a sandbox workspace)
export {
  discoverSkills,
  extractSkillBody,
  frontmatterToOptions,
  parseSkillFrontmatter,
  type SkillFrontmatter,
  type SkillMetadata,
  type SkillOptions,
  skillFrontmatterSchema,
  substituteArguments,
} from "./skills/index.ts";

// docker
export {
  connectDocker,
  DEFAULT_GIT_USER,
  DockerSandbox,
  CONTAINER_WORKDIR,
  SANDBOX_IMAGE,
  DEFAULT_PORTS,
  DEFAULT_TIMEOUT_MS,
  isSandboxContainerName,
  listSandboxContainers,
  normalizeContainerName,
  pickSandboxContainerName,
  removeSandboxContainer,
  type SandboxContainerInfo,
  toContainerName,
  workspaceRoot,
  type DockerConnectOptions,
  type DockerSandboxConfig,
  type DockerState,
} from "./docker/index.ts";

// worktree layout: one repository per session, one worktree per chat
export {
  assertPathSegment,
  CHATS_DIRNAME,
  type ChatWorktree,
  chatBranchName,
  chatDir,
  chatWorktreePath,
  ensureChatWorktree,
  // Reconciling nginx's preview config means asking Docker which host port a
  // sandbox actually published — nginx has no equivalent of Traefik's
  // label-watching, so Paco does the enumerating itself.
  listSandboxPreviewPorts,
  migrateLegacyWorkspace,
  REPO_DIRNAME,
  removeChatWorktree,
  repoDir,
} from "./docker/index.ts";
