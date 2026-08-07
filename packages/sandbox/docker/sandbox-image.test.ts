import { describe, expect, test } from "bun:test";
import { PUBLISHED_SANDBOX_IMAGE, resolveSandboxImage } from "./config.ts";
import { ensureSandboxImage } from "./sandbox.ts";

/**
 * The regression these cover:
 *
 * `release.yml` publishes the sandbox image to ghcr.io on every tag, but the
 * app asked Docker for the bare local name `paco-sandbox:latest` and then
 * explicitly refused to pull it — `#ensureImage` short-circuited with "is not
 * built. Run: docker build -t paco-sandbox:latest packages/sandbox/docker".
 *
 * On a host installed from the .deb that instruction is impossible: there is no
 * checkout to build from. So `apt install paco` succeeded, the UI served, and
 * the first chat failed with advice nobody could follow. The published image
 * was never fetched by anything.
 */

describe("resolveSandboxImage", () => {
  test("defaults to an image a host with no checkout can actually fetch", () => {
    expect(resolveSandboxImage({})).toBe(
      "ghcr.io/stack256org/paco-sandbox:latest",
    );
  });

  test("names a registry, so docker never resolves it against docker hub", () => {
    // The old value had no registry component. Docker expands a bare name to
    // `docker.io/library/…`, which is where "manifest unknown" came from — an
    // error that reads like a network fault rather than a missing build.
    expect(resolveSandboxImage({})).toStartWith("ghcr.io/");
  });

  test("an operator can point it at their own mirror", () => {
    expect(
      resolveSandboxImage({
        PACO_SANDBOX_IMAGE: "registry.internal/paco-sandbox:v2",
      }),
    ).toBe("registry.internal/paco-sandbox:v2");
  });

  test("a blank override falls back instead of asking docker for nothing", () => {
    // An operator who sets the variable and leaves it empty gets the default,
    // not a pull of "".
    expect(resolveSandboxImage({ PACO_SANDBOX_IMAGE: "   " })).toBe(
      PUBLISHED_SANDBOX_IMAGE,
    );
  });

  test("pins to the installed version when the package declares one", () => {
    // The image is no longer a free-floating toolchain: it has to be built to
    // tolerate an arbitrary uid, because the container runs as the host user.
    // Old app + new image, or new app + old image, both break — so an upgraded
    // host has to fetch the image matching the package it just installed rather
    // than whatever `latest` happens to be.
    expect(resolveSandboxImage({ PACO_VERSION: "0.1.2" })).toBe(
      "ghcr.io/stack256org/paco-sandbox:v0.1.2",
    );
  });

  test("an explicit image still wins over the version pin", () => {
    // An operator mirroring internally has already said exactly what they want.
    expect(
      resolveSandboxImage({
        PACO_VERSION: "0.1.2",
        PACO_SANDBOX_IMAGE: "registry.internal/paco-sandbox:pinned",
      }),
    ).toBe("registry.internal/paco-sandbox:pinned");
  });

  test("falls back to latest when no version is declared", () => {
    // Running from a checkout rather than the .deb: there is no package
    // version, and `latest` is the only sensible thing to ask for.
    expect(resolveSandboxImage({ PACO_VERSION: "  " })).toBe(
      PUBLISHED_SANDBOX_IMAGE,
    );
  });
});

/** Records what was inspected and pulled, and can fail either on demand. */
function fakeDocker(options: { hasLocally?: boolean; pullFails?: Error } = {}) {
  const pulled: string[] = [];
  const inspected: string[] = [];

  return {
    pulled,
    inspected,
    docker: {
      getImage(name: string) {
        inspected.push(name);
        return {
          inspect: () =>
            options.hasLocally
              ? Promise.resolve({})
              : Promise.reject(new Error("no such image")),
        };
      },
      pull(name: string) {
        pulled.push(name);
        if (options.pullFails) {
          return Promise.reject(options.pullFails);
        }
        return Promise.resolve({} as NodeJS.ReadableStream);
      },
      modem: {
        followProgress(
          _stream: NodeJS.ReadableStream,
          onFinished: (err: Error | null) => void,
        ) {
          onFinished(null);
        },
      },
    },
  };
}

describe("ensureSandboxImage", () => {
  test("pulls the default image when the host does not have it yet", async () => {
    // The actual bug. This is the path every freshly installed host takes on
    // its first chat, and it used to throw instead of pulling.
    const { docker, pulled } = fakeDocker({ hasLocally: false });

    await ensureSandboxImage(docker, PUBLISHED_SANDBOX_IMAGE);

    expect(pulled).toEqual([PUBLISHED_SANDBOX_IMAGE]);
  });

  test("does not pull when the image is already on the host", async () => {
    // Keeps a locally built image authoritative: a developer who builds and
    // tags it themselves must not have it silently replaced from the registry,
    // and an offline host must not be forced onto the network every chat.
    const { docker, pulled } = fakeDocker({ hasLocally: true });

    await ensureSandboxImage(docker, PUBLISHED_SANDBOX_IMAGE);

    expect(pulled).toEqual([]);
  });

  test("surfaces why a pull failed rather than swallowing it", async () => {
    const { docker } = fakeDocker({
      hasLocally: false,
      pullFails: new Error("denied: denied"),
    });

    expect(ensureSandboxImage(docker, PUBLISHED_SANDBOX_IMAGE)).rejects.toThrow(
      /denied/,
    );
  });
});
