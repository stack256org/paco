/**
 * Orphan detection, against a real Docker daemon and a real filesystem.
 *
 * The unit tests in `classify.test.ts` prove the decision. This proves the two
 * readings that feed it: that a `paco-sbx-*` container Docker is actually
 * running is found and classified, and that a directory holding a git
 * repository is measured and probed correctly.
 *
 * Everything it creates, it removes — and it only ever creates things under a
 * temporary workspace root and under names it generated itself. Skipped
 * automatically when no Docker daemon is reachable, or when the fixture image
 * below cannot be fetched.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Docker from "dockerode";

mock.module("server-only", () => ({}));

const {
  classifyContainers,
  classifyWorkspaces,
  planReclaim,
  sessionResourceNames,
} = await import("./classify");
const { listWorkspaceDirectories, snapshotWorkspaces } =
  await import("./measure-disk");
const { probeUnsavedWork } = await import("./unsaved-work");
const { listSandboxContainers, removeSandboxContainer } =
  await import("@paco/sandbox");

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

async function run(cwd: string, command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

/**
 * Any image that will sit still. Deliberately NOT the sandbox image.
 *
 * Nothing here classifies on the image — `classify` keys on the `paco-sbx-`
 * name prefix and the `paco.sandbox` label — so using the real sandbox image
 * bought no fidelity and cost the whole file: it was hardcoded to
 * `paco-sandbox:latest`, which exists on a developer's machine and on no CI
 * runner, so every run there died with "No such image" before asserting
 * anything. A few megabytes that pull in a second keeps this honest on a
 * runner as well as a laptop.
 */
const FIXTURE_IMAGE = "busybox:latest";

/**
 * Fetched at module scope rather than in `beforeAll`, because a first pull on a
 * cold runner comfortably exceeds Bun's 5s hook timeout and the whole suite
 * then fails on the fixture rather than on anything it is testing. Top-level
 * await has no such deadline.
 *
 * Returns false rather than throwing if the pull fails, so a machine with a
 * daemon but no route to a registry skips these tests the same way a machine
 * with no daemon does.
 */
async function fixtureImageReady(docker: Docker): Promise<boolean> {
  try {
    await docker.getImage(FIXTURE_IMAGE).inspect();
    return true;
  } catch {
    // Not present — pull it.
  }
  try {
    const stream = await docker.pull(FIXTURE_IMAGE);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
    return true;
  } catch {
    return false;
  }
}

const available =
  (await dockerAvailable()) && (await fixtureImageReady(new Docker()));
const describeDocker = available ? describe : describe.skip;

describeDocker("orphan detection against real resources", () => {
  const suffix = `reaptest-${Date.now()}`;
  const liveName = `session_live-${suffix}`;
  const orphanName = `session_orphan-${suffix}`;
  const orphanContainer = `paco-sbx-${orphanName}`;

  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paco-reaping-"));
    // Every module reads the root through `workspaceRoot()`, which reads this
    // variable each call — so nothing here can touch the operator's real
    // ~/.paco/workspaces.
    process.env.PACO_WORKSPACE_ROOT = root;

    for (const name of [liveName, orphanName]) {
      const repo = path.join(root, name, "repo");
      await fs.mkdir(repo, { recursive: true });
      await run(repo, ["git", "init", "-b", "main"]);
      await run(repo, ["git", "config", "user.email", "test@paco.local"]);
      await run(repo, ["git", "config", "user.name", "Paco Test"]);
      await fs.writeFile(path.join(repo, "app.ts"), "export const x = 1;\n");
      await run(repo, ["git", "add", "-A"]);
      await run(repo, ["git", "commit", "-m", "work"]);
    }

    // Only the orphan gets something uncommitted on top of its commit.
    await fs.writeFile(
      path.join(root, orphanName, "repo", "notes.md"),
      "not committed\n",
    );

    const docker = new Docker();
    const container = await docker.createContainer({
      name: orphanContainer,
      Image: FIXTURE_IMAGE,
      Cmd: ["sleep", "infinity"],
      Labels: { "paco.sandbox": "true" },
    });
    await container.start();
  });

  afterAll(async () => {
    // Removes exactly what this test made, by the names it chose.
    try {
      await removeSandboxContainer(orphanContainer);
    } catch {
      // Already gone: the reclaim test removes it on the happy path.
    }
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
    process.env.PACO_WORKSPACE_ROOT = undefined;
  });

  test("finds the container Docker is really running, and calls it an orphan", async () => {
    const containers = await listSandboxContainers();
    expect(containers.map((c) => c.name)).toContain(orphanContainer);

    // One session row, naming the live workspace only.
    const sessions = [
      sessionResourceNames({
        id: `live-${suffix}`,
        status: "running",
        title: "Live",
        sandboxState: { type: "docker", sandboxName: liveName },
      }),
    ];

    const classified = classifyContainers(containers, sessions);
    const mine = classified.find((c) => c.name === orphanContainer);

    expect(mine?.ownership).toBe("orphaned");
    expect(mine?.running).toBe(true);
  });

  test("never classifies a container that is not Paco's", async () => {
    const containers = await listSandboxContainers();

    // Whatever else is on this machine — a database, another project's
    // services — is not in the listing at all, so it cannot be classified,
    // planned, or removed.
    expect(containers.every((c) => c.name.startsWith("paco-sbx-"))).toBe(true);
  });

  test("measures real directories and reads their real git state", async () => {
    const directories = await listWorkspaceDirectories();
    expect(directories.map((d) => d.name).sort()).toEqual(
      [liveName, orphanName].sort(),
    );

    const snapshots = await snapshotWorkspaces(directories, probeUnsavedWork);
    const orphan = snapshots.find((s) => s.name === orphanName);

    // A real measurement of a real git repository: non-zero, and du-derived.
    expect(orphan?.sizeBytes).toBeGreaterThan(0);
    expect(orphan?.unsavedWork?.trackedFiles).toBe(1);
    expect(orphan?.unsavedWork?.uncommittedFiles).toBe(1);
    expect(orphan?.unsavedWork?.hasRemote).toBe(false);
    // One commit, on no remote.
    expect(orphan?.unsavedWork?.unpushedCommits).toBe(1);
  });

  test("plans the orphan and spares the live one", async () => {
    const sessions = [
      sessionResourceNames({
        id: `live-${suffix}`,
        status: "running",
        title: "Live",
        sandboxState: { type: "docker", sandboxName: liveName },
      }),
    ];

    const snapshots = await snapshotWorkspaces(
      await listWorkspaceDirectories(),
      probeUnsavedWork,
    );
    const workspaces = classifyWorkspaces(snapshots, sessions);
    const containers = classifyContainers(
      await listSandboxContainers(),
      sessions,
    );
    const plan = planReclaim({ containers, workspaces });

    expect(plan.orphanedWorkspaces.map((w) => w.name)).toContain(orphanName);
    expect(plan.orphanedWorkspaces.map((w) => w.name)).not.toContain(liveName);
    expect(plan.orphanedContainers.map((c) => c.name)).toContain(
      orphanContainer,
    );
  });

  test("refuses to remove a container that is not Paco's", async () => {
    await expect(removeSandboxContainer("paco-pg")).rejects.toThrow(
      /not Paco's/,
    );

    // And it is still there afterwards, if it was there to begin with.
    const docker = new Docker();
    const all = await docker.listContainers({ all: true });
    const names = all.flatMap((c) => c.Names ?? []);
    expect(names.filter((n) => n === "/paco-pg").length).toBeLessThan(2);
  });

  test("removes the orphan container, and only that one", async () => {
    const before = await listSandboxContainers();

    await removeSandboxContainer(orphanContainer);

    const after = await listSandboxContainers();
    expect(after.map((c) => c.name)).not.toContain(orphanContainer);
    expect(after).toHaveLength(before.length - 1);
  });
});
