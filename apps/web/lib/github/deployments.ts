import "server-only";

import { ghJson } from "./gh";
import { GITHUB_NOT_CONNECTED } from "@/lib/error-copy";

/**
 * Preview-deployment discovery.
 *
 * This used to scrape the Vercel bot's pull-request comments and match hostnames
 * against `*.vercel.app`, which tied the feature to one host. GitHub's
 * Deployments API is the provider-neutral equivalent: anything that deploys a
 * branch — Vercel, Netlify, Cloudflare Pages, Render, or a self-hosted pipeline
 * — reports a deployment and a deployment status carrying `environment_url`.
 *
 * Reading that instead means the preview button works for whatever the user
 * actually deploys with, and there is no bot identity or comment format to trust.
 */

export interface DeploymentUrls {
  /** Latest successful deployment. */
  deploymentUrl: string | null;
  /** A deployment that is still building. */
  buildingDeploymentUrl: string | null;
  /** Most recent deployment that failed. */
  failedDeploymentUrl: string | null;
}

export interface FindDeploymentResult extends DeploymentUrls {
  success: boolean;
  error?: string;
}

const EMPTY: DeploymentUrls = {
  deploymentUrl: null,
  buildingDeploymentUrl: null,
  failedDeploymentUrl: null,
};

/** Statuses that mean a deployment is on its way but not yet serving. */
const IN_PROGRESS_STATES = new Set(["pending", "queued", "in_progress"]);
/** Statuses that mean the deployment will not come up. */
const FAILED_STATES = new Set(["failure", "error"]);

/**
 * Only http(s) URLs are surfaced. `environment_url` is attacker-influenced in
 * the sense that anyone who can create a deployment status sets it, and the
 * value is rendered as a link — so a `javascript:` or `data:` URL must never
 * reach the client.
 */
function normalizeEnvironmentUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** How many of the most recent deployments to inspect for this commit. */
const MAX_DEPLOYMENTS_INSPECTED = 10;

/**
 * Resolve the preview URLs for a pull request's head commit.
 *
 * Deployments are keyed by commit, not by pull request, so the head SHA is
 * looked up first. Statuses are returned newest-first by GitHub, so the first
 * one describes the deployment's current state.
 */
export async function findDeploymentUrl(params: {
  owner: string;
  repo: string;
  prNumber: number;
  token?: string;
}): Promise<FindDeploymentResult> {
  const { owner, repo, prNumber, token } = params;

  if (!token) {
    return { ...EMPTY, success: false, error: GITHUB_NOT_CONNECTED };
  }

  try {
    const pull = await ghJson<{ head?: { sha?: unknown } }>(
      ["api", `repos/${owner}/${repo}/pulls/${prNumber}`],
      { token },
    );
    const sha = pull.head?.sha;
    if (typeof sha !== "string") {
      return { ...EMPTY, success: true };
    }

    const deployments = await ghJson<
      Array<{ id?: unknown; payload?: unknown }>
    >(
      [
        "api",
        `repos/${owner}/${repo}/deployments?sha=${sha}&per_page=${MAX_DEPLOYMENTS_INSPECTED}`,
      ],
      { token },
    );

    const urls: DeploymentUrls = { ...EMPTY };

    for (const deployment of deployments) {
      // Every category is already filled; nothing further to learn.
      if (urls.deploymentUrl && urls.buildingDeploymentUrl) {
        break;
      }
      if (typeof deployment.id !== "number") {
        continue;
      }

      const statuses = await ghJson<
        Array<{ state?: unknown; environment_url?: unknown }>
      >(
        [
          "api",
          `repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
        ],
        { token },
      );

      const latest = statuses[0];
      if (!latest) {
        continue;
      }

      const url =
        normalizeEnvironmentUrl(latest.environment_url) ??
        normalizeEnvironmentUrl(deployment.payload);
      if (!url) {
        continue;
      }

      const state = String(latest.state ?? "");
      if (state === "success" && !urls.deploymentUrl) {
        urls.deploymentUrl = url;
      } else if (IN_PROGRESS_STATES.has(state) && !urls.buildingDeploymentUrl) {
        urls.buildingDeploymentUrl = url;
      } else if (FAILED_STATES.has(state) && !urls.failedDeploymentUrl) {
        urls.failedDeploymentUrl = url;
      }
    }

    return { ...urls, success: true };
  } catch {
    return {
      ...EMPTY,
      success: false,
      error:
        "We couldn't load the deployments for this pull request. Try again in a moment.",
    };
  }
}
