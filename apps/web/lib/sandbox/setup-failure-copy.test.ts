import { describe, expect, test } from "bun:test";
import {
  ProvisioningError,
  type ProvisioningFailureReason,
} from "./provisioning-errors";
import {
  classifySetupFailure,
  classifySetupFailureText,
  DOCKER_MISSING,
  DOCKER_NOT_RUNNING,
  GENERIC,
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
    // "Start Docker Desktop" is useless when Docker is not installed.
    expect(classifySetupFailureText("spawn docker ENOENT")).not.toBe(
      "docker-not-running",
    );
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

  test("the generic message is reached only by the unknown reason", () => {
    expect(setupFailureMessage("unknown")).toBe(GENERIC);
    expect(setupFailureMessage("disk-full")).not.toBe(GENERIC);
  });
});

describe("isSetupFailureRetryable", () => {
  test("does not offer a retry for anything a retry cannot fix", () => {
    expect(isSetupFailureRetryable("docker-missing")).toBe(false);
    expect(isSetupFailureRetryable("docker-not-running")).toBe(false);
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
