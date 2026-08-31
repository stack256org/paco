import type { NextRequest } from "next/server";
import { parseUsageQueryRange } from "./_lib/query-range";
import { getUsageInsights } from "@/lib/db/usage-insights";
import { getUsageHistory } from "@/lib/db/usage";

/**
 * GET /api/usage — Retrieve aggregated usage history + derived insights.
 * Optional query params: from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function GET(req: NextRequest) {
  const rangeResult = parseUsageQueryRange(req);
  if (!rangeResult.ok) {
    return rangeResult.response;
  }

  try {
    const queryOptions = rangeResult.range
      ? { range: rangeResult.range }
      : undefined;
    const [usage, insights] = await Promise.all([
      getUsageHistory(queryOptions),
      getUsageInsights(queryOptions),
    ]);
    return Response.json({ usage, insights });
  } catch (error) {
    console.error("Failed to get usage history:", error);
    return Response.json(
      { error: "We couldn't load your usage history. Try again in a moment." },
      { status: 500 },
    );
  }
}
