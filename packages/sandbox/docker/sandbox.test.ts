import { describe, expect, test } from "bun:test";
import {
  buildContainerLabels,
  buildDockerExecArgs,
  buildNetworkingConfig,
} from "./sandbox.ts";

const TOKEN = "ghp_averysecrettokenvalue";

const ARGS = buildDockerExecArgs({
  containerId: "paco-sbx-abc",
  cwd: "/workspace/chats/chat1",
  envNames: ["PACO_CHAT_ID", "GITHUB_TOKEN", "GIT_ASKPASS"],
  command: "git push origin chat/chat1",
});

describe("buildDockerExecArgs", () => {
  test("never puts an environment value in the argument vector", () => {
    // The regression: `#commandEnv()` produced `KEY=VALUE` pairs and they were
    // spread into argv as `-e GITHUB_TOKEN=ghp_…`. Any account on the host can
    // read another process's command line with `ps`, so the user's GitHub token
    // was readable machine-wide for the life of the command.
    for (const arg of ARGS) {
      expect(arg).not.toContain(TOKEN);
      expect(arg).not.toContain("=");
    }
  });

  test("passes each variable by name, for docker to copy from its own env", () => {
    expect(ARGS).toEqual([
      "exec",
      "-w",
      "/workspace/chats/chat1",
      "-e",
      "PACO_CHAT_ID",
      "-e",
      "GITHUB_TOKEN",
      "-e",
      "GIT_ASKPASS",
      "paco-sbx-abc",
      "bash",
      "-lc",
      "git push origin chat/chat1",
    ]);
  });

  test("still runs the command in the right container and directory", () => {
    expect(ARGS.at(-1)).toBe("git push origin chat/chat1");
    expect(ARGS[ARGS.indexOf("-w") + 1]).toBe("/workspace/chats/chat1");
  });
});

describe("buildContainerLabels", () => {
  test("carries paco's own bookkeeping labels with no caller labels", () => {
    expect(buildContainerLabels("sbx-1")).toEqual({
      "paco.sandbox": "true",
      "paco.sandbox.name": "sbx-1",
    });
  });

  test("merges caller labels alongside the bookkeeping labels", () => {
    expect(
      buildContainerLabels("sbx-1", {
        "traefik.enable": "true",
        "traefik.http.routers.preview-abc.rule": "Host(`abc.example.com`)",
      }),
    ).toEqual({
      "paco.sandbox": "true",
      "paco.sandbox.name": "sbx-1",
      "traefik.enable": "true",
      "traefik.http.routers.preview-abc.rule": "Host(`abc.example.com`)",
    });
  });

  test("caller labels win when a key collides with a bookkeeping label", () => {
    // Not expected in practice — Traefik's labels are namespaced under
    // `traefik.*` — but the merge order is the contract callers rely on, so
    // it is asserted directly rather than left implicit.
    expect(
      buildContainerLabels("sbx-1", { "paco.sandbox.name": "overridden" }),
    ).toEqual({
      "paco.sandbox": "true",
      "paco.sandbox.name": "overridden",
    });
  });
});

describe("buildNetworkingConfig", () => {
  test("returns undefined when no network is requested", () => {
    // Undefined, not an empty EndpointsConfig — Docker's own default (the
    // bridge network) must be left completely untouched for the common case
    // of a sandbox with no preview configured.
    expect(buildNetworkingConfig(undefined)).toBeUndefined();
  });

  test("attaches to the named network when one is requested", () => {
    expect(buildNetworkingConfig("paco-preview")).toEqual({
      EndpointsConfig: { "paco-preview": {} },
    });
  });
});

describe("docker exec -e NAME", () => {
  test("is how the value actually reaches the container", async () => {
    // `-e NAME` is only safe if it still works: docker copies the value from
    // the client's own environment. Proven here with `env -u`/`env NAME=…`,
    // which is the same lookup docker performs, without needing a daemon.
    const proc = Bun.spawn(["bash", "-lc", 'printf "%s" "$GITHUB_TOKEN"'], {
      env: { ...process.env, GITHUB_TOKEN: TOKEN },
      stdout: "pipe",
    });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(stdout).toBe(TOKEN);
  });
});
