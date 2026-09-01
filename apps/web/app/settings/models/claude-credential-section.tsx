"use client";

import { AlertTriangle, KeyRound, Loader2, Server } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInstanceSettings,
  updateClaudeCredential,
  updateClaudeGateway,
} from "@/lib/admin/instance-settings-actions";
import { toast } from "@/lib/toast";

type ClaudeCredentialKind = "api_key" | "setup_token";

type ClaudeSettings = {
  claudeCredentialKind: ClaudeCredentialKind | null;
  claudeCredentialSetAt: Date | null;
  claudeBaseUrl: string | null;
  claudeModelDiscovery: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A setup token expires one year after it is saved, silently — turns just
 * start failing with a CLI error that never mentions the real cause. Paco
 * cannot renew it, so warning a month early is the whole mitigation: enough
 * runway for an operator to mint a new one with `claude setup-token` before
 * the old one stops working.
 */
const SETUP_TOKEN_WARNING_AGE_DAYS = 11 * 30;

function formatSavedDate(date: Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function isSetupTokenAgingOut(settings: ClaudeSettings): boolean {
  if (
    settings.claudeCredentialKind !== "setup_token" ||
    !settings.claudeCredentialSetAt
  ) {
    return false;
  }
  const ageMs = Date.now() - new Date(settings.claudeCredentialSetAt).getTime();
  return ageMs > SETUP_TOKEN_WARNING_AGE_DAYS * MS_PER_DAY;
}

function ClaudeCredentialSectionSkeleton() {
  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <div className="skeleton h-5 w-40" />
      </div>
      <div className="space-y-4 px-5 py-4">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    </section>
  );
}

/**
 * The Claude credential and gateway this instance runs turns on.
 *
 * Two independent forms in one card, because they save through two
 * independent server actions (`updateClaudeCredential`,
 * `updateClaudeGateway`) with different validation: a credential value is
 * required to save one, while the gateway can be cleared back to "talk to
 * Anthropic directly" with an empty Base URL.
 *
 * The credential input is never pre-filled with the stored secret —
 * `getInstanceSettings()` never returns it, only `claudeCredentialKind` and
 * `claudeCredentialSetAt`, because that view is serialised to the client.
 * This section only ever renders "a credential of this kind is configured,
 * saved on this date" from those two fields, and the input starts empty.
 */
export function ClaudeCredentialSection() {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const requestIdRef = useRef(0);

  const [credentialKind, setCredentialKind] =
    useState<ClaudeCredentialKind>("api_key");
  const [credentialValue, setCredentialValue] = useState("");
  const [savingCredential, setSavingCredential] = useState(false);

  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [modelDiscovery, setModelDiscovery] = useState(false);
  const [savingGateway, setSavingGateway] = useState(false);

  const loadSettings = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const loaded = await getInstanceSettings();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setSettings({
        claudeCredentialKind: loaded.claudeCredentialKind,
        claudeCredentialSetAt: loaded.claudeCredentialSetAt,
        claudeBaseUrl: loaded.claudeBaseUrl,
        claudeModelDiscovery: loaded.claudeModelDiscovery,
      });
      // Defaults the radio to whatever kind is already configured, so
      // pasting a *replacement* credential starts from the current choice
      // instead of always resetting to "API key".
      if (loaded.claudeCredentialKind) {
        setCredentialKind(loaded.claudeCredentialKind);
      }
      setBaseUrlInput(loaded.claudeBaseUrl ?? "");
      setModelDiscovery(loaded.claudeModelDiscovery);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the Claude credential settings.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadSettings]);

  async function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (credentialValue.trim() === "") {
      toast.error("Enter the credential's value.");
      return;
    }

    setSavingCredential(true);
    try {
      const result = await updateClaudeCredential({
        kind: credentialKind,
        value: credentialValue.trim(),
      });

      if (result.success) {
        toast.success("Claude credential saved.");
        // Cleared on success only, so a rejected value stays in the field
        // to be corrected rather than retyped from scratch.
        setCredentialValue("");
        await loadSettings();
      } else {
        toast.error(result.error ?? "That didn't save. Try again.");
      }
    } catch {
      toast.error("That didn't save. Try again.");
    } finally {
      setSavingCredential(false);
    }
  }

  async function handleGatewaySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedBaseUrl = baseUrlInput.trim();
    setSavingGateway(true);
    try {
      const result = await updateClaudeGateway({
        baseUrl: trimmedBaseUrl === "" ? null : trimmedBaseUrl,
        // Clearing the base URL always turns discovery off with it — a
        // checkbox left checked behind a now-empty Base URL would otherwise
        // save a `modelDiscovery: true` that means nothing without a
        // gateway to discover from.
        modelDiscovery: trimmedBaseUrl === "" ? false : modelDiscovery,
      });

      if (result.success) {
        toast.success("Gateway settings saved.");
        await loadSettings();
      } else {
        toast.error(result.error ?? "That didn't save. Try again.");
      }
    } catch {
      toast.error("That didn't save. Try again.");
    } finally {
      setSavingGateway(false);
    }
  }

  if (loadError) {
    return (
      <section className="rounded-lg border border-base-content/10">
        <div className="px-5 py-4">
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>The Claude credential settings couldn&apos;t be loaded.</span>
            <button
              className="btn btn-sm"
              onClick={() => void loadSettings()}
              type="button"
            >
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (settings === null) {
    return <ClaudeCredentialSectionSkeleton />;
  }

  const baseUrlIsSet = baseUrlInput.trim() !== "";

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <KeyRound aria-hidden="true" className="size-4" />
          Claude credential
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          What Paco authenticates the agent with, and — optionally — the gateway
          it reaches Claude through.
        </p>
      </div>

      <div className="px-5 py-4">
        <form
          className="fieldset"
          onSubmit={(event) => void handleCredentialSubmit(event)}
        >
          <legend className="fieldset-legend">Credential type</legend>

          <label className="label cursor-pointer justify-start gap-2">
            <input
              checked={credentialKind === "api_key"}
              className="radio radio-sm"
              disabled={savingCredential}
              name="claude-credential-kind"
              onChange={() => setCredentialKind("api_key")}
              type="radio"
            />
            API key
          </label>
          <p className="pl-7 text-base-content/60 text-xs">
            Bills the Anthropic API directly, on the account the key belongs to.
          </p>

          <label className="label cursor-pointer justify-start gap-2">
            <input
              checked={credentialKind === "setup_token"}
              className="radio radio-sm"
              disabled={savingCredential}
              name="claude-credential-kind"
              onChange={() => setCredentialKind("setup_token")}
              type="radio"
            />
            Setup token
          </label>
          <p className="pl-7 text-base-content/60 text-xs">
            Comes from <code>claude setup-token</code> and needs a Claude
            subscription — not API billing.
          </p>

          <label className="label mt-2" htmlFor="claude-credential-value">
            {credentialKind === "api_key" ? "API key" : "Setup token"}
          </label>
          <input
            autoComplete="off"
            className="input input-sm w-full"
            disabled={savingCredential}
            id="claude-credential-value"
            onChange={(event) => setCredentialValue(event.target.value)}
            placeholder={
              credentialKind === "api_key" ? "sk-ant-…" : "Paste the token…"
            }
            type="password"
            value={credentialValue}
          />
          <p className="text-base-content/60 text-xs">
            {settings.claudeCredentialKind
              ? `${
                  settings.claudeCredentialKind === "api_key"
                    ? "An API key"
                    : "A setup token"
                } is configured, saved ${
                  settings.claudeCredentialSetAt
                    ? formatSavedDate(settings.claudeCredentialSetAt)
                    : "at an unknown date"
                }. Never shown again — enter a new value to replace it.`
              : "No credential configured yet. Turns will fail until one is saved."}
          </p>

          {isSetupTokenAgingOut(settings) ? (
            <div className="alert alert-warning alert-soft mt-2" role="alert">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              <span>
                This setup token is over eleven months old. It expires one year
                after it was issued, and turns will start failing with a CLI
                error when it does — Paco cannot renew it for you. Run{" "}
                <code>claude setup-token</code> again and paste the new value
                above.
              </span>
            </div>
          ) : null}

          <button
            className="btn btn-sm mt-3 w-fit"
            disabled={savingCredential}
            type="submit"
          >
            {savingCredential ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            {savingCredential ? "Saving…" : "Save credential"}
          </button>
        </form>

        <div className="divider" />

        <form
          className="fieldset"
          onSubmit={(event) => void handleGatewaySubmit(event)}
        >
          <legend className="fieldset-legend flex items-center gap-2">
            <Server aria-hidden="true" className="size-4" />
            Gateway
          </legend>

          <label className="label" htmlFor="claude-base-url">
            Base URL
          </label>
          <input
            className="input input-sm w-full"
            disabled={savingGateway}
            id="claude-base-url"
            onChange={(event) => setBaseUrlInput(event.target.value)}
            placeholder="https://gateway.example.com"
            type="text"
            value={baseUrlInput}
          />
          <p className="text-base-content/60 text-xs">
            Optional. Must speak the Anthropic Messages format — the same
            contract Claude Code itself uses. Non-Claude models are not
            supported through it: Anthropic does not support routing Claude Code
            to non-Claude models through any gateway. Leave this blank to talk
            to Anthropic directly.
          </p>

          <label className="label mt-2 cursor-pointer justify-start gap-2">
            <input
              checked={modelDiscovery}
              className="checkbox checkbox-sm"
              disabled={savingGateway || !baseUrlIsSet}
              onChange={(event) => setModelDiscovery(event.target.checked)}
              type="checkbox"
            />
            Fetch available models from this gateway
          </label>
          <p className="pl-7 text-base-content/60 text-xs">
            {baseUrlIsSet
              ? "Lets the CLI query this gateway's model list and fill the picker from it, instead of the fixed opus/sonnet/haiku aliases."
              : "Needs a Base URL above before it can be turned on."}
          </p>

          <button
            className="btn btn-sm mt-3 w-fit"
            disabled={savingGateway}
            type="submit"
          >
            {savingGateway ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            {savingGateway ? "Saving…" : "Save gateway"}
          </button>
        </form>
      </div>
    </section>
  );
}
