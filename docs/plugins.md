# Plugins

Paco runs plugins in a separate, sandboxed OS process (`@paco/plugin-host`) —
see `packages/plugin-host/SECURITY.md` for exactly what that sandbox does and
does not enforce. This page covers installing a plugin and, as a worked
example, wiring up the first-party Slack channel plugin
(`plugins/first-party/slack/`).

## Installing a plugin

From **Settings -> Plugins** (admin only), click **Install a plugin** and
enter one of three source forms:

- `owner/repo` — a GitHub repo, default branch.
- `owner/repo#ref` — a GitHub repo pinned to a branch, tag, or commit.
- `local:/abs/path` — a directory already on the machine running Paco. This
  is how every plugin under `plugins/first-party/` in this repo is meant to
  be installed: point it at the plugin's own directory, e.g.
  `local:/opt/paco/plugins/first-party/slack` (use whatever absolute path
  this checkout lives at on your host).

Installing only fetches the plugin and validates its manifest — it is
registered **disabled, with no capabilities granted**. Nothing it asks for
in `plugin.json` takes effect until an admin reviews the request and grants
it explicitly:

1. **Install** copies (`local:`) or clones (GitHub) the plugin and parses
   `plugin.json`. A bad manifest, or a symlink anywhere in the plugin's
   directory tree, fails the install outright.
2. **Consent** shows exactly what the manifest requests — every capability
   in `plugin.json`'s `capabilities` array, and, for `net:fetch`, the exact
   `netDomains` it wants to reach — before anything is granted. Grant only
   what you intend the plugin to actually use.
3. **Enable** starts the plugin's worker process with the granted set. If
   the plugin has a `channels/` slot (this one does), enabling it also mints
   a per-plugin **ingress secret** and shows it to you **exactly once** — if
   you lose it, remove and re-enable the plugin to mint a new one.

### How an inbound webhook is authenticated

Each `channels/` slot picks one of two gates, declared per channel in
`plugin.json`'s `channels` array. A channel that says nothing gets the first.

- **`shared-secret`** (the default): the request must carry the plugin's
  ingress secret in an `x-paco-channel-secret` header, compared in constant
  time by `apps/web/app/api/channels/[pluginId]/[channel]/route.ts` before
  the request ever reaches the plugin's own code.
- **`self-verified`**: Paco does not check the secret, and the request
  reaches the plugin's handler unauthenticated. The handler is *supposed* to
  verify it — but nothing in Paco enforces that, and nothing can: the mode is
  a declaration, not a mechanism. A plugin that declares it and then verifies
  nothing has an open, unauthenticated endpoint, and Paco cannot tell the
  difference. Grant `channels:ingress` to a plugin with a self-verified
  channel only if you trust that plugin's own verification.

  It exists because real providers often cannot attach a custom header:
  Slack's Event Subscriptions UI takes a Request URL and nothing else, and
  signs the raw request body instead. Because opting in is a security
  decision the operator is making on the plugin's word, it is declared in the
  manifest — where the consent screen shows it, by channel name, before
  anything is granted — rather than chosen by plugin code at runtime.

Everything else applies to both. The `channels:ingress` grant, the
plugin-is-running check, the request body cap, and both rate limiters (one
per source IP across all plugins, one per plugin+channel+IP) run regardless
— and they carry more weight for a `self-verified` channel, since there is
no secret to turn an unauthenticated flood away at the door.

## Worked example: the Slack channel plugin

`plugins/first-party/slack/` mentions become tasks: `@`-mention the bot in a
Slack channel and it creates (and starts) a task on the matching Paco
session, then keeps the thread updated as that task's status changes.

### 1. Create the Slack app

At <https://api.slack.com/apps>, create an app "from a manifest" or by hand,
and configure:

- **OAuth & Permissions -> Bot Token Scopes**: add `app_mentions:read` (to
  receive mentions) and `chat:write` (to post the ack and status updates).
- **Install App to Workspace**, then copy the **Bot User OAuth Token**
  (`xoxb-...`) from this same page.
- **Basic Information -> App Credentials**: copy the **Signing Secret**.
  This never leaves Slack's and Paco's hands — it verifies that an inbound
  request actually came from Slack (Slack's v0 HMAC scheme, verified over
  the raw request body in `plugins/first-party/slack/lib/signature.ts`) and
  is never sent back to Slack itself.
- Leave **Event Subscriptions** off for now — its Request URL field needs
  the webhook URL `slack_setup` (below) returns, and Slack immediately
  sends a `url_verification` challenge to whatever URL you type there, which
  only succeeds once the signing secret is already stored.

### 2. Install and enable the plugin

Install `local:/abs/path/to/plugins/first-party/slack`, review the
requested capabilities in the consent dialog (`channels:ingress`,
`net:fetch` limited to `slack.com`, `messages:post`, `tasks:create`,
`events:subscribe`, `storage:kv`, `tools:register`), grant them, and enable
the plugin. Enabling still shows you an ingress secret, but this plugin's
channel does not use it (see "Why this channel verifies its own requests"
below) — it is there for any other channel you add to the plugin later.

### 3. Run `slack_setup` from a Paco chat

`slack_setup` is a model-facing tool this plugin registers (`tools:register`
above) — ask the agent to run it, or invoke it directly, with:

```json
{
  "botToken": "xoxb-...",
  "signingSecret": "...",
  "defaultSessionId": "<a Paco session id>",
  "appUrl": "https://paco.example.com",
  "channelMap": { "C0SLACKCHANNEL": "<a different session id>" }
}
```

- `botToken` is validated against Slack's `auth.test` before anything is
  stored — a bad token is reported back and nothing is written.
- `signingSecret`, the bot token, and `defaultSessionId` are stored in this
  plugin's `storage:kv`, scoped to it alone.
- `channelMap` is optional: a mention in a listed Slack channel routes to
  that session instead of `defaultSessionId`.
- The result includes **`webhookUrl`** —
  `<appUrl>/api/channels/slack/events` — which is what goes into Slack next.

### 4. Finish the Slack app config

Turn **Event Subscriptions** on, paste `webhookUrl` into **Request URL**
(Slack's `url_verification` challenge should succeed immediately, since the
signing secret is already stored), and under **Subscribe to bot events**
add `app_mention`. Save.

### Where each secret goes

| Value | Goes into | Notes |
| --- | --- | --- |
| Slack signing secret | `slack_setup`'s `signingSecret` input | Verifies Slack's own request signature. Never sent to Slack. |
| Slack bot token | `slack_setup`'s `botToken` input | Used to call `chat.postMessage`/`auth.test`. Never sent anywhere but `slack.com`. |
| Paco ingress secret | *(not used by this channel)* | The `events` channel is declared `self-verified`, so Slack's own request signature is the gate. See below. |
| Webhook URL | Slack's Event Subscriptions **Request URL** field | Returned by `slack_setup`; also constructable by hand as `<appUrl>/api/channels/slack/events`. |

### Why this channel verifies its own requests

Slack's Events API configuration has no field for adding a custom header to
its outbound webhook requests — it only lets you set the Request URL. So the
generic `x-paco-channel-secret` gate can never be satisfied by Slack itself.

Rather than require a reverse proxy to inject the header, this plugin's
`plugin.json` declares its channel `self-verified`:

```json
"channels": [{ "name": "events", "auth": "self-verified" }]
```

Paco therefore forwards Slack's request — raw body and all headers — to the
plugin without checking a secret, and this plugin's own signature check
(`lib/signature.ts`) is what authenticates it: an HMAC-SHA256 over
`v0:{timestamp}:{rawBody}` compared in constant time against
`x-slack-signature`, with the timestamp rejected outside a short window so a
captured request cannot be replayed. That check is the only thing between
the public internet and this plugin's handler, which is why it fails closed
on a missing header, a malformed signature, an unset signing secret, or an
unparseable timestamp.

The raw body matters: Slack signs the exact bytes it sent, so the ingress
protocol carries `rawBody` alongside the parsed payload. Re-serialising the
parsed JSON would produce a different byte string and every real signature
would fail.

### What the plugin does with each event

- **`url_verification`** — echoed back as `{challenge}`, after the request's
  Slack signature is verified.
- **`app_mention`** (first message in a thread) — creates a task
  (`api.tasks.create`) on the mapped session with `autoStart: true`, then
  posts a threaded acknowledgment naming the task id.
- **`app_mention`** (a reply inside a thread this plugin already started a
  task for) — posts the message into that task's existing chat
  (`api.postMessage`) instead of creating a second task.
- **A Slack retry** (`X-Slack-Retry-Num` present) — acknowledged with `200`
  without reprocessing, so a slow response doesn't create a duplicate task.
- **`task/status`** — posts a threaded status line for any task this plugin
  has a thread on file for.
- **`turn/end`** — posts a threaded note when a tracked task's chat finishes
  a turn cleanly. See the doc comment on
  `plugins/first-party/slack/hooks/task-updates.ts` for a known gap: session
  events don't currently carry a task's actual `resultSummary` text, so this
  posts the turn's outcome (`finishReason`) rather than the summary itself.
