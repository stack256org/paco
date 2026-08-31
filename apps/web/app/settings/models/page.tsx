import type { Metadata } from "next";
import { capabilitiesForBackend } from "@/lib/agent/backend-capabilities";
import { ModelPreferencesSection } from "../preferences-section";
import { PoolsideProviderSection } from "./poolside-provider-section";

export const metadata: Metadata = {
  title: "Models",
  description: "Choose the model that runs your chats.",
};

export default function ModelsPage() {
  /*
   * Read from the real backend here, on the server, and handed down: the
   * section below states what a Poolside chat gives up, and the only way for
   * that copy to be wrong is for it to be written by hand. `PoolsideBackend`
   * spawns processes, so a client component cannot ask it directly — but a
   * plain, serialisable capability object crosses the boundary fine.
   */
  const poolsideCapabilities = capabilitiesForBackend("poolside");

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Models</h1>
        <p className="text-sm text-base-content/60">
          The model that runs the chat itself. It delegates implementation and
          lookups down-tier. Reasoning effort is chosen per chat, next to the
          composer.
        </p>
      </div>

      <ModelPreferencesSection />

      <PoolsideProviderSection capabilities={poolsideCapabilities} />
    </div>
  );
}
