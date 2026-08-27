import { describe, expect, test } from "bun:test";
import {
  classifyDockerInfoError,
  clampCpus,
  DockerUnusableError,
  dockerEndpoint,
  dockerPreflight,
  isRootlessInfo,
  readCpuCount,
  readSecurityOptions,
  resolveDockerSocket,
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

  test("falls back to the system-wide socket when no per-user one exists", () => {
    // `docker-modem@5.0.7/lib/modem.js:80` probes `$HOME/.docker/run/docker.sock`
    // and then this. `$XDG_RUNTIME_DIR/docker.sock` — the rootless socket — is
    // never probed at all, which is why a rootless-only host reads as
    // "not running" rather than "rootless".
    //
    // Written through `resolveDockerSocket` with the probe injected. This used
    // to assert `dockerEndpoint({})` directly and pass only by luck: it
    // asserted the fallback on a machine that has no per-user socket, and
    // failed the moment it was run on one that does — which is the same trap
    // the message now diagnoses, arriving in the test suite first.
    expect(resolveDockerSocket({}, () => false, "/home/paco").endpoint).toBe(
      "unix:///var/run/docker.sock",
    );
    expect(
      resolveDockerSocket({ DOCKER_HOST: "   " }, () => false, "/home/paco")
        .endpoint,
    ).toBe("unix:///var/run/docker.sock");
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

/**
 * The socket dockerode picks, and the trap in how it picks it.
 *
 * `resolveDockerSocket` is a reimplementation of another package's private
 * behaviour, so these are written against
 * `docker-modem@5.0.7/lib/modem.js` — `defaultOpts` and
 * `findDefaultUnixSocket`, read, not remembered. If modem ever changes the
 * rule, this is the test that should fail.
 */
describe("resolveDockerSocket", () => {
  const nothingExists = () => false;
  const everythingExists = () => true;

  test("DOCKER_HOST wins outright, and nothing is probed", () => {
    const resolved = resolveDockerSocket(
      { DOCKER_HOST: "tcp://10.0.0.2:2375" },
      () => {
        throw new Error(
          "must not probe the filesystem when DOCKER_HOST is set",
        );
      },
      "/home/paco",
    );

    expect(resolved).toEqual({
      endpoint: "tcp://10.0.0.2:2375",
      fromEnv: true,
    });
  });

  test("a bare unix:// is treated as unset, exactly as modem does", () => {
    const resolved = resolveDockerSocket(
      { DOCKER_HOST: "unix://" },
      nothingExists,
      "/home/paco",
    );

    expect(resolved.endpoint).toBe("unix:///var/run/docker.sock");
    expect(resolved.fromEnv).toBe(false);
  });

  test("the system socket, on the host shape a packaged install has", () => {
    const resolved = resolveDockerSocket({}, nothingExists, "/home/paco");

    expect(resolved).toEqual({
      endpoint: "unix:///var/run/docker.sock",
      fromEnv: false,
    });
  });

  test("a per-user socket wins on existence alone, and the shadowed one is named", () => {
    // The reproduced developer-Mac trap: ~/.docker/run/docker.sock is a dead
    // Docker Desktop leftover, /var/run/docker.sock is a live OrbStack daemon,
    // and modem picks the dead one because the file is there.
    const resolved = resolveDockerSocket({}, everythingExists, "/Users/dev");

    expect(resolved).toEqual({
      endpoint: "unix:///Users/dev/.docker/run/docker.sock",
      fromEnv: false,
      shadowed: "/var/run/docker.sock",
    });
  });

  test("no shadow is reported when only the per-user socket exists", () => {
    const resolved = resolveDockerSocket(
      {},
      (path) => path === "/Users/dev/.docker/run/docker.sock",
      "/Users/dev",
    );

    expect(resolved.shadowed).toBeUndefined();
  });

  test("dockerEndpoint is that resolution, so the message names what was tried", () => {
    expect(dockerEndpoint({ DOCKER_HOST: "unix:///custom/docker.sock" })).toBe(
      "unix:///custom/docker.sock",
    );
  });
});

/**
 * The tag is the carrier the sentence cannot be.
 *
 * `apps/web/lib/sandbox/provisioning-errors.ts` reads `[paco:setup-reason=…]`
 * back out of whatever wrapped text reaches it; this package cannot import
 * that module, so the literal is pinned on both sides. The web-side test
 * (`setup-failure-copy.test.ts`) proves the round trip through a step failure.
 */
describe("every failure message carries its reason as a tag", () => {
  const env = { DOCKER_HOST: "unix:///var/run/docker.sock" };

  test.each([
    [
      "docker-not-running",
      hostRejecting(socketError("ENOENT", "connect ENOENT")),
    ],
    [
      "docker-permission",
      hostRejecting(socketError("EACCES", "connect EACCES")),
    ],
    ["docker-rootless", hostReturning(ROOTLESS_INFO)],
  ] as const)("%s", async (state, host) => {
    const result = await dockerPreflight({ host, env });

    expect(result.state).toBe(state);
    expect(result.message).toContain(`[paco:setup-reason=${state}]`);
  });

  test("a healthy daemon is not tagged — there is no failure to carry", async () => {
    const result = await dockerPreflight({
      host: hostReturning(ROOTFUL_INFO),
      env,
    });

    expect(result.message).not.toContain("paco:setup-reason");
  });
});

describe("the message names the socket dockerode actually tried", () => {
  test("DOCKER_HOST is quoted back, so the reader can check it", async () => {
    const result = await dockerPreflight({
      host: hostRejecting(socketError("ENOENT", "connect ENOENT")),
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
    });

    expect(result.message).toContain("unix:///run/user/1000/docker.sock");
  });
});

/**
 * Counts calls so a retry is provable rather than inferred from timing.
 */
function hostFailingThenAnswering(
  failures: number,
  info: unknown,
): { info: () => Promise<unknown>; calls: () => number } {
  let calls = 0;
  return {
    info: () => {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(socketError("ENOENT", "connect ENOENT"));
      }
      return Promise.resolve(info);
    },
    calls: () => calls,
  };
}

function countingHost(result: () => Promise<unknown>): {
  info: () => Promise<unknown>;
  calls: () => number;
} {
  let calls = 0;
  return {
    info: () => {
      calls += 1;
      return result();
    },
    calls: () => calls,
  };
}

/**
 * The bounded retry, and — more importantly — what is excluded from it.
 *
 * Delays are passed as zeros here; the production bound lives in
 * `TRANSIENT_RETRY_DELAYS_MS` and is argued at its definition. What these pin
 * is the shape: three probes at most, and only for the one verdict that can
 * change on its own.
 */
describe("assertDockerUsable retries only a socket that might come back", () => {
  const noWait = { retryDelaysMs: [0, 0] };

  test("a daemon that appears a moment late is not a failed turn", async () => {
    const host = hostFailingThenAnswering(1, ROOTFUL_INFO);

    const result = await assertDockerUsable({ host, ...noWait });

    expect(result.state).toBe("ok");
    expect(host.calls()).toBe(2);
  });

  test("the bound is three probes, and the third answer is final", async () => {
    const host = countingHost(() =>
      Promise.reject(socketError("ENOENT", "connect ENOENT")),
    );

    let thrown: unknown;
    try {
      await assertDockerUsable({ host, ...noWait });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DockerUnusableError);
    expect((thrown as DockerUnusableError).state).toBe("docker-not-running");
    expect(host.calls()).toBe(3);
  });

  test("docker-permission fails on the first answer — retrying is pure latency", async () => {
    // The daemon answered and refused. Supplementary groups are read once, at
    // process start, so nothing here can change while this process runs.
    const host = countingHost(() =>
      Promise.reject(socketError("EACCES", "connect EACCES")),
    );

    let thrown: unknown;
    try {
      await assertDockerUsable({ host, ...noWait });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as DockerUnusableError).state).toBe("docker-permission");
    expect(host.calls()).toBe(1);
  });

  test("docker-rootless fails on the first answer — the host will not stop being rootless", async () => {
    const host = countingHost(() => Promise.resolve(ROOTLESS_INFO));

    let thrown: unknown;
    try {
      await assertDockerUsable({ host, ...noWait });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as DockerUnusableError).state).toBe("docker-rootless");
    expect(host.calls()).toBe(1);
  });

  test("a probe that timed out is not probed again", async () => {
    // It already spent the whole timeout. Two more of those would add twenty
    // seconds to a turn that is failing regardless.
    const host = countingHost(() => new Promise<unknown>(() => undefined));

    let thrown: unknown;
    try {
      await assertDockerUsable({ host, timeoutMs: 5, ...noWait });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as DockerUnusableError).state).toBe("docker-not-running");
    expect(host.calls()).toBe(1);
  });
});

/**
 * How many CPUs the daemon says it has, and what that means for a container.
 *
 * Docker refuses `NanoCpus` above the host's CPU count outright — it is a 400
 * from the API, not a warning and not a silent clamp:
 *
 *   (HTTP code 400) bad parameter - range of CPUs is from 0.01 to 2.00,
 *   as there are only 2 CPUs available
 *
 * Paco asked every host for 4 regardless, so no machine with fewer than four
 * CPUs could create a sandbox at all. Reported from a real 2-CPU Ubuntu server
 * running Docker 29.1.3, where every other part of the install was healthy.
 *
 * The count comes from the daemon rather than `os.cpus()` because the daemon
 * is the thing enforcing the limit, and it is not always this machine.
 */
describe("readCpuCount", () => {
  test("reads NCPU from a real info payload", () => {
    expect(readCpuCount({ ...ROOTFUL_INFO, NCPU: 2 })).toBe(2);
  });

  test("is undefined when the daemon did not report it", () => {
    expect(readCpuCount(ROOTFUL_INFO)).toBeUndefined();
  });

  test("is undefined for a value that is not a usable count", () => {
    expect(readCpuCount({ NCPU: "2" })).toBeUndefined();
    expect(readCpuCount({ NCPU: 0 })).toBeUndefined();
    expect(readCpuCount({ NCPU: -1 })).toBeUndefined();
    expect(readCpuCount({ NCPU: Number.NaN })).toBeUndefined();
    expect(readCpuCount(null)).toBeUndefined();
    expect(readCpuCount("nope")).toBeUndefined();
  });

  test("dockerPreflight carries it through", async () => {
    const result = await dockerPreflight({
      host: { info: () => Promise.resolve({ ...ROOTFUL_INFO, NCPU: 2 }) },
    });
    expect(result.state).toBe("ok");
    expect(result.cpuCount).toBe(2);
  });
});

describe("clampCpus", () => {
  test("leaves a request the host can satisfy alone", () => {
    expect(clampCpus(4, 8)).toBe(4);
  });

  test("allows exactly the host's count", () => {
    expect(clampCpus(4, 4)).toBe(4);
    expect(clampCpus(2, 2)).toBe(2);
  });

  /** The reported failure: 4 requested, 2 available. */
  test("clamps a request the host cannot satisfy", () => {
    expect(clampCpus(4, 2)).toBe(2);
    expect(clampCpus(4, 1)).toBe(1);
  });

  /**
   * Passing through is deliberate. An unknown count is not evidence of a small
   * host, and inventing a limit would quietly shrink every sandbox on a daemon
   * whose info payload we simply failed to read.
   */
  test("passes the request through when the count is unknown or nonsense", () => {
    expect(clampCpus(4, undefined)).toBe(4);
    expect(clampCpus(4, 0)).toBe(4);
    expect(clampCpus(4, -2)).toBe(4);
    expect(clampCpus(4, Number.NaN)).toBe(4);
  });

  test("does not round a fractional host count up past what Docker allows", () => {
    // A cgroup-limited daemon can report a fractional count; Docker still
    // refuses anything above it.
    expect(clampCpus(4, 1.5)).toBe(1.5);
  });
});
