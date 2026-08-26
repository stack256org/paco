"use client";

import type { BackendCapabilities } from "@paco/agent-backend";
import { AlertTriangle, CheckCircle2, Cpu, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInstanceSettings,
  testPoolsideConnection,
  updatePoolsideSettings,
} from "@/lib/admin/instance-settings-actions";
import { toast } from "@/lib/toast";

export type PoolsideFormState = {
  /** Blank means Poolside's own service; a URL means a standalone deployment. */
  baseUrl: string;
  binaryPath: string;
  /** Always starts empty — the server never sends the stored key back. */
  apiKey: string;
};

type TestResult = {
  ok: boolean;
  message: string;
  /**
   * The endpoint the binary resolved, echoed back from the handshake. Absent
   * whenever the agent did not report one — see `describeTestResult`.
   */
  serviceMode?: string;
};

/** What `testPoolsideConnection` answers with. */
export type PoolsideTestResponse = {
  success: boolean;
  error?: string;
  serviceMode?: string;
};

/**
 * Turn a connection-test response into what the alert shows.
 *
 * The interesting case is the one that reads like a detail and is not.
 * `initialize` does not authenticate and it does not validate the base URL:
 * a handshake against the WRONG endpoint succeeds exactly as happily as one
 * against the right endpoint, so a green tick on its own is close to
 * meaningless for the mistake an operator is most likely to have just made.
 * `poolside/service_mode` echoes what the binary actually resolved, which is
 * the one thing that makes the tick checkable — hence a separate line rather
 * than a sentence, so it can be compared with the field above at a glance.
 *
 * When the agent reports no service mode, this degrades to the weaker claim
 * instead of rendering an empty endpoint: an older build that does not send
 * the key should say less, not appear to have resolved nothing.
 *
 * Pure and exported so both branches are testable without a DOM.
 */
export function describeTestResult(response: PoolsideTestResponse): TestResult {
  if (!response.success) {
    return {
      ok: false,
      message: response.error ?? "The Poolside agent refused the handshake.",
    };
  }

  return {
    ok: true,
    message: "Paco started the Poolside agent and it answered.",
    ...(response.serviceMode ? { serviceMode: response.serviceMode } : {}),
  };
}

/**
 * The form's fields as `poolsideSchema` wants them.
 *
 * Blank becomes `null` for every field, which is not cosmetic:
 * `poolsideSchema.binaryPath` is `z.string().trim().min(1).nullable()`, so
 * submitting `""` is a validation ERROR rather than "unset". A user clearing
 * the binary path means "go back to whatever `pool` is on PATH", and `null`
 * is the only way to say that.
 *
 * `apiKey` follows the same rule for a different reason: blank means "leave
 * the stored key alone" (`savePoolsideSettings`), which is the normal case,
 * since the real key is never sent to the browser and so the field is empty
 * on every load.
 *
 * Pure and exported so the round trip is testable without a DOM.
 */
export function toPoolsideUpdate(form: PoolsideFormState): {
  baseUrl: string | null;
  binaryPath: string | null;
  apiKey: string | null;
} {
  const blankToNull = (value: string) =>
    value.trim() === "" ? null : value.trim();

  return {
    baseUrl: blankToNull(form.baseUrl),
    binaryPath: blankToNull(form.binaryPath),
    // Not trimmed: a key is an opaque credential, and silently editing one
    // is worse than storing the whitespace a paste brought with it.
    apiKey: form.apiKey.trim() === "" ? null : form.apiKey,
  };
}

/**
 * One line per capability Poolside can report as unsupported.
 *
 * A map rather than a list, and rendered only for the keys the backend
 * actually reports — the OpenFX section this replaces hardcoded four
 * warnings and leaned on a test to keep them honest, which held only for as
 * long as someone remembered to re-run the comparison. Poolside makes the
 * difference concrete: it supports MCP and session resume and publishes its
 * own models, so three of those four warnings became lies the moment the
 * backend changed underneath them. Nothing here is asserted to apply; the
 * capability object decides which lines appear, and a key the object never
 * reports as unsupported is copy that is simply never shown.
 */
export const POOLSIDE_LIMITATION_COPY: Readonly<Record<string, string>> = {
  resume:
    "Each turn starts a fresh conversation — no session state is kept between turns, so earlier turns are replayed rather than resumed.",
  steering:
    "A turn cannot be steered once it is running; a follow-up message waits for it to finish.",
  mcp: "MCP servers are not passed through, so plugin tools and any project MCP configuration are unavailable to Poolside chats.",
  effort:
    "Paco's effort levels do not reach Poolside: it has a thinking level of its own with only two settings, which Paco's five-way picker cannot express. The effort control is hidden and Poolside runs at its own default — it is not thinking less hard, it is just not taking the instruction.",
  subagents:
    "Turns run as a single agent; nothing is delegated to a subagent, so long tasks all share one context window.",
  customAgents:
    "Paco's own subagent roster and its per-agent model tiers are not available — Poolside delegates to its own internal subagents instead.",
  structuredOutput:
    "Turns that need a schema-shaped answer — task planning and the reviewer gate — come back as free text, so those turns cannot run on Poolside.",
  models:
    "The model comes from Poolside's own configuration rather than Paco's model picker, so the picker is hidden on Poolside chats.",
};

/**
 * Everything `capabilities` reports it cannot do, read off the object rather
 * than named in advance.
 *
 * "Cannot" has three spellings in `BackendCapabilities`: `false`, the
 * `steering` value `"none"`, and an EMPTY list of accepted model ids. A
 * non-empty `models` is a *narrowing*, not a loss — Poolside's two
 * `poolside/laguna-*` ids are a real picker, and treating any present list as
 * a limitation is exactly the mistake that made OpenFX's copy wrong.
 *
 * `id` is skipped because it is a name, not a claim.
 */
export function describeBackendLimitations(
  capabilities: BackendCapabilities,
): ReadonlyArray<{ capability: string; text: string }> {
  return Object.entries(capabilities)
    .filter(([key, value]) => {
      if (key === "id") {
        return false;
      }
      if (Array.isArray(value)) {
        return value.length === 0;
      }
      return value === false || value === "none";
    })
    .map(([capability]) => ({
      capability,
      text:
        POOLSIDE_LIMITATION_COPY[capability] ??
        `Poolside does not support ${capability}.`,
    }));
}

export interface PoolsideProviderFormProps {
  /** `null` while the settings are still loading. */
  form: PoolsideFormState | null;
  hasStoredApiKey: boolean;
  saving: boolean;
  onChange: (patch: Partial<PoolsideFormState>) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

/**
 * The fields themselves, with no state and no server actions.
 *
 * Split out for the same reason `ConsentForm` is split out of
 * `ConsentDialog`: it can be handed a populated `form` and rendered to static
 * markup in a test, which is the only way to assert that the base URL input
 * is enabled and that a stored API key never comes back down.
 */
export function PoolsideProviderForm({
  form,
  hasStoredApiKey,
  saving,
  onChange,
  onSubmit,
}: PoolsideProviderFormProps) {
  const busy = form === null || saving;

  return (
    <form className="fieldset" onSubmit={onSubmit}>
      <label className="label" htmlFor="poolside-base-url">
        Base URL
      </label>
      <input
        className="input input-sm w-full"
        // Disabled only while there is nothing to edit or a save is in
        // flight. The OpenFX field this replaces was disabled unconditionally
        // because that binary had no way to accept a custom endpoint; `pool`
        // reads POOLSIDE_STANDALONE_BASE_URL and genuinely honours it, so the
        // field is a real input again.
        disabled={busy}
        id="poolside-base-url"
        onChange={(event) => onChange({ baseUrl: event.target.value })}
        placeholder="https://poolside.example.com"
        type="url"
        value={form?.baseUrl ?? ""}
      />
      <p className="text-base-content/60 text-xs">
        Leave blank to use Poolside&apos;s own service. Set it to reach a
        standalone deployment — it is passed to the agent as
        POOLSIDE_STANDALONE_BASE_URL.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="poolside-binary-path">
            Binary path
          </label>
          <input
            className="input input-sm w-full"
            disabled={busy}
            id="poolside-binary-path"
            onChange={(event) => onChange({ binaryPath: event.target.value })}
            placeholder="/usr/local/bin/pool"
            type="text"
            value={form?.binaryPath ?? ""}
          />
          <p className="text-base-content/60 text-xs">
            Leave blank to run whatever &quot;pool&quot; resolves to on PATH.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="poolside-api-key">
            API key
          </label>
          <input
            autoComplete="new-password"
            className="input input-sm w-full"
            disabled={busy}
            id="poolside-api-key"
            onChange={(event) => onChange({ apiKey: event.target.value })}
            // The stored key is never sent to the browser — the server
            // reports only whether one exists — so there is nothing to
            // prefill and this says so instead of rendering a fake value.
            placeholder={
              hasStoredApiKey
                ? "A key is already stored — leave blank to keep it"
                : ""
            }
            type="password"
            value={form?.apiKey ?? ""}
          />
          <p className="text-base-content/60 text-xs">
            Sent to Poolside as POOLSIDE_API_KEY.
          </p>
        </div>
      </div>

      <button className="btn btn-sm mt-2 w-fit" disabled={busy} type="submit">
        {saving ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : null}
        {saving ? "Saving…" : "Save Poolside settings"}
      </button>
    </form>
  );
}

export interface PoolsideProviderSectionProps {
  /**
   * What the Poolside backend actually reports — `capabilitiesForBackend`'s
   * answer, computed on the server in `page.tsx` and handed down.
   *
   * Passed rather than imported because this is a client component and the
   * backends spawn processes, but the point is not just module boundaries:
   * the list below is *derived* from this object, so the section cannot claim
   * a chat gives up something the backend says it supports.
   */
  capabilities: BackendCapabilities;
}

/**
 * BYO Poolside provider config: the base URL, API key and binary path a chat
 * whose backend is `"poolside"` runs against.
 *
 * Every field here is load-bearing, which is the substantive difference from
 * the OpenFX section this replaces. That one rendered its endpoint input
 * permanently disabled, under a caption admitting the value went nowhere,
 * because nothing in the OpenFX binary read it. `pool` takes
 * POOLSIDE_STANDALONE_BASE_URL and POOLSIDE_API_KEY from its environment and
 * honours both, so the form promises what it delivers again.
 *
 * Mirrors `SmtpSection` (`app/settings/admin/smtp-section.tsx`) exactly —
 * same load/save/error shape, same "the secret never comes back down"
 * contract for `apiKey` as that section's password field. Rendered only for
 * admins (see `PoolsideAdminSection`), and re-checked server-side by
 * `requireAdmin` in every action regardless of what this component renders.
 */
export function PoolsideProviderSection({
  capabilities,
}: PoolsideProviderSectionProps) {
  const [form, setForm] = useState<PoolsideFormState | null>(null);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const limitations = describeBackendLimitations(capabilities);

  // Same staleness guard as `SmtpSection.requestIdRef`: only the most recent
  // `loadSettings` call is allowed to touch state.
  const requestIdRef = useRef(0);

  const loadSettings = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const settings = await getInstanceSettings();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setForm({
        baseUrl: settings.poolside.baseUrl ?? "",
        binaryPath: settings.poolside.binaryPath ?? "",
        apiKey: "",
      });
      setHasStoredApiKey(settings.poolside.hasApiKey);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the Poolside settings.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadSettings]);

  function handleChange(patch: Partial<PoolsideFormState>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    setSaving(true);
    setTestResult(null);

    try {
      const result = await updatePoolsideSettings(toPoolsideUpdate(form));

      if (result.success) {
        toast.success("Poolside settings saved.");
        // Clear the key from the DOM as soon as it is stored: it is the one
        // value on this form that must not survive the save.
        setForm((prev) => (prev ? { ...prev, apiKey: "" } : prev));
        if (form.apiKey.trim() !== "") {
          setHasStoredApiKey(true);
        }
      } else {
        toast.error(result.error ?? "That didn't save. Try again.");
      }
    } catch {
      toast.error("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);

    try {
      setTestResult(describeTestResult(await testPoolsideConnection()));
    } catch {
      setTestResult({
        message: "The connection test failed to run.",
        ok: false,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <Cpu aria-hidden="true" className="size-4" />
          Poolside provider
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          Bring your own Poolside deployment, key and binary — any chat can be
          switched to run its turns through Poolside instead of Claude Code.
          Memory, skills, project instructions, GitHub access and plugin MCP
          servers all carry over.
        </p>
      </div>

      <div className="space-y-5 px-5 py-4">
        {loadError ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>Poolside settings couldn&apos;t be loaded.</span>
            <button
              className="btn btn-sm"
              onClick={() => void loadSettings()}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : (
          <PoolsideProviderForm
            form={form}
            hasStoredApiKey={hasStoredApiKey}
            onChange={handleChange}
            onSubmit={(event) => void handleSubmit(event)}
            saving={saving}
          />
        )}

        <div className="border-base-content/10 border-t pt-4">
          <h3 className="font-medium text-sm">What Poolside chats give up</h3>
          {limitations.length > 0 ? (
            <ul className="mt-2 space-y-1 text-base-content/60 text-xs">
              {limitations.map((limitation) => (
                <li className="flex gap-2" key={limitation.capability}>
                  <span aria-hidden="true">—</span>
                  <span>{limitation.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-base-content/60 text-xs">
              Nothing. Poolside reports support for everything Paco asks of a
              backend, so switching a chat to it changes which agent answers and
              nothing else.
            </p>
          )}
        </div>

        <div className="border-base-content/10 border-t pt-4">
          <h3 className="font-medium text-sm">Test the connection</h3>
          <p className="mt-1 text-base-content/60 text-xs">
            Spawns the binary and exchanges a bare handshake — the same first
            frames a real chat turn opens with, without starting a session. That
            proves Paco can start the Poolside agent, and it reports back which
            endpoint the binary resolved. It does not prove the key above is the
            one in use: a pool binary that is already signed in locally answers
            the handshake without it.
          </p>

          <button
            className="btn btn-sm btn-outline mt-3 w-fit"
            disabled={testing}
            onClick={() => void handleTestConnection()}
            type="button"
          >
            {testing ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            {testing ? "Testing…" : "Test connection"}
          </button>

          {testResult ? (
            <div
              className={
                testResult.ok
                  ? "alert alert-success alert-soft mt-3"
                  : "alert alert-error alert-soft mt-3"
              }
              role="alert"
            >
              {testResult.ok ? (
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="wrap-anywhere">{testResult.message}</p>
                {testResult.serviceMode ? (
                  <p className="mt-1 wrap-anywhere opacity-80">
                    It resolved{" "}
                    <span className="font-mono">{testResult.serviceMode}</span>
                    {" — "}
                    check that against the base URL above. A handshake against
                    the wrong endpoint succeeds just as happily as one against
                    the right endpoint.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
