import { describe, expect, test } from "bun:test";
import {
  classifyDockerInfoError,
  DockerUnusableError,
  dockerEndpoint,
  dockerPreflight,
  isRootlessInfo,
  readSecurityOptions,
  assertDockerUsable,
} from "./preflight.ts";

/**
 * What these cover, and what they cannot.
 *
 * The classification is covered here, against `docker info` payloads copied
 * from real daemons. What is *not* covered by any test is the consequence —
 * that a rootless daemon breaks the workspace — because reproducing it needs a
 * Linux host with `/etc/subuid` and a rootless daemon, and neither CI nor a
 * developer's Mac has one.
 *
 * That half was verified by hand instead, on Ubuntu 24.04: `/etc/subuid`
 * carries `ubuntu:100000:65536`, a process claiming `uid=106 gid=109` inside
 * the namespace wrote a file owned by `uid=100106 gid=100109` outside it, and
 * `paco` is uid 106 — so the service could not read back its own workspace,
 * and writing into a normally-permissioned directory failed with
 * `Permission denied`. The rootful path on the same host was healthy end to
 * end: Docker 29.1.3 active, `paco` in the `docker` group, the image pulled,
 * a uid-matched container's file landing as `paco:paco`.
 */

/** `docker info` from the rootful daemon `install.sh` installs. */
const ROOTFUL_INFO = {
  ServerVersion: "29.1.3",
  SecurityOptions: [
    "name=apparmor",
    "name=seccomp,profile=builtin",
    "name=cgroupns",
  ],
};

/** The same call against a rootless daemon. */
const ROOTLESS_INFO = {
  ServerVersion: "29.1.3",
  SecurityOptions: [
    "name=seccomp,profile=builtin",
    "name=rootless",
    "name=cgroupns",
  ],
};

function hostReturning(info: unknown) {
  return { info: () => Promise.resolve(info) };
}

function hostRejecting(error: unknown) {
  return { info: () => Promise.reject(error) };
}

function socketError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("readSecurityOptions", () => {
  test("splits the comma-joined entries every daemon reports", () => {
    expect(readSecurityOptions(ROOTFUL_INFO)).toEqual([
      "name=apparmor",
      "name=seccomp",
      "profile=builtin",
      "name=cgroupns",
    ]);
  });

  test("a payload with no SecurityOptions is empty, not a crash", () => {
    expect(readSecurityOptions({})).toEqual([]);
    expect(readSecurityOptions(null)).toEqual([]);
    expect(readSecurityOptions("not an info payload")).toEqual([]);
    expect(readSecurityOptions({ SecurityOptions: "name=rootless" })).toEqual(
      [],
    );
  });
});

describe("isRootlessInfo", () => {
  test("rootless present", () => {
    expect(isRootlessInfo(ROOTLESS_INFO)).toBe(true);
  });

  test("rootless absent", () => {
    expect(isRootlessInfo(ROOTFUL_INFO)).toBe(false);
  });

  test("a daemon that joined rootless to another option still counts", () => {
    expect(
      isRootlessInfo({ SecurityOptions: ["name=rootless,someday=else"] }),
    ).toBe(true);
  });

  test("does not match on a substring of another option", () => {
    expect(isRootlessInfo({ SecurityOptions: ["name=rootlessish"] })).toBe(
      false,
    );
  });
});

describe("classifyDockerInfoError", () => {
  test("EACCES on the socket is a permission problem, not a stopped daemon", () => {
    // The packaged install's most common failure: the daemon is up, and the
    // `paco` user is not in the `docker` group (or the service has not
    // restarted since it was added).
    expect(
      classifyDockerInfoError(
        socketError("EACCES", "connect EACCES /var/run/docker.sock"),
      ),
    ).toBe("docker-permission");
  });

  test("EPERM counts too", () => {
    expect(
      classifyDockerInfoError(socketError("EPERM", "operation not permitted")),
    ).toBe("docker-permission");
  });

  test("a 403 from a daemon that answered is a permission problem", () => {
    expect(
      classifyDockerInfoError(
        Object.assign(new Error("forbidden"), { statusCode: 403 }),
      ),
    ).toBe("docker-permission");
  });

  test("Docker's own permission wording classifies even with no code", () => {
    expect(
      classifyDockerInfoError(
        new Error(
          "permission denied while trying to connect to the Docker daemon socket",
        ),
      ),
    ).toBe("docker-permission");
  });

  test("a missing socket is a daemon that is not running", () => {
    expect(
      classifyDockerInfoError(
        socketError("ENOENT", "connect ENOENT /var/run/docker.sock"),
      ),
    ).toBe("docker-not-running");
  });

  test("a refused connection is a daemon that is not running", () => {
    expect(
      classifyDockerInfoError(
        socketError(
          "ECONNREFUSED",
          "connect ECONNREFUSED /var/run/docker.sock",
        ),
      ),
    ).toBe("docker-not-running");
  });

  test("something that is not an error at all does not throw", () => {
    expect(classifyDockerInfoError(undefined)).toBe("docker-not-running");
    expect(classifyDockerInfoError("nope")).toBe("docker-not-running");
  });
});

describe("dockerEndpoint", () => {
  test("DOCKER_HOST wins when set, because docker-modem honours it", () => {
    expect(
      dockerEndpoint({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" }),
    ).toBe("unix:///run/user/1000/docker.sock");
  });

  test("falls back to the system-wide socket", () => {
    // `docker-modem@5.0.7/lib/modem.js:80` probes `$HOME/.docker/run/docker.sock`
    // and then this. `$XDG_RUNTIME_DIR/docker.sock` — the rootless socket — is
    // never probed at all, which is why a rootless-only host reads as
    // "not running" rather than "rootless".
    expect(dockerEndpoint({})).toBe("unix:///var/run/docker.sock");
    expect(dockerEndpoint({ DOCKER_HOST: "   " })).toBe(
      "unix:///var/run/docker.sock",
    );
  });
});

describe("dockerPreflight", () => {
  test("a rootful daemon is usable", async () => {
    const result = await dockerPreflight({ host: hostReturning(ROOTFUL_INFO) });

    expect(result.state).toBe("ok");
    expect(result.usable).toBe(true);
    expect(result.serverVersion).toBe("29.1.3");
  });

  test("a rootless daemon is refused, and says which state it is in", async () => {
    const result = await dockerPreflight({
      host: hostReturning(ROOTLESS_INFO),
    });

    expect(result.state).toBe("docker-rootless");
    expect(result.usable).toBe(false);
    expect(result.securityOptions).toContain("name=rootless");
  });

  test("an unreachable daemon reads as not running", async () => {
    const result = await dockerPreflight({
      host: hostRejecting(
        socketError("ENOENT", "connect ENOENT /var/run/docker.sock"),
      ),
    });

    expect(result.state).toBe("docker-not-running");
    expect(result.usable).toBe(false);
  });

  test("a refused socket reads as a permission problem", async () => {
    const result = await dockerPreflight({
      host: hostRejecting(
        socketError("EACCES", "connect EACCES /var/run/docker.sock"),
      ),
    });

    expect(result.state).toBe("docker-permission");
    expect(result.usable).toBe(false);
  });

  test("a daemon that never answers is not a usable daemon", async () => {
    // dockerode sets no timeout of its own. Without this the health page waits
    // forever on a wedged socket.
    const result = await dockerPreflight({
      host: { info: () => new Promise<unknown>(() => undefined) },
      timeoutMs: 5,
    });

    expect(result.state).toBe("docker-not-running");
  });
});

/**
 * The seam with `apps/web/lib/sandbox/setup-failure-copy.ts`.
 *
 * A provisioning failure is flattened into `sessions.lifecycleError` as a
 * plain string and rethrown later as a plain `Error`, so the `state` field
 * does not survive the durable workflow — `classifySetupFailureText` reads the
 * message instead. These pin the literals that classifier keys on. If one of
 * them is reworded out of the message, the failure reaches the user as the
 * generic "try again in a moment", which is wrong forever for all three.
 */
describe("messages classify on the far side of the workflow", () => {
  test("rootless names dockerd-rootless, which the web matcher keys on", async () => {
    const result = await dockerPreflight({
      host: hostReturning(ROOTLESS_INFO),
    });

    expect(result.message.toLowerCase()).toContain("dockerd-rootless");
  });

  test("permission uses Docker's own wording", async () => {
    const result = await dockerPreflight({
      host: hostRejecting(socketError("EACCES", "connect EACCES")),
    });

    expect(result.message.toLowerCase()).toContain(
      "permission denied while trying to connect",
    );
  });

  test("not running asks the question the daemon matcher looks for", async () => {
    const result = await dockerPreflight({
      host: hostRejecting(socketError("ENOENT", "connect ENOENT")),
    });

    expect(result.message.toLowerCase()).toContain(
      "is the docker daemon running",
    );
  });

  test("no failure message trips the docker-missing matcher, which runs first", async () => {
    // `/spawn docker enoent|docker: (command )?not found|enoent.*\bdocker\b/`
    // is matched ahead of every daemon pattern. A message that embedded the
    // raw socket error would hit it and tell the reader to install a Docker
    // that is already installed.
    for (const host of [
      hostRejecting(
        socketError("ENOENT", "connect ENOENT /var/run/docker.sock"),
      ),
      hostRejecting(
        socketError("EACCES", "connect EACCES /var/run/docker.sock"),
      ),
      hostReturning(ROOTLESS_INFO),
    ]) {
      const result = await dockerPreflight({ host });
      expect(result.message.toLowerCase()).not.toContain("enoent");
      expect(result.message.toLowerCase()).not.toContain("not found");
    }
  });
});

describe("assertDockerUsable", () => {
  test("returns the result when the daemon is fine", async () => {
    const result = await assertDockerUsable({
      host: hostReturning(ROOTFUL_INFO),
    });

    expect(result.state).toBe("ok");
  });

  test("throws before a chat creates anything, carrying the state as a field", async () => {
    let thrown: unknown;
    try {
      await assertDockerUsable({ host: hostReturning(ROOTLESS_INFO) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DockerUnusableError);
    expect((thrown as DockerUnusableError).state).toBe("docker-rootless");
  });
});
