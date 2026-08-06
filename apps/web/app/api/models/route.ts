import { listAvailableModels } from "@/lib/model-catalog";

const CACHE_CONTROL = "private, no-store";

export function GET() {
  try {
    const models = listAvailableModels();

    return Response.json(
      { models },
      {
        headers: {
          "Cache-Control": CACHE_CONTROL,
        },
      },
    );
  } catch (error) {
    console.error("Failed to fetch available models:", error);
    return Response.json(
      { error: "We couldn't load the list of models. Try again in a moment." },
      { status: 500 },
    );
  }
}
