import { beforeEach, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));

/**
 * Preview URLs are read from GitHub deployment statuses rather than a hosting
 * provider's PR comments, so the feature works for whatever the repo actually
 * deploys with. These tests pin that reading, plus the URL hygiene that matters
 * because `environment_url` is set by whoever created the deployment.
 */

type Deployment = { id: number; payload?: unknown };
type Status = { state: string; environment_url?: unknown };

let authenticated = true;
let headSha: string | null = "sha-1";
let deployments: Deployment[] = [];
let statusesByDeployment: Record<number, Status[]> = {};
let throwOn: string | null = null;

mock.module("./gh", () => ({
  ghJson: async (args: string[]) => {
    const path = args[1] ?? "";

    if (path.includes("/pulls/")) {
      if (throwOn === "pull") {
        throw new Error("boom");
      }
      return { head: headSha ? { sha: headSha } : {} };
    }

    if (path.includes("/statuses")) {
      const id = Number(path.match(/deployments\/(\d+)\/statuses/)?.[1]);
      return statusesByDeployment[id] ?? [];
    }

    if (path.includes("/deployments")) {
      if (throwOn === "deployments") {
        throw new Error("boom");
      }
      return deployments;
    }

    return [];
  },
}));

const modulePromise = import("./deployments");

async function find() {
  const { findDeploymentUrl } = await modulePromise;
  return findDeploymentUrl({
    owner: "acme",
    repo: "repo",
    prNumber: 7,
    ...(authenticated ? { token: "ghp_test" } : {}),
  });
}

describe("findDeploymentUrl", () => {
  beforeEach(() => {
    authenticated = true;
    headSha = "sha-1";
    deployments = [];
    statusesByDeployment = {};
    throwOn = null;
  });

  test("returns the successful deployment's environment url", async () => {
    deployments = [{ id: 1 }];
    statusesByDeployment = {
      1: [{ state: "success", environment_url: "https://preview.example.com" }],
    };

    const result = await find();

    expect(result.success).toBe(true);
    expect(result.deploymentUrl).toBe("https://preview.example.com/");
    expect(result.buildingDeploymentUrl).toBeNull();
    expect(result.failedDeploymentUrl).toBeNull();
  });

  test("is not tied to any single hosting provider", async () => {
    // The old implementation only accepted *.vercel.app hostnames.
    deployments = [{ id: 1 }];
    statusesByDeployment = {
      1: [{ state: "success", environment_url: "https://app.pages.dev" }],
    };

    expect((await find()).deploymentUrl).toBe("https://app.pages.dev/");
  });

  test("reports an in-progress deployment separately", async () => {
    deployments = [{ id: 1 }];
    statusesByDeployment = {
      1: [
        { state: "in_progress", environment_url: "https://build.example.com" },
      ],
    };

    const result = await find();

    expect(result.deploymentUrl).toBeNull();
    expect(result.buildingDeploymentUrl).toBe("https://build.example.com/");
  });

  test("reports a failed deployment separately", async () => {
    deployments = [{ id: 1 }];
    statusesByDeployment = {
      1: [{ state: "failure", environment_url: "https://dead.example.com" }],
    };

    const result = await find();

    expect(result.deploymentUrl).toBeNull();
    expect(result.failedDeploymentUrl).toBe("https://dead.example.com/");
  });

  test("prefers the newest successful deployment", async () => {
    // listDeployments returns newest first.
    deployments = [{ id: 2 }, { id: 1 }];
    statusesByDeployment = {
      2: [{ state: "success", environment_url: "https://new.example.com" }],
      1: [{ state: "success", environment_url: "https://old.example.com" }],
    };

    expect((await find()).deploymentUrl).toBe("https://new.example.com/");
  });

  test("rejects non-http(s) urls", async () => {
    // Rendered as a link, so a javascript: url would be an XSS vector.
    deployments = [{ id: 1 }];
    statusesByDeployment = {
      // The hostile value is the subject of the test, not a mistake.
      // oxlint-disable-next-line no-script-url
      1: [{ state: "success", environment_url: "javascript:alert(1)" }],
    };

    expect((await find()).deploymentUrl).toBeNull();
  });

  test("ignores statuses with no url", async () => {
    deployments = [{ id: 1 }];
    statusesByDeployment = { 1: [{ state: "success" }] };

    const result = await find();

    expect(result.success).toBe(true);
    expect(result.deploymentUrl).toBeNull();
  });

  test("ignores deployments that have no status yet", async () => {
    deployments = [{ id: 1 }];
    statusesByDeployment = {};

    expect((await find()).deploymentUrl).toBeNull();
  });

  test("succeeds with no urls when the PR has no head sha", async () => {
    headSha = null;
    deployments = [{ id: 1 }];

    const result = await find();

    expect(result.success).toBe(true);
    expect(result.deploymentUrl).toBeNull();
  });

  test("fails cleanly when GitHub is not connected", async () => {
    authenticated = false;

    const result = await find();

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Connect your GitHub account in Settings, then try again.",
    );
    expect(result.deploymentUrl).toBeNull();
  });

  test("fails cleanly when the API throws", async () => {
    throwOn = "deployments";

    const result = await find();

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.deploymentUrl).toBeNull();
  });
});
