"use client";

import type { Capability } from "@paco/plugin-kit";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDestructiveConfirm } from "@/hooks/use-destructive-confirm";
import { toast } from "@/lib/toast";
import {
  disablePluginAction,
  grantAndEnableAction,
  installPluginAction,
  removePluginAction,
} from "./actions";
import { ConsentDialog } from "./consent-dialog";
import { InstallDialog } from "./install-dialog";
import { IngressSecretDialog } from "./ingress-secret-dialog";
import { getPluginNetDomainsAction } from "./manifest-actions";
import { PluginCard } from "./plugin-card";
import type { PluginListRow } from "./plugin-list-row";
import { removeWithConfirm, toggleEnabled } from "./plugin-mutations";
import { pluginStatusAction, type PluginStatus } from "./plugin-status-action";

interface PluginsPageContentProps {
  initialPlugins: PluginListRow[];
}

/** How often the page re-polls just the live host status (Task 12's `plugin-status-action.ts`). */
const STATUS_POLL_MS = 5000;

/** The plugin currently going through (or about to go through) the consent step. */
interface ConsentState {
  pluginId: string;
  requested: Capability[];
  netDomains: string[];
  initialGrants: Capability[];
}

/**
 * The interactive half of `/settings/plugins`.
 *
 * Unlike `AgentsPageContent`/`SchedulesPageContent`, this never fetches its
 * own manifest/grant data: `page.tsx` (a Server Component) fetches it once,
 * and every mutation here reconciles with the server via `router.refresh()`
 * rather than a second client-side list action. Consent is the security
 * surface this whole page exists for, so the source of truth for "what is
 * this plugin actually allowed to do" is always a fresh server read, not a
 * client cache this component decided to trust.
 *
 * Live host state is the one thing polled independently, on its own
 * interval (`pluginStatusAction`, `./plugin-status-action.ts` — Task 12):
 * a plugin crashing or finishing its startup has nothing to do with a
 * manifest or grant changing, so it would be wasteful to re-fetch every
 * row's data on the same cadence just to notice a state transition.
 */
export function PluginsPageContent({
  initialPlugins,
}: PluginsPageContentProps) {
  const [plugins, setPlugins] = useState(initialPlugins);
  const [statuses, setStatuses] = useState<Record<string, PluginStatus>>({});
  const [installOpen, setInstallOpen] = useState(false);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [ingressSecret, setIngressSecret] = useState<{
    pluginId: string;
    secret: string;
  } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const router = useRouter();
  const { confirm, dialog: destructiveDialog } = useDestructiveConfirm();

  useEffect(() => {
    setPlugins(initialPlugins);
  }, [initialPlugins]);

  // Polled on its own interval, separately from `initialPlugins` (which only
  // changes on a `router.refresh()`): live host state — a plugin crashing or
  // finishing its startup — has nothing to do with a manifest or grant
  // changing, and re-fetching every row on this cadence would be wasteful.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const next = await pluginStatusAction();
        if (!cancelled) {
          setStatuses(next);
        }
      } catch {
        // A transient poll failure just leaves status stale until the next
        // tick — not worth surfacing as a page-level error.
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  /**
   * Opens the consent step for `pluginId`, fetching the manifest's exact
   * `net:fetch` domain list first — the consent screen must show that list
   * verbatim (spec Section 2), never a placeholder. A failed lookup falls
   * back to an empty list rather than guessing: understating what a plugin
   * could reach is a UX gap, not a security bypass, since the host enforces
   * against `consentedNetDomains` (snapshotted server-side at grant time)
   * regardless of what this screen manages to display.
   */
  async function openConsentFor(
    pluginId: string,
    requested: Capability[],
    initialGrants: Capability[],
  ) {
    const domains = await getPluginNetDomainsAction(pluginId);
    if (!domains.ok && requested.includes("net:fetch")) {
      toast.error(
        "Could not load this plugin's declared domain list — showing none.",
      );
    }
    setConsent({
      pluginId,
      requested,
      initialGrants,
      netDomains: domains.ok ? domains.netDomains : [],
    });
  }

  function handleInstalled(result: {
    pluginId: string;
    requested: Capability[];
  }) {
    setInstallOpen(false);
    void openConsentFor(result.pluginId, result.requested, []);
    router.refresh();
  }

  async function handleUpdate(row: PluginListRow) {
    setUpdatingId(row.id);
    try {
      const result = await installPluginAction({ source: row.source });
      if (!result.ok || !result.pluginId || !result.requested) {
        toast.error(result.error ?? `${row.id} could not be updated.`);
        return;
      }
      const requested = result.requested;
      const carriedGrants = row.grantedCapabilities.filter((granted) =>
        requested.includes(granted),
      );
      await openConsentFor(result.pluginId, requested, carriedGrants);
      router.refresh();
    } catch {
      toast.error(`${row.id} could not be updated.`);
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleToggle(row: PluginListRow, enabled: boolean) {
    setTogglingId(row.id);
    const previous = plugins;
    setPlugins((rows) =>
      rows.map((r) => (r.id === row.id ? { ...r, enabled } : r)),
    );

    try {
      const result = await toggleEnabled(row, enabled, {
        grantAndEnableAction,
        disablePluginAction,
      });
      if (!result.ok) {
        setPlugins(previous);
        toast.error(result.error ?? `${row.id} could not be updated.`);
      }
    } catch {
      setPlugins(previous);
      toast.error(`${row.id} could not be updated.`);
    } finally {
      setTogglingId(null);
      router.refresh();
    }
  }

  async function handleRemove(row: PluginListRow) {
    setRemovingId(row.id);
    try {
      const result = await removeWithConfirm(
        row.id,
        () =>
          confirm({
            title: `Remove ${row.id}?`,
            description:
              "This stops its host process and deletes its installed files from disk. This cannot be undone.",
            confirmLabel: "Remove",
          }),
        removePluginAction,
      );
      if (result === null) {
        return;
      }
      if (result.ok) {
        setPlugins((rows) => rows.filter((r) => r.id !== row.id));
      } else {
        toast.error(result.error ?? `${row.id} could not be removed.`);
      }
    } finally {
      setRemovingId(null);
      router.refresh();
    }
  }

  async function handleGrant(grants: Capability[]) {
    if (!consent) {
      return { ok: false, error: "Nothing is awaiting consent." };
    }
    return grantAndEnableAction({ pluginId: consent.pluginId, grants });
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Plugins</h1>
          <p className="mt-1 text-sm text-base-content/60">
            Third-party plugins this instance runs, and exactly what each one is
            allowed to do. Installing fetches and validates a manifest only —
            nothing runs until its capabilities are reviewed and granted.
          </p>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => setInstallOpen(true)}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" />
          Install plugin
        </button>
      </div>

      {plugins.length === 0 ? (
        <div className="mt-4 rounded-lg border border-base-300 py-8 text-center text-base-content/60 text-sm">
          No plugins installed yet.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              onRemove={() => void handleRemove(plugin)}
              onToggleEnabled={(enabled) => void handleToggle(plugin, enabled)}
              onUpdate={() => void handleUpdate(plugin)}
              plugin={plugin}
              removing={removingId === plugin.id}
              status={statuses[plugin.id] ?? "not-running"}
              togglingEnabled={togglingId === plugin.id}
              updating={updatingId === plugin.id}
            />
          ))}
        </div>
      )}

      <InstallDialog
        onInstall={async (source) => {
          const result = await installPluginAction({ source });
          if (result.ok && result.pluginId && result.requested) {
            return {
              ok: true,
              pluginId: result.pluginId,
              requested: result.requested,
            };
          }
          return {
            ok: false,
            error: result.error ?? "That plugin could not be installed.",
          };
        }}
        onInstalled={handleInstalled}
        onOpenChange={setInstallOpen}
        open={installOpen}
      />

      {consent ? (
        <ConsentDialog
          initialGrants={consent.initialGrants}
          netDomains={consent.netDomains}
          onGrant={handleGrant}
          onGranted={(result) => {
            // `ingressSecret` is present only on the ONE call that mints a
            // plugin's `channels:ingress` secret (`grantAndEnableAction`'s
            // own doc comment) — every later re-grant/re-enable omits it, so
            // there is nothing to show then, and this dialog is the only
            // place its plaintext is ever surfaced.
            if (result.ingressSecret) {
              setIngressSecret({
                pluginId: consent.pluginId,
                secret: result.ingressSecret,
              });
            }
            router.refresh();
          }}
          onOpenChange={(open) => {
            if (!open) {
              setConsent(null);
            }
          }}
          open={consent !== null}
          pluginId={consent.pluginId}
          requested={consent.requested}
        />
      ) : null}

      {ingressSecret ? (
        <IngressSecretDialog
          onOpenChange={(open) => {
            if (!open) {
              setIngressSecret(null);
            }
          }}
          open={ingressSecret !== null}
          pluginId={ingressSecret.pluginId}
          secret={ingressSecret.secret}
        />
      ) : null}

      {destructiveDialog}
    </>
  );
}
