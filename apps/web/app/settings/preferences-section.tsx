"use client";

import { useState } from "react";
import { useThemePreference } from "@/hooks/use-theme-preference";
import { parseThemePreference, type ThemePreference } from "@/lib/theme";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ModelCombobox } from "@/components/model-combobox";
import { useModelOptions } from "@/hooks/use-model-options";
import {
  type DiffMode,
  useUserPreferences,
} from "@/hooks/use-user-preferences";
import { getDefaultModelOptionId } from "@/lib/model-options";

const THEME_OPTIONS: Array<{ id: ThemePreference; name: string }> = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

/*
 * "Unified" and "Split" are the names the diff viewer uses internally. They
 * describe the layout to someone who already knows both, and nothing to anyone
 * else — so the setting names the shape you get instead.
 */
const DIFF_MODE_OPTIONS: Array<{ id: DiffMode; name: string }> = [
  { id: "unified", name: "One column" },
  { id: "split", name: "Side by side" },
];

/*
 * Base UI's `Select.Value` renders the raw value unless the root is given an
 * items map, so the Theme field read "light" — the stored value, lowercase —
 * instead of the option the user picked. These maps are that lookup.
 */
const THEME_ITEMS = Object.fromEntries(
  THEME_OPTIONS.map((option) => [option.id, option.name]),
);
const DIFF_MODE_ITEMS = Object.fromEntries(
  DIFF_MODE_OPTIONS.map((option) => [option.id, option.name]),
);

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wider text-base-content/60">
      {children}
    </h3>
  );
}

export function PreferencesSectionSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <SectionHeader>General</SectionHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>

      <div className="border-t border-base-300/50" />

      <div className="space-y-4">
        <SectionHeader>Skills</SectionHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-[28rem] max-w-full" />
          </div>
          <div className="rounded-lg border border-base-300/70">
            {Array.from({ length: 2 }).map((_, index) => (
              <div
                key={index}
                className="flex items-center gap-3 border-b border-base-300/60 px-3 py-2.5 last:border-b-0"
              >
                <div className="grid min-w-0 flex-1 gap-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-44" />
                </div>
                <Skeleton className="size-8 rounded-md" />
              </div>
            ))}
          </div>
          <div className="grid gap-2.5 rounded-lg border border-dashed border-base-300/60 p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <div className="grid gap-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-10 w-full" />
              </div>
              <div className="grid gap-1.5">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-10 w-full" />
              </div>
              <Skeleton className="h-10 w-20" />
            </div>
            <Skeleton className="h-4 w-[30rem] max-w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModelPreferencesSectionSkeleton() {
  return (
    <div className="space-y-4">
      <SectionHeader>Model Preferences</SectionHeader>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="grid gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-4 w-44" />
        </div>
      </div>
      <div className="grid gap-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-14" />
          </div>
          <Skeleton className="h-4 w-[34rem] max-w-full" />
        </div>
        <div className="rounded-lg border border-base-300/70">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-b border-base-300/60 px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="size-6 rounded-md" />
            </div>
          ))}
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

function usePreferencesSectionState() {
  const { preference: theme, setPreference: setTheme } = useThemePreference();
  const { preferences, loading, updatePreferences } = useUserPreferences();
  const { modelOptions, loading: modelOptionsLoading } = useModelOptions();
  const [isSaving, setIsSaving] = useState(false);

  const selectedDefaultModelId =
    preferences?.defaultModelId ?? getDefaultModelOptionId(modelOptions);

  const defaultModelOptions = modelOptions;

  const handleThemeChange = (nextTheme: string) => {
    setTheme(parseThemePreference(nextTheme));
  };

  const handleModelChange = async (modelId: string) => {
    setIsSaving(true);
    try {
      await updatePreferences({ defaultModelId: modelId });
    } catch (error) {
      console.error("Failed to update model preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiffModeChange = async (diffMode: DiffMode) => {
    setIsSaving(true);
    try {
      await updatePreferences({ defaultDiffMode: diffMode });
    } catch (error) {
      console.error("Failed to update diff mode preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoCommitLocalChange = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      await updatePreferences({ autoCommitLocal: enabled });
    } catch (error) {
      console.error("Failed to update auto-save preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoCommitPushChange = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      await updatePreferences({ autoCommitPush: enabled });
    } catch (error) {
      console.error("Failed to update auto-commit preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoCreatePrChange = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      await updatePreferences({ autoCreatePr: enabled });
    } catch (error) {
      console.error("Failed to update auto-PR preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAlertsEnabledChange = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      await updatePreferences({ alertsEnabled: enabled });
    } catch (error) {
      console.error("Failed to update alerts preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAlertSoundEnabledChange = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      await updatePreferences({ alertSoundEnabled: enabled });
    } catch (error) {
      console.error("Failed to update alert sound preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  return {
    theme,
    setTheme,
    preferences,
    loading,
    updatePreferences,
    modelOptionsLoading,
    isSaving,
    selectedDefaultModelId,
    defaultModelOptions,
    handleThemeChange,
    handleModelChange,
    handleDiffModeChange,
    handleAutoCommitLocalChange,
    handleAutoCommitPushChange,
    handleAutoCreatePrChange,
    handleAlertsEnabledChange,
    handleAlertSoundEnabledChange,
  };
}

export function PreferencesSection() {
  const state = usePreferencesSectionState();

  if (state.loading) {
    return <PreferencesSectionSkeleton />;
  }

  const {
    theme,
    preferences,
    isSaving,
    handleThemeChange,
    handleDiffModeChange,
    handleAutoCommitLocalChange,
    handleAutoCommitPushChange,
    handleAutoCreatePrChange,
    handleAlertsEnabledChange,
    handleAlertSoundEnabledChange,
  } = state;

  return (
    <div className="space-y-8">
      {/* ── General: Theme, Notifications, Environment, Automation ── */}
      <div className="space-y-4">
        <SectionHeader>General</SectionHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {/* Left column: dropdowns */}
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="appearance" id="appearance-label">
                Theme
              </Label>
              <Select
                items={THEME_ITEMS}
                onValueChange={handleThemeChange}
                value={theme}
              >
                <SelectTrigger
                  aria-labelledby="appearance-label"
                  className="w-full"
                  id="appearance"
                >
                  <SelectValue placeholder="Select an appearance" />
                </SelectTrigger>
                <SelectContent>
                  {THEME_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-base-content/60">
                Saved in your current browser.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="diff-mode" id="diff-mode-label">
                How to show changes
              </Label>
              <Select
                disabled={isSaving}
                items={DIFF_MODE_ITEMS}
                onValueChange={(value) =>
                  handleDiffModeChange(value as DiffMode)
                }
                value={preferences?.defaultDiffMode ?? "unified"}
              >
                <SelectTrigger
                  aria-labelledby="diff-mode-label"
                  className="w-full"
                  id="diff-mode"
                >
                  <SelectValue placeholder="Choose a layout" />
                </SelectTrigger>
                <SelectContent>
                  {DIFF_MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-base-content/60">
                Whether the old and new version sit in one list or in two
                columns.
              </p>
            </div>
          </div>

          {/* Right column: toggles */}
          <div className="space-y-3">
            {/*
              Three separate switches, in order of how far the work travels:
              this computer, then GitHub, then someone else's inbox. They were
              one switch, which meant the safest of the three could not be on
              without the other two.
            */}
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="auto-commit-local">
                  Save my work after each change
                </Label>
                <p className="text-xs text-base-content/60">
                  Keeps a history of everything Paco finishes, so you can look
                  back at it or go back to it. It stays on this computer unless
                  you also turn on backing up to GitHub.
                </p>
              </div>
              <Switch
                id="auto-commit-local"
                checked={preferences?.autoCommitLocal ?? true}
                onCheckedChange={handleAutoCommitLocalChange}
                disabled={isSaving}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="auto-commit-push">Back it up to GitHub</Label>
                <p className="text-xs text-base-content/60">
                  Also send each save to GitHub, where it is safe if something
                  happens to this computer. Only works on projects connected to
                  a GitHub repository.
                </p>
              </div>
              <Switch
                id="auto-commit-push"
                checked={preferences?.autoCommitPush ?? false}
                onCheckedChange={handleAutoCommitPushChange}
                disabled={isSaving}
              />
            </div>
            <div className="flex items-center justify-between gap-4 pl-4">
              <div className="space-y-0.5">
                <Label htmlFor="auto-create-pr">Ask for a review too</Label>
                <p className="text-xs text-base-content/60">
                  Once it is on GitHub, open a pull request so the change can be
                  looked at before it goes live. Needs backing up to GitHub.
                </p>
              </div>
              <Switch
                id="auto-create-pr"
                checked={preferences?.autoCreatePr ?? false}
                onCheckedChange={handleAutoCreatePrChange}
                disabled={isSaving || !(preferences?.autoCommitPush ?? false)}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="alerts-enabled">Tell me when it is done</Label>
                <p className="text-xs text-base-content/60">
                  Show a notification when Paco finishes something you were not
                  watching.
                </p>
              </div>
              <Switch
                id="alerts-enabled"
                checked={preferences?.alertsEnabled ?? true}
                onCheckedChange={handleAlertsEnabledChange}
                disabled={isSaving}
              />
            </div>
            {(preferences?.alertsEnabled ?? true) && (
              <div className="flex items-center justify-between gap-4 pl-4">
                <div className="space-y-0.5">
                  <Label htmlFor="alert-sound-enabled">Play a sound</Label>
                  <p className="text-xs text-base-content/60">
                    Make a noise with each notification, not just show it.
                  </p>
                </div>
                <Switch
                  id="alert-sound-enabled"
                  checked={preferences?.alertSoundEnabled ?? true}
                  onCheckedChange={handleAlertSoundEnabledChange}
                  disabled={isSaving}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModelPreferencesSection() {
  const state = usePreferencesSectionState();

  if (state.loading) {
    return <ModelPreferencesSectionSkeleton />;
  }

  const {
    defaultModelOptions,
    selectedDefaultModelId,
    modelOptionsLoading,
    isSaving,
    handleModelChange,
  } = state;

  return (
    <div className="space-y-4">
      <SectionHeader>Which AI does the work</SectionHeader>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="model">Main AI</Label>
          {/* The label pointed at an id nothing rendered, so clicking it did
              nothing and a screen reader read the control unnamed. */}
          <ModelCombobox
            id="model"
            value={selectedDefaultModelId}
            items={defaultModelOptions.map((option) => ({
              id: option.id,
              label: option.label,
              description: option.description,
            }))}
            placeholder="Select a model"
            searchPlaceholder="Search models..."
            emptyText={modelOptionsLoading ? "Loading..." : "No models found."}
            disabled={isSaving || modelOptionsLoading}
            onChange={handleModelChange}
          />
          <p className="text-xs text-base-content/60">
            The one you talk to. It works out what needs doing and hands the
            routine parts to the helpers below.
          </p>
        </div>

        {/*
          Read-only on purpose. This was a "Subagent Model" picker whose
          "same as main model" default rewrote every agent onto one model,
          which is exactly what the tiering exists to prevent.
        */}
        <div className="grid gap-2">
          <span className="text-sm font-medium">Its helpers</span>
          <dl className="grid gap-1.5 rounded-md border border-base-300 bg-base-200/30 p-3 text-xs">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="font-medium">Sonnet</dt>
              <dd className="text-right text-base-content/60">
                Writes the code it is asked to write
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="font-medium">Haiku</dt>
              <dd className="text-right text-base-content/60">
                Reads and searches, makes no decisions
              </dd>
            </div>
          </dl>
          <p className="text-xs text-base-content/60">
            You cannot change these, and that is on purpose &mdash; it keeps the
            simple work cheap.
          </p>
        </div>
      </div>
    </div>
  );
}
