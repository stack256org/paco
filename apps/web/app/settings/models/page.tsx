import type { Metadata } from "next";
import { ModelPreferencesSection } from "../preferences-section";
import { ClaudeCredentialSection } from "./claude-credential-section";

export const metadata: Metadata = {
  title: "Models",
  description: "Choose the model that runs your chats.",
};

export default function ModelsPage() {
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

      <ClaudeCredentialSection />
    </div>
  );
}
