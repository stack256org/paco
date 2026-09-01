import { listClaudeModels } from "@/lib/model-catalog";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

const CACHE_CONTROL = "private, no-store";

/**
 * Every model, across every backend — not narrowed to the chat's own.
 *
 * `useModelOptions` replaces the server-rendered options with this response
 * once it loads, and the composer filters them client-side against
 * `capabilities.models`. Narrowing here would empty the picker for a chat
 * running a backend other than the default the moment the fetch resolved,
 * and there is no per-user data in the list to gate anyway.
 *
 * `listClaudeModels` is what makes this reflect a configured gateway: with
 * no base URL it is exactly the static tier aliases, and with one set it
 * reads the CLI's own discovery cache (falling back to the aliases when
 * that cache is absent or unreadable, so a freshly configured gateway never
 * empties this response).
 */
export async function GET() {
  try {
    const { claudeBaseUrl } = await readInstanceSettings();
    const models = listClaudeModels(claudeBaseUrl);

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
