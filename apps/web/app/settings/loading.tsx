import { GitHubConnectionSectionSkeleton } from "./github-connection-section";
import {
  ModelPreferencesSectionSkeleton,
  PreferencesSectionSkeleton,
} from "./preferences-section";

function ProfilePageLoading() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Profile</h1>
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
        <div className="w-full shrink-0 lg:w-56">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="h-14 w-14 shrink-0 rounded-full bg-base-200" />
              <div className="space-y-1.5">
                <div className="h-5 w-28 rounded bg-base-200" />
                <div className="h-4 w-20 rounded bg-base-200" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-4 w-full rounded bg-base-200" />
              <div className="h-4 w-full rounded bg-base-200" />
              <div className="h-4 w-full rounded bg-base-200" />
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-8">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-base-content/60">
                Activity
              </h2>
            </div>
            <div className="h-[96px] w-full rounded-md bg-base-200" />
          </div>
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="h-28 rounded-xl bg-base-200" />
            <div className="h-28 rounded-xl bg-base-200" />
            <div className="h-28 rounded-xl bg-base-200" />
          </div>
        </div>
      </div>
    </>
  );
}

function ConnectionsPageLoading() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Connections</h1>{" "}
      <GitHubConnectionSectionSkeleton />
    </>
  );
}

function PreferencesPageLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Preferences</h1>
        <p className="text-sm text-base-content/60">
          Adjust Paco preferences and behavior.
        </p>
      </div>
      <PreferencesSectionSkeleton />
    </div>
  );
}

function ModelsPageLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Models</h1>
        <p className="text-sm text-base-content/60">
          Set your default models and create named variants with provider-
          specific settings.
        </p>
      </div>
      <ModelPreferencesSectionSkeleton />
      <div className="border-t border-base-300/50" />
    </div>
  );
}

export default function SettingsLoading() {
  return <ProfilePageLoading />;
}

export {
  ConnectionsPageLoading,
  ModelsPageLoading,
  PreferencesPageLoading,
  ProfilePageLoading,
};
