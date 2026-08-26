"use client";

import { AlertTriangle, CheckCircle2, Cpu, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInstanceSettings,
  testOpenFxConnection,
  updateOpenFxSettings,
} from "@/lib/admin/instance-settings-actions";
import { toast } from "@/lib/toast";

type OpenFxFormState = {
  endpoint: string;
  binaryPath: string;
  /** Always starts empty — the server never sends the stored key back. */
  apiKey: string;
};

type TestResult = {
  ok: boolean;
  message: string;
};

/**
 * What a chat gives up by running on OpenFX, one line per capability
 * `OpenFxBackend.capabilities()` reports as unsupported.
 *
 * Written out here rather than read from the backend because this is a
 * client component and `@paco/openfx-backend` spawns processes — but it is
 * not free-floating copy: `openfx-provider-section.test.tsx` fails if this
 * list and that capability object ever disagree, in either direction. The
 * point is that choosing OpenFX stops being an invisible downgrade; the
 * composer hides the effort and model controls for the same reason
 * (`ModelEffortBackendControls`).
 */
export const OPENFX_LIMITATIONS: ReadonlyArray<{
  capability: string;
  text: string;
}> = [
  {
    capability: "effort",
    text: "Reasoning effort is not configurable — ACP has no setter for it, so the effort control is hidden on OpenFX chats.",
  },
  {
    capability: "models",
    text: "The model comes from the OpenFX binary's own config, not Paco's model picker, so the picker is hidden on OpenFX chats.",
  },
  {
    capability: "customAgents",
    text: "Paco's subagent roster and its per-agent model tiers do not apply; OpenFX delegates to its own internal subagents instead.",
  },
  {
    capability: "structuredOutput",
    text: "Turns that need a schema-shaped answer — task planning and the reviewer gate — cannot run on OpenFX.",
  },
];

/**
 * BYO OpenFX provider config: the API key and binary path a chat whose
 * backend is `"openfx"` runs against (Section 7 Task 5).
 *
 * The endpoint field is rendered but permanently disabled, and the heading
 * copy no longer offers it: PROTOCOL.md §1 found no flag or environment
 * variable that moves where the `openfx` binary sends provider traffic, so
 * it is stored for forward-compatibility only (`buildOpenFxBackendConfig`
 * says the same on the server side) rather than promised here.
 *
 * Mirrors `SmtpSection` (`app/settings/admin/smtp-section.tsx`) exactly —
 * same load/save/error shape, same "the secret never comes back down"
 * contract for `apiKey` as that section's password field. Rendered only for
 * admins (see `ModelsPageContent`), and re-checked server-side by
 * `requireAdmin` in every action regardless of what this component renders.
 */
export function OpenFxProviderSection() {
  const [form, setForm] = useState<OpenFxFormState | null>(null);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

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
        endpoint: settings.openfx.endpoint ?? "",
        binaryPath: settings.openfx.binaryPath ?? "",
        apiKey: "",
      });
      setHasStoredApiKey(settings.openfx.hasApiKey);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the OpenFX settings.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadSettings]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    setSaving(true);
    setTestResult(null);

    try {
      const result = await updateOpenFxSettings({
        endpoint: form.endpoint.trim() === "" ? null : form.endpoint.trim(),
        binaryPath:
          form.binaryPath.trim() === "" ? null : form.binaryPath.trim(),
        apiKey: form.apiKey,
      });

      if (result.success) {
        toast.success("OpenFX settings saved.");
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
      const result = await testOpenFxConnection();
      if (result.success) {
        setTestResult({ message: "OpenFX responded to initialize.", ok: true });
      } else {
        setTestResult({
          message: result.error ?? "The OpenFX binary refused the handshake.",
          ok: false,
        });
      }
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
          OpenFX provider
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          Bring your own OpenFX key and binary — any chat can be switched to run
          its turns through OpenFX instead of Claude Code. Memory, skills,
          project instructions, GitHub access and plugin MCP servers all carry
          over; what does not is listed below.
        </p>
      </div>

      <div className="space-y-5 px-5 py-4">
        {loadError ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>OpenFX settings couldn&apos;t be loaded.</span>
            <button
              className="btn btn-sm"
              onClick={() => void loadSettings()}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : (
          <form
            className="fieldset"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <label className="label" htmlFor="openfx-endpoint">
              Endpoint
            </label>
            <input
              className="input input-sm w-full"
              // Always disabled, not just while loading/saving: the OpenFX
              // binary has no flag or env var that overrides where it sends
              // provider traffic (PROTOCOL.md §1), so there is nothing an
              // admin could configure here that would do anything yet.
              disabled
              id="openfx-endpoint"
              onChange={(event) =>
                setForm((prev) =>
                  prev ? { ...prev, endpoint: event.target.value } : prev,
                )
              }
              placeholder="https://gateway.example.com"
              type="text"
              value={form?.endpoint ?? ""}
            />
            <p className="text-base-content/60 text-xs">
              Disabled: the OpenFX binary itself currently has no way to point
              at a custom endpoint, so this would have no effect on where it
              sends provider traffic.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="openfx-binary-path">
                  Binary path
                </label>
                <input
                  className="input input-sm w-full"
                  disabled={form === null || saving}
                  id="openfx-binary-path"
                  onChange={(event) =>
                    setForm((prev) =>
                      prev ? { ...prev, binaryPath: event.target.value } : prev,
                    )
                  }
                  placeholder="/usr/local/bin/openfx"
                  type="text"
                  value={form?.binaryPath ?? ""}
                />
                <p className="text-base-content/60 text-xs">
                  Leave blank to run whatever &quot;openfx&quot; resolves to on
                  PATH.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="openfx-api-key">
                  API key
                </label>
                <input
                  autoComplete="new-password"
                  className="input input-sm w-full"
                  disabled={form === null || saving}
                  id="openfx-api-key"
                  onChange={(event) =>
                    setForm((prev) =>
                      prev ? { ...prev, apiKey: event.target.value } : prev,
                    )
                  }
                  placeholder={
                    hasStoredApiKey
                      ? "A key is already stored — leave blank to keep it"
                      : ""
                  }
                  type="password"
                  value={form?.apiKey ?? ""}
                />
                <p className="text-base-content/60 text-xs">
                  Sent to OpenFX as AI_GATEWAY_API_KEY.
                </p>
              </div>
            </div>

            <button
              className="btn btn-sm mt-2 w-fit"
              disabled={form === null || saving}
              type="submit"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              {saving ? "Saving…" : "Save OpenFX settings"}
            </button>
          </form>
        )}

        <div className="border-base-content/10 border-t pt-4">
          <h3 className="font-medium text-sm">What OpenFX chats give up</h3>
          <ul className="mt-2 space-y-1 text-base-content/60 text-xs">
            {OPENFX_LIMITATIONS.map((limitation) => (
              <li className="flex gap-2" key={limitation.capability}>
                <span aria-hidden="true">—</span>
                <span>{limitation.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-base-content/10 border-t pt-4">
          <h3 className="font-medium text-sm">Test the connection</h3>
          <p className="mt-1 text-base-content/60 text-xs">
            Spawns the binary and sends a bare ACP initialize — the same first
            handshake a real chat turn opens with, without starting a session.
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
              <span>{testResult.message}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
