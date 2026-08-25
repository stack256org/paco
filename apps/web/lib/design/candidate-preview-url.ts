import { candidatePreviewHostname } from "@/lib/preview/hostname";

/**
 * Where one design candidate's preview is reachable, ready to hand to an
 * `<iframe src>`.
 *
 * Section 5 Task 3 shipped everything that makes a candidate preview exist —
 * the `-d<n>` hostname (`candidatePreviewHostname`), the nginx server block
 * that proxies it to `candidateContainerPort(n)` and injects the click
 * inspector, and the forward-auth route that gates it exactly like the
 * chat's own preview. What it did not ship is a streamed part carrying the
 * resulting URLs to the browser, so this derives them the same way the
 * Preview tab's own share control derives the chat's URL
 * (`lib/preview/actions.ts`): hostname from the configured base domain,
 * scheme from whether TLS is on.
 *
 * Deliberately free of `server-only` and of any database access: the
 * candidate list is rendered by a client component, and keeping the shape
 * here a plain value means the page can compute it once on the server and
 * pass it down as props.
 */
export interface DesignCandidatePreview {
  index: 1 | 2 | 3;
  url: string;
}

/** Candidate indices a design turn can ever hand out — `candidates.ts`'s rule. */
const CANDIDATE_INDICES: Array<1 | 2 | 3> = [1, 2, 3];

function schemeFor(tlsEnabled: boolean): string {
  return tlsEnabled ? "https://" : "http://";
}

/**
 * A preview URL per candidate index, or an empty list when no preview base
 * domain is configured — there is then nowhere for a candidate's dev server
 * to be routed, so the panel has nothing to embed and says so.
 */
export function buildCandidatePreviews(params: {
  chatId: string;
  previewBaseDomain: string | null;
  tlsEnabled: boolean;
}): DesignCandidatePreview[] {
  const previews: DesignCandidatePreview[] = [];

  for (const index of CANDIDATE_INDICES) {
    const hostname = candidatePreviewHostname(
      params.chatId,
      index,
      params.previewBaseDomain,
    );
    if (!hostname) {
      continue;
    }
    previews.push({ index, url: `${schemeFor(params.tlsEnabled)}${hostname}` });
  }

  return previews;
}
