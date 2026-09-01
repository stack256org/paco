import { listAllModels } from "@/lib/model-catalog";

const CACHE_CONTROL = "private, no-store";

/**
 * Every model, across every backend — not narrowed to the chat's own.
 *
 * `useModelOptions` replaces the server-rendered options with this response
 * once it loads, and the composer filters them client-side against
 * `capabilities.models`. Narrowing here would empty the picker for a chat
 * running a backend other than the default the moment the fetch resolved,
 * and there is no per-user data in the list to gate anyway.
 */
export function GET() {
  try {
    const models = listAllModels();

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
