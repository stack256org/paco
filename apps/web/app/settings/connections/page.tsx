import type { Metadata } from "next";
import { GitHubConnectionSection } from "../github-connection-section";

export const metadata: Metadata = {
  title: "Connections",
  description: "Manage your connected accounts and integrations.",
};

export default function ConnectionsPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Connections</h1>{" "}
      <GitHubConnectionSection />
    </>
  );
}
