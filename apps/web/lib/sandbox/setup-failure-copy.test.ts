import { assertDockerUsable } from "@paco/sandbox";
import { describe, expect, test } from "bun:test";
import {
  markSetupReason,
  ProvisioningError,
  type ProvisioningFailureReason,
} from "./provisioning-errors";
import {
  classifySetupFailure,
  classifySetupFailureText,
  DOCKER_MISSING,
  DOCKER_NOT_RUNNING,
  DOCKER_PERMISSION,
  DOCKER_ROOTLESS,
  GENERIC,
  INSUFFICIENT_CPU,
  isSetupFailureRetryable,
  setupFailureMessage,
} from "./setup-failure-copy";

/**
 * The inputs below are verbatim output, captured by running the real commands
 * against Docker 29.6 and git 2.39 — not invented. That matters: every one of
 * these strings is a third-party interface, and a test written from memory
 * would pass while the product kept showing "Try again in a moment" for a
 * Docker daemon that is switched off.
 */
describe("classifySetupFailureText", () => {
  const cases: ReadonlyArray<[string, string, ProvisioningFailureReason]> = [
    ["docker binary absent", "spawn docker ENOENT", "docker-missing"],
    [
      "daemon down over tcp",
      "Cannot connect to the Docker daemon at tcp://127.0.0.1:59999. Is the docker daemon running?",
      "docker-not-running",
    ],
    [
      "daemon down over a unix socket",
      "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
      "docker-not-running",
    ],
    [
      // Measured on Ubuntu 24.04: the daemon is up, the socket is there, and
      // the calling user is simply not in the `docker` group. The socket path
      // in this sentence used to drag it into "docker-not-running", which told
      // a Linux self-hoster to start something that was already started.
      "daemon reachable but the user is not in the docker group",
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.51/version": dial unix /var/run/docker.sock: connect: permission denied',
      "docker-permission",
    ],
    [
      "the same refusal as the CLI prints it",
      "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      "docker-permission",
    ],
    [
      "the bare dial line, with no sentence around it",
      "error during connect: dial unix /var/run/docker.sock: connect: permission denied",
      "docker-permission",
    ],
    [
      // Rootless puts the container in a user namespace, so the workspace bind
      // mount comes back owned by a uid Paco cannot use. Paco does not support
      // it, and saying so is more useful than any retry.
      "rootless daemon, named by its socket",
      "Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock. Is the docker daemon running?",
      "docker-rootless",
    ],
    [
      "rootless daemon, named by rootlesskit",
      'docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error mounting "/home/paco/workspaces/app" to rootfs: rootlesskit: permission denied',
      "docker-rootless",
    ],
    [
      "rootless daemon, named by its launcher",
      "dockerd-rootless.sh: exiting; the daemon is not running as root",
      "docker-rootless",
    ],
    [
      // Nothing emits this any more — Paco pulls the image rather than refusing
      // to. Kept because a host upgraded from that version still has errors
      // phrased this way stored in `sessions.lifecycleError`, and they must
      // still classify rather than fall through to "unknown".
      "legacy wording, from before the image was pulled",
      'Sandbox image "paco-sandbox:latest" is not built. Run: docker build -t paco-sandbox:latest packages/sandbox/docker',
      "image-missing",
    ],
    [
      "image absent from any registry",
      'Error response from daemon: failed to resolve reference "docker.io/library/paco-sandbox:latest": manifest unknown',
      "image-missing",
    ],
    [
      // The failure that actually reaches users now, and the one that took
      // Docket's 0.1.0 image down: a GitHub Packages entry is private until
      // somebody makes it public, and an anonymous pull is refused outright.
      "sandbox image published but private",
      "Error response from daemon: Head https://ghcr.io/v2/stack256org/paco-sandbox/manifests/latest: denied: denied",
      "image-missing",
    ],
    [
      // Ordering guard: this matcher sits before the GitHub auth one, so a
      // clone rejected by GitHub must not be reported as a missing image.
      "github rejects the token, not the registry",
      "Failed to clone https://github.com/acme/app: fatal: Authentication failed for 'https://github.com/acme/app.git/'",
      "repo-auth-failed",
    ],
    [
      "private or deleted repository",
      "Failed to clone https://github.com/acme/app: remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found",
      "repo-not-found",
    ],
    [
      "token rejected by github",
      "Failed to clone https://github.com/acme/app: remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/app.git/'",
      "repo-auth-failed",
    ],
    [
      "full disk during clone",
      "Failed to clone https://github.com/acme/app: fatal: write error: No space left on device",
      "disk-full",
    ],
    [
      "no network",
      "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
      "network",
    ],
    [
      "clone exceeded its budget",
      "Failed to clone https://github.com/acme/app: Command timed out after 300000ms",
      "timed-out",
    ],
    /**
     * Reported from a real 2-CPU Ubuntu server. Paco asked every host for 4
     * vCPUs regardless of what it had, and Docker refuses the request outright
     * rather than clamping it.
     *
     * The request is clamped now, so nothing should produce this again. It is
     * classified anyway for the same reason `is not built` still is: a
     * provisioning failure is flattened into `sessions.lifecycleError` as a
     * plain string, so a host that hit this before upgrading still has it
     * stored, and it should read as itself rather than as the generic
     * sentence — which in this case sent a real operator to check a Docker
     * daemon that was healthy the whole time.
     */
    [
      "asked for more CPUs than the host has",
      'Step "…//runProvisioning" failed after 3 retries: (HTTP code 400) bad parameter - range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available',
      "insufficient-cpu",
    ],
    ["nothing recognisable", "something exploded", "unknown"],
  ];

  for (const [name, stderr, expected] of cases) {
    test(name, () => {
      expect(classifySetupFailureText(stderr)).toBe(expected);
    });
  }

  test("a full disk outranks the failure it causes", () => {
    // A full disk makes the clone fail with git's wording on top of the real
    // cause. "Free some space" is the only advice that helps, so it wins.
    expect(
      classifySetupFailureText(
        "fatal: could not read from remote repository: No space left on device",
      ),
    ).toBe("disk-full");
  });

  test("a missing binary outranks the daemon it would have talked to", () => {
    // "Start Docker" is useless when Docker is not installed.
    expect(classifySetupFailureText("spawn docker ENOENT")).not.toBe(
      "docker-not-running",
    );
  });

  test("a refused socket is never reported as a stopped daemon", () => {
    // The ordering bug this file exists to prevent. The daemon patterns match
    // any mention of `docker.sock`, and Docker's permission error names the
    // socket — so unless the permission matcher runs first, the single most
    // likely self-hosting failure tells the reader to start a daemon that is
    // already running. Nothing else in the file stops a reorder.
    expect(
      classifySetupFailureText(
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      ),
    ).not.toBe("docker-not-running");
  });

  test("rootless is matched before the permission refusal, not after", () => {
    // The second half of the ordering argument, and the half most likely to be
    // "tidied up": a rootless daemon refuses another user's connection in
    // exactly the same words as a missing `docker` group, so whichever matcher
    // runs first wins the string. Rootless has to win, because "add yourself
    // to the docker group" cannot fix it — Paco cannot use a rootless daemon
    // at all. Moving the permission matcher above the rootless one fails here
    // and nowhere else.
    expect(
      classifySetupFailureText(
        "permission denied while trying to connect to the Docker daemon socket at unix:///run/user/1000/docker.sock",
      ),
    ).toBe("docker-rootless");
  });

  test("a refused socket is not mistaken for a rejected git credential", () => {
    // `repo-auth-failed` matches `permission denied (publickey)`. Docker's
    // refusal must not drift into it.
    expect(
      classifySetupFailureText(
        "Got permission denied while trying to connect to the Docker daemon socket",
      ),
    ).toBe("docker-permission");
  });
});

describe("classifySetupFailure", () => {
  test("trusts a reason the thrower already decided", () => {
    expect(
      classifySetupFailure(
        new ProvisioningError("github-not-connected", "anything at all"),
      ),
    ).toBe("github-not-connected");
  });

  test("a reason survives being flattened to a string and rethrown", () => {
    // Exactly what the durable workflow does: persist `error.message`, then
    // rethrow it in a later run as a plain Error with no reason field.
    const original = new Error(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
    const persisted = original.message;
    const rethrown = new Error(persisted);

    expect(classifySetupFailure(rethrown)).toBe("docker-not-running");
  });

  test("survives a non-Error being thrown", () => {
    expect(classifySetupFailure("spawn docker ENOENT")).toBe("docker-missing");
  });
});

describe("setupFailureMessage", () => {
  test("names the cause and an action for every reason", () => {
    const reasons = [
      "archived",
      "github-not-connected",
      "docker-missing",
      "docker-not-running",
      "docker-permission",
      "docker-rootless",
      "image-missing",
      "repo-not-found",
      "repo-auth-failed",
      "disk-full",
      "network",
      "timed-out",
      "unknown",
    ] as const;

    for (const reason of reasons) {
      const message = setupFailureMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // No status codes, no stack frames, no shell of our own leaking through.
      expect(message).not.toMatch(/ENOENT|ECONNREFUSED|\bE[A-Z]{4,}\b/);
    }
  });

  test("distinguishes Docker missing from Docker stopped", () => {
    expect(DOCKER_MISSING).not.toBe(DOCKER_NOT_RUNNING);
    expect(setupFailureMessage("docker-missing")).toBe(DOCKER_MISSING);
    expect(setupFailureMessage("docker-not-running")).toBe(DOCKER_NOT_RUNNING);
  });

  test("distinguishes a stopped daemon from a refused one", () => {
    expect(DOCKER_PERMISSION).not.toBe(DOCKER_NOT_RUNNING);
    expect(setupFailureMessage("docker-permission")).toBe(DOCKER_PERMISSION);
    expect(setupFailureMessage("docker-rootless")).toBe(DOCKER_ROOTLESS);
  });

  test("no Docker copy sends a Linux self-hoster to Docker Desktop", () => {
    // The packaged install is Debian/Ubuntu plus systemd. There is no Docker
    // Desktop on that machine, and the whole point of these four sentences is
    // that they name a fix the reader can actually run.
    for (const message of [
      DOCKER_MISSING,
      DOCKER_NOT_RUNNING,
      DOCKER_PERMISSION,
      DOCKER_ROOTLESS,
    ]) {
      expect(message).not.toMatch(/docker desktop/i);
    }
  });

  test("the missing-Docker fix is the one the installer itself runs", () => {
    // `install.sh` installs docker.io from apt and `postinst` prints exactly
    // this pair for this state. A download link would send a server operator
    // somewhere Paco never sends them, and dropping the reconfigure leaves
    // Docker installed with the `paco` user still not in the `docker` group.
    expect(DOCKER_MISSING).toContain("apt-get install -y docker.io");
    expect(DOCKER_MISSING).toContain("dpkg-reconfigure paco");
  });

  test("the permission fix restarts Paco, because groups are read at start", () => {
    // Adding the group without restarting leaves the running process with its
    // old group list, so the next attempt fails identically. The restart is
    // part of the fix, and the copy has to say so.
    expect(DOCKER_PERMISSION).toContain("usermod -aG docker paco");
    expect(DOCKER_PERMISSION).toContain("systemctl restart paco");
  });

  test("the rootless message says Paco does not support it", () => {
    expect(DOCKER_ROOTLESS).toMatch(/rootless/i);
    expect(DOCKER_ROOTLESS).toMatch(/does(n't| not) support/i);
  });

  test("a host too small to run a sandbox says so, and does not blame Docker", () => {
    const copy = setupFailureMessage("insufficient-cpu");
    expect(copy).toBe(INSUFFICIENT_CPU);
    expect(copy).not.toBe(GENERIC);
    // The whole point: the generic sentence told an operator to check Docker,
    // whose daemon was fine. This one must not repeat that.
    expect(copy).not.toMatch(/check that Docker is running/i);
    expect(copy).toMatch(/CPU/i);
  });

  test("asking for more CPUs than the host has is not worth retrying", () => {
    // Nothing about pressing the button again adds a CPU.
    expect(isSetupFailureRetryable("insufficient-cpu")).toBe(false);
  });

  test("the generic message is reached only by the unknown reason", () => {
    expect(setupFailureMessage("unknown")).toBe(GENERIC);
    expect(setupFailureMessage("disk-full")).not.toBe(GENERIC);
  });
});

describe("isSetupFailureRetryable", () => {
  test("does not offer a retry for anything a retry cannot fix", () => {
    expect(isSetupFailureRetryable("docker-missing")).toBe(false);
    expect(isSetupFailureRetryable("docker-not-running")).toBe(false);
    expect(isSetupFailureRetryable("docker-permission")).toBe(false);
    expect(isSetupFailureRetryable("docker-rootless")).toBe(false);
    expect(isSetupFailureRetryable("image-missing")).toBe(false);
    expect(isSetupFailureRetryable("repo-auth-failed")).toBe(false);
    expect(isSetupFailureRetryable("archived")).toBe(false);
  });

  test("offers a retry for the transient ones", () => {
    expect(isSetupFailureRetryable("network")).toBe(true);
    expect(isSetupFailureRetryable("timed-out")).toBe(true);
    expect(isSetupFailureRetryable("unknown")).toBe(true);
  });
});

/**
 * What the durable workflow actually does to a thrown error.
 *
 * Not a guess at the wrapper's shape — this reproduces the one captured from a
 * real failed chat on this repo, whose `console.error` in `chat.ts` read:
 *
 *   Error [FatalError]: Step "step//./app/workflows/chat-sandbox-runtime//
 *   resolveChatSandboxRuntime" failed after 3 retries: Workflow run "wrun_…"
 *   failed: Step "step//./app/workflows/sandbox-provisioning//runProvisioning"
 *   failed after 3 retries: <the original message>
 *
 * Three separate reductions produce that, all in `@workflow/core`:
 *
 *   1. the step handler normalizes the throw to `{name, message, stack}`
 *      (`dist/types.js`, `normalizeUnknownError`) — the class and every field
 *      on it are gone from here on;
 *   2. it writes only a string into the `step_failed` event, prefixed with
 *      `Step "…" failed after N retries: ` (`dist/runtime/step-handler.js`);
 *   3. the workflow side rebuilds a bare `FatalError` from that string
 *      (`dist/step.js`), and awaiting a failed run's `returnValue` wraps it
 *      once more as `Workflow run "…" failed: …` (`@workflow/errors`).
 *
 * So `provisioningFailureReason` cannot answer on the far side no matter what
 * was thrown, and the message — nested two wrappers deep — is the only thing
 * left to read.
 */
function acrossTheWorkflowBoundary(error: unknown): Error {
  const normalized = error instanceof Error ? error.message : String(error);
  const inProvisioningStep = new Error(
    `Step "step//./app/workflows/sandbox-provisioning//runProvisioning" failed after 3 retries: ${normalized}`,
  );
  const inRun = new Error(
    `Workflow run "wrun_01M0YMP2YAA8BQ3Y5P5DMRJ9S6" failed: ${inProvisioningStep.message}`,
  );
  const atTheReadSite = new Error(
    `Step "step//./app/workflows/chat-sandbox-runtime//resolveChatSandboxRuntime" failed after 3 retries: ${inRun.message}`,
  );
  atTheReadSite.name = "FatalError";
  return atTheReadSite;
}

describe("a Docker preflight failure survives the workflow boundary", () => {
  async function dockerUnusable(host: {
    info(): Promise<unknown>;
  }): Promise<unknown> {
    try {
      // `retryDelaysMs: []` because the bounded retry is `assertDockerUsable`'s
      // own concern and is tested in `packages/sandbox/docker/preflight.test.ts`.
      // What matters here is the error it ends up throwing.
      await assertDockerUsable({ host, retryDelaysMs: [] });
    } catch (error) {
      return error;
    }
    throw new Error("expected assertDockerUsable to throw");
  }

  test("an unreachable daemon reaches the user as DOCKER_NOT_RUNNING, not the generic copy", async () => {
    const thrown = await dockerUnusable({
      info: () =>
        Promise.reject(
          Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
        ),
    });

    // In-process, the class still answers.
    expect(classifySetupFailure(thrown)).toBe("docker-not-running");

    // And on the far side, where it does not.
    const arrived = acrossTheWorkflowBoundary(thrown);
    expect(classifySetupFailure(arrived)).toBe("docker-not-running");
    expect(setupFailureMessage(classifySetupFailure(arrived))).toBe(
      DOCKER_NOT_RUNNING,
    );
    expect(setupFailureMessage(classifySetupFailure(arrived))).not.toBe(
      GENERIC,
    );
  });

  test("a refused socket still says permission, three wrappers deep", async () => {
    const thrown = await dockerUnusable({
      info: () =>
        Promise.reject(
          Object.assign(new Error("connect EACCES"), { code: "EACCES" }),
        ),
    });

    expect(classifySetupFailure(acrossTheWorkflowBoundary(thrown))).toBe(
      "docker-permission",
    );
  });

  test("a rootless daemon still says rootless", async () => {
    const thrown = await dockerUnusable({
      info: () =>
        Promise.resolve({
          ServerVersion: "29.1.3",
          SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
        }),
    });

    expect(classifySetupFailure(acrossTheWorkflowBoundary(thrown))).toBe(
      "docker-rootless",
    );
  });
});

/**
 * The tag, and why it is allowed to exist in a file that warns against
 * matching our own words.
 *
 * The prose above it is Docker's, and matching it is a heuristic over text
 * three layers of somebody else's code have concatenated. The tag is not text
 * anyone reads: it exists to be read back, and it is the only part of an error
 * that a rewrite of the sentence cannot silently break.
 */
describe("the reason tag outranks the text", () => {
  test("a reworded Docker sentence still classifies, because the tag remains", () => {
    // The failure mode this prevents: someone improves the wording, every
    // matcher misses, and the user gets "try again in a moment" forever.
    const reworded = markSetupReason(
      "docker-not-running",
      "The daemon could not be reached at unix:///var/run/docker.sock.",
    );

    expect(classifySetupFailureText(reworded)).toBe("docker-not-running");
  });

  test("it survives being buried under the workflow's wrapper prefixes", () => {
    const persisted = markSetupReason("image-missing", "the pull did not work");

    expect(
      classifySetupFailure(acrossTheWorkflowBoundary(new Error(persisted))),
    ).toBe("image-missing");
  });

  test("a ProvisioningError carries its reason into the string it becomes", () => {
    // `runProvisioning` persists `error.message` into `sessions.lifecycleError`
    // and `chat-sandbox-runtime.ts` reads it back in a later run with no object
    // to consult. This is that round trip.
    const original = new ProvisioningError("archived", "Session is archived");
    const persisted = original.message;

    expect(classifySetupFailureText(persisted)).toBe("archived");
  });

  test("an unknown tag is ignored rather than trusted", () => {
    // Nothing writes this, but the decoder reads text that has been through
    // three concatenations and must not invent a reason from it.
    expect(classifySetupFailureText("[paco:setup-reason=made-up]")).toBe(
      "unknown",
    );
  });
});
