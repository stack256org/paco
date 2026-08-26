/**
 * Integration tests for the Docker sandbox.
 *
 * These talk to a real Docker daemon. They are skipped automatically when one
 * isn't reachable, and skipped entirely unless PACO_DOCKER_INTEGRATION=1 —
 * see the note above `describeDocker` for why.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Docker from "dockerode";
import { CONTAINER_WORKDIR } from "./config.ts";
import { connectDocker } from "./connect.ts";
import { repoDir } from "./layout.ts";
import { DockerSandbox } from "./sandbox.ts";
import { ensureChatWorktree, removeChatWorktree } from "./worktree.ts";

/** Run git on the host, where the agent actually runs. */
async function hostGit(cwd: string, args: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args.split(" ")], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return (out.trim() || err.trim()).trim();
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * These were opt-in for one release, because they could not pass on Linux: the
 * container ran as root while Paco runs unprivileged, so on a bind mount
 * ownership disagreed in both directions — anything the container created was
 * root-owned and the host could not write it, and anything the host created was
 * host-owned and git inside the container refused it as "dubious ownership".
 * Fixing one direction moved the failure to the other.
 *
 * The container now runs as the host's uid:gid, which is the only arrangement
 * where both sides can read and write the same tree, so they are back on by
 * default and CI is where they are expected to pass.
 */
const available = await dockerAvailable();
const describeDocker = available ? describe : describe.skip;

describeDocker("DockerSandbox", () => {
  const name = `test-${Date.now()}`;
  let workspace: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    workspace = path.join(os.tmpdir(), `paco-sbx-test-${Date.now()}`);
    sandbox = await DockerSandbox.create({
      name,
      hostWorkspace: workspace,
      ports: [3000],
      timeout: 120_000,
    });
  }, 300_000);

  afterAll(async () => {
    await sandbox?.destroy();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 120_000);

  test("executes commands inside the container", async () => {
    const result = await sandbox.exec("echo hello", CONTAINER_WORKDIR, 30_000);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  }, 60_000);

  test("runs commands in a Linux container, not on the host", async () => {
    const result = await sandbox.exec("uname -s", CONTAINER_WORKDIR, 30_000);

    // Proves isolation: the host running these tests is macOS (Darwin).
    expect(result.stdout.trim()).toBe("Linux");
  }, 60_000);

  test("reports a non-zero exit code without throwing", async () => {
    const result = await sandbox.exec("exit 3", CONTAINER_WORKDIR, 30_000);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  }, 60_000);

  test("captures stderr separately from stdout", async () => {
    const result = await sandbox.exec(
      "echo out; echo err 1>&2",
      CONTAINER_WORKDIR,
      30_000,
    );

    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  }, 60_000);

  test("shares the workspace between host and container", async () => {
    await sandbox.writeFile("shared.txt", "from-host", "utf-8");

    // Written through the host filesystem, read back from inside the container.
    const result = await sandbox.exec(
      "cat shared.txt",
      CONTAINER_WORKDIR,
      30_000,
    );

    expect(result.stdout.trim()).toBe("from-host");
  }, 60_000);

  test("sees container-side writes on the host", async () => {
    await sandbox.exec(
      "echo from-container > out.txt",
      CONTAINER_WORKDIR,
      30_000,
    );

    expect((await sandbox.readFile("out.txt", "utf-8")).trim()).toBe(
      "from-container",
    );
  }, 60_000);

  test("creates parent directories when writing", async () => {
    await sandbox.writeFile("nested/deep/file.txt", "ok", "utf-8");

    expect((await sandbox.stat("nested/deep/file.txt")).isFile()).toBe(true);
  }, 60_000);

  test("rejects paths that escape the workspace", async () => {
    expect(sandbox.readFile("../../../etc/passwd", "utf-8")).rejects.toThrow(
      /escapes the sandbox workspace/,
    );
  });

  test("runs commands in container directories outside the workspace", async () => {
    // File I/O happens on the host, so it is confined to the workspace. Command
    // execution happens inside the container, where `/tmp` is an ordinary
    // directory — the editor launcher and other tooling rely on it.
    const result = await sandbox.exec("pwd", "/tmp", 30_000);

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("/tmp");
  }, 60_000);

  test("runs a workspace-relative command at the workspace path", async () => {
    await sandbox.writeFile("mapped/marker.txt", "mapped-ok", "utf-8");

    // The workspace is mounted at its host path as well as at /workspace, so
    // a host path is directly usable inside the container — no translation.
    const result = await sandbox.exec(
      "cat marker.txt",
      path.join(workspace, "mapped"),
      30_000,
    );

    expect(result.stdout.trim()).toBe("mapped-ok");
  }, 60_000);

  test("publishes a reachable preview URL", () => {
    expect(sandbox.domain(3000)).toMatch(/^http:\/\/localhost:\d+$/);
  });

  test("throws for a port that was never published", () => {
    expect(() => sandbox.domain(9999)).toThrow(/not published/);
  });

  test("honors the command timeout", async () => {
    const result = await sandbox.exec("sleep 10", CONTAINER_WORKDIR, 1000);

    expect(result.success).toBe(false);
    expect(result.stderr).toContain("timed out");
  }, 60_000);

  test("reconnects to the same container by name", async () => {
    const again = await DockerSandbox.create({
      name,
      hostWorkspace: workspace,
      ports: [3000],
    });

    // Same name must resolve to the same container, which is what makes
    // session resume work across restarts.
    expect(again.getState().containerId).toBe(sandbox.getState().containerId);
  }, 120_000);

  // ── Worktrees ────────────────────────────────────────────────────────────
  //
  // A session is one repository; each chat is a worktree of it on its own
  // branch. These run against real git, because the parts most likely to
  // break — relative worktree paths, branch reuse, the empty-repository case —
  // are exactly the parts a stubbed `exec` cannot tell you about.

  test("bootstraps the repository into repo/, not the workspace root", async () => {
    const inRepo = await sandbox.exec(
      "git rev-parse --is-inside-work-tree",
      repoDir(workspace),
      30_000,
    );
    expect(inRepo.stdout.trim()).toBe("true");

    const atRoot = await sandbox.exec(
      "test -e .git && echo yes || echo no",
      CONTAINER_WORKDIR,
      30_000,
    );
    expect(atRoot.stdout.trim()).toBe("no");
  }, 60_000);

  test("writes the baseline .gitignore inside repo/", async () => {
    const contents = await sandbox.readFile("repo/.gitignore", "utf-8");
    expect(contents).toContain("node_modules/");
  }, 60_000);

  test("gives a chat its own worktree on its own branch", async () => {
    const worktree = await ensureChatWorktree(sandbox, workspace, "chatone");

    expect(worktree.path).toBe(path.join(workspace, "chats", "chatone"));
    expect(worktree.branch).toBe("chat/chatone");

    const branch = await sandbox.exec(
      "git rev-parse --abbrev-ref HEAD",
      worktree.path,
      30_000,
    );
    expect(branch.stdout.trim()).toBe("chat/chatone");
  }, 120_000);

  test("isolates one chat's changes from another's", async () => {
    const one = await ensureChatWorktree(sandbox, workspace, "chatone");
    const two = await ensureChatWorktree(sandbox, workspace, "chattwo");

    await sandbox.exec(
      "echo 'from chat one' > only-in-one.txt",
      one.path,
      30_000,
    );

    // The whole point of worktrees: chats stop stepping on each other.
    const leaked = await sandbox.exec(
      "test -e only-in-one.txt && echo yes || echo no",
      two.path,
      30_000,
    );
    expect(leaked.stdout.trim()).toBe("no");

    const branchTwo = await sandbox.exec(
      "git rev-parse --abbrev-ref HEAD",
      two.path,
      30_000,
    );
    expect(branchTwo.stdout.trim()).toBe("chat/chattwo");
  }, 120_000);

  // The agent runs on the *host* while these commands run in the container.
  // `git worktree add` writes absolute paths into its two pointer files, so a
  // worktree created in the container is unusable from the host unless those
  // paths are made relative — which is precisely what broke the first
  // end-to-end run.
  test("creates a worktree that works from the host too", async () => {
    const worktree = await ensureChatWorktree(sandbox, workspace, "chathost");

    // The pointer git bakes in must name a path that exists on the host, not
    // just inside the container.
    const gitFile = await fs.readFile(
      path.join(workspace, worktree.relativePath, ".git"),
      "utf-8",
    );
    expect(gitFile.trim()).toBe(
      `gitdir: ${path.join(workspace, "repo", ".git", "worktrees", "chathost")}`,
    );

    // The real check: git on the host, which knows nothing about /workspace,
    // must be able to resolve the worktree and report its branch.
    const branch = await hostGit(
      path.join(workspace, worktree.relativePath),
      "rev-parse --abbrev-ref HEAD",
    );
    expect(branch).toBe("chat/chathost");

    // git 2.39 marks a worktree it cannot resolve as prunable, and the next
    // `git worktree prune` deletes the link. Both sides must resolve it.
    const list = await hostGit(path.join(workspace, "repo"), "worktree list");
    expect(list).not.toContain("prunable");

    const containerList = await sandbox.exec(
      "git worktree list",
      repoDir(workspace),
      30_000,
    );
    expect(containerList.stdout).not.toContain("prunable");
  }, 120_000);

  test("returns the same worktree on a repeat call", async () => {
    const first = await ensureChatWorktree(sandbox, workspace, "chatone");
    await sandbox.exec("echo keep > survives.txt", first.path, 30_000);

    const second = await ensureChatWorktree(sandbox, workspace, "chatone");
    expect(second).toEqual(first);

    const survived = await sandbox.exec(
      "test -e survives.txt && echo yes || echo no",
      second.path,
      30_000,
    );
    expect(survived.stdout.trim()).toBe("yes");
  }, 120_000);

  test("restores a chat's branch after its worktree is removed", async () => {
    const before = await ensureChatWorktree(sandbox, workspace, "chatthree");
    await sandbox.exec("echo committed > tracked.txt", before.path, 30_000);
    await sandbox.exec("git add -A", before.path, 30_000);
    await sandbox.exec('git commit -m "work"', before.path, 30_000);

    await removeChatWorktree(sandbox, workspace, "chatthree");
    const gone = await sandbox.exec(
      "test -d chats/chatthree && echo yes || echo no",
      CONTAINER_WORKDIR,
      30_000,
    );
    expect(gone.stdout.trim()).toBe("no");

    // The commits must still be reachable — removing a worktree frees disk,
    // it does not discard work.
    const after = await ensureChatWorktree(sandbox, workspace, "chatthree");
    const restored = await sandbox.exec("cat tracked.txt", after.path, 30_000);
    expect(restored.stdout.trim()).toBe("committed");
  }, 120_000);
});

/**
 * A session started from a GitHub repository has to actually contain it.
 *
 * This is a regression test for a bug that made every such session come up
 * empty, with no error anywhere: `DockerSandbox.create` bootstrapped the
 * workspace by running `git init` in `repo/`, and `prepareSource` — which
 * runs after it — treats an existing git directory as "already cloned" and
 * returns. So the clone was skipped, always, and the user got a workspace
 * with an empty repository and an empty file tree.
 *
 * It is asserted against a real clone rather than a mocked `exec` because the
 * defect was entirely in the ORDER two real operations ran in; a test that
 * stubbed either one would have passed throughout.
 */
describeDocker("connectDocker with a source", () => {
  const name = `test-clone-${Date.now()}`;
  let workspace: string;
  let sandbox: Awaited<ReturnType<typeof connectDocker>>;

  beforeAll(async () => {
    workspace = path.join(os.tmpdir(), `paco-sbx-clone-${Date.now()}`);
    sandbox = await connectDocker(
      {
        sandboxName: name,
        hostWorkspace: workspace,
        source: {
          repo: "https://github.com/octocat/Hello-World",
          branch: "master",
        },
      },
      {
        gitUser: { name: "Paco Test", email: "test@example.com" },
        timeout: 120_000,
      },
    );
  }, 300_000);

  afterAll(async () => {
    await sandbox?.stop?.();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 120_000);

  test("clones the repository into repo/", async () => {
    const repo = repoDir(workspace);

    // The upstream file, not just "a git directory exists" — an empty
    // `git init` would satisfy the weaker check, which is exactly how this
    // shipped broken.
    const entries = await fs.readdir(repo);
    expect(entries).toContain("README");

    const log = await hostGit(repo, "log --oneline -1");
    expect(log).not.toBe("");
    expect(log).not.toContain("does not have any commits yet");
  }, 120_000);

  test("does not leave the clone credential in the remote", async () => {
    const remote = await hostGit(repoDir(workspace), "remote get-url origin");

    expect(remote).toBe("https://github.com/octocat/Hello-World");
    expect(remote).not.toContain("x-access-token");
  }, 60_000);

  test("still applies the baseline gitignore the bootstrap would have", async () => {
    // The clone path skips the repo half of `#bootstrapWorkspace`, so this
    // has to be applied on the far side of the clone or a cloned repo with no
    // rules of its own regains the 650k-line-diff problem.
    const gitignore = await fs.readFile(
      path.join(repoDir(workspace), ".gitignore"),
      "utf-8",
    );

    expect(gitignore).toContain("node_modules");
  }, 60_000);
});
