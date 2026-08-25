import type { Capability } from "@paco/plugin-kit";

export interface ConsentFormProps {
  /** The manifest's declared capabilities — never widened here, only chosen from. */
  requested: Capability[];
  /** The manifest's exact `net:fetch` domain list, shown verbatim. */
  netDomains: string[];
  grants: Capability[];
  onGrantsChange: (grants: Capability[]) => void;
  disabled?: boolean;
}

/**
 * Plain-language line for every entry in `CAPABILITIES`
 * (`packages/plugin-kit/capabilities.ts`) — this is the security UX the
 * whole install flow exists for, so each line was checked against what the
 * host actually enforces (`packages/plugin-host/SECURITY.md`), not against
 * what the capability's name merely suggests.
 *
 * Typed as `Record<Capability, string>` rather than a list or a `switch`:
 * adding a capability to `CAPABILITIES` without adding its line here is a
 * type error, not a silently blank row on the consent screen.
 */
const CAPABILITY_COPY: Record<Capability, string> = {
  "events:subscribe":
    "See every session event for chats in this instance — messages, tool calls, and status updates, including the human's.",
  "messages:post": "Post messages into a chat, as if a person had typed them.",
  "tools:register": "Add its own tools that the model can call during a turn.",
  "net:fetch":
    "Make outbound HTTP requests — restricted to exactly the domains listed below, and nowhere else.",
  "storage:kv": "Store and read its own private data on this server.",
  "ui:panel": "Show a sandboxed panel it controls inside the app.",
  "tasks:create": "Create a task on the board from an inbound message.",
  "channels:ingress":
    "Receive inbound webhook requests sent to its own /api/channels URL, authenticated with a per-plugin secret.",
};

function withToggled(
  grants: Capability[],
  capability: Capability,
  checked: boolean,
): Capability[] {
  return checked
    ? [...grants, capability]
    : grants.filter((granted) => granted !== capability);
}

/**
 * The consent screen's actual content: an honest isolation summary, drawn
 * from `packages/plugin-host/SECURITY.md`'s "What is NOT enforced" section,
 * plus one checkbox per REQUESTED capability with `CAPABILITY_COPY`'s line.
 *
 * Deliberately never says "sandboxed" or "fully isolated" — this plugin
 * process is not a container, has no CPU/memory limit, can force-kill the
 * host, and leaves `process.platform`/`arch`/`pid` readable, all per
 * SECURITY.md. Overclaiming here would be worse than saying nothing: an
 * operator granting capabilities is trusting this text to be complete.
 *
 * Split out of `ConsentDialog` (which owns the `Dialog`/`Portal` chrome) so
 * it renders with `renderToStaticMarkup` in tests — Base UI's `Dialog` does
 * not render outside a browser, the same reason `AgentEditorForm` is split
 * out of `AgentEditorDialog` (see that file's docstring).
 */
export function ConsentForm({
  requested,
  netDomains,
  grants,
  onGrantsChange,
  disabled = false,
}: ConsentFormProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border border-base-300 bg-base-200/50 p-3 text-base-content/70 text-xs">
        <p>
          This plugin runs as its own process, never inside Paco&apos;s server,
          and starts with none of your secrets or tokens. It cannot open a
          shell, load native code, or reach the network beyond the domains you
          approve below.
        </p>
        <p>
          It is <strong>not a container</strong> — there is no OS-level sandbox,
          and a bug in Node&apos;s own permission model would be an escape from
          all of this. It has no CPU or memory limit and can force-kill this
          server outright, since it runs as this server&apos;s child process. It
          can also read a few harmless facts about this machine — its platform,
          architecture, and process id.
        </p>
      </div>

      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="sr-only">Requested capabilities</legend>
        {requested.map((capability) => (
          <label
            className="flex items-start gap-3 rounded-md border border-base-300 p-3"
            key={capability}
          >
            <input
              checked={grants.includes(capability)}
              className="checkbox checkbox-sm mt-0.5"
              onChange={(event) =>
                onGrantsChange(
                  withToggled(grants, capability, event.target.checked),
                )
              }
              type="checkbox"
              value={capability}
            />
            <span className="min-w-0">
              <span className="block font-mono text-xs">{capability}</span>
              <span className="block text-sm">
                {CAPABILITY_COPY[capability]}
              </span>
              {capability === "net:fetch" ? (
                <span className="mt-1 block text-base-content/60 text-xs">
                  Domains:{" "}
                  {netDomains.length > 0
                    ? netDomains.join(", ")
                    : "none declared — this grant would allow no outbound requests"}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
