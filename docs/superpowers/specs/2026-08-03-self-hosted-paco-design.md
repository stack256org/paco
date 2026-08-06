# Self-hosted Paco: organisation, invite-only auth, one-command install, preview routing

Status: approved design, not yet implemented
Date: 2026-08-03

## What this is

Paco becomes an open-source product someone installs on their own VPS with one
command. A single organisation lives on each installation. The first person to
arrive creates it and becomes its owner; everyone else gets in by invitation.
There is no public sign-up, no marketing site, and no uninstall path — a broken
install is replaced by a fresh one.

Previews of the apps the agent builds are served on subdomains of a domain the
operator configures after installation.

## Goals

- One command on a bare Ubuntu VPS produces a working Paco.
- One public image on GHCR serves every installation.
- Upgrades are one command. Uninstall is out of scope.
- Domain and SMTP are configured in the product, not at install time.
- TLS is optional and off until the operator turns it on.
- Previews are private by default, shareable per preview.

## Non-goals

- Multiple organisations per installation. One install, one organisation.
- Wildcard TLS certificates. Per-host certificates only (see Phase 4).
- Uninstall tooling.
- Landing or marketing pages. The unauthenticated app is a sign-in box.

## The constraint that shapes everything

`NEXT_PUBLIC_APP_URL` is inlined at build time, **including in server code**.
Verified against the production build in this repo:

```text
process.env.NEXT_PUBLIC_APP_URL  →  0 occurrences under .next/server
what is there instead:  for (let t of [e, "http://localhost:3066"]) { … }
```

Turbopack replaced the lookup with the literal from the build machine. A public
image built in CI would therefore point every installation at CI's URL, and it
would fail silently — the app boots and magic links point somewhere nobody is
browsing.

Nothing in the browser reads the value. Its three importers — `app/layout.tsx`,
`app/workflows/chat.ts`, `lib/auth/config.ts` — are all server-side. The prefix
buys nothing and costs runtime configurability, so it goes.

---

## Phase 1 — Runtime configuration

**Rename `NEXT_PUBLIC_APP_URL` to `APP_URL`.** Without the prefix Next leaves
`process.env.APP_URL` as a real runtime lookup. Remove the `ARG`/`ENV` pair from
the Dockerfile and the `build.args` block from `docker-compose.yml`; compose
pulls the published image rather than building it.

Resolution order for the public origin:

1. the domain saved in `instance_settings`
2. `APP_URL` from the environment, for operators who know their domain at
   install time
3. `http://localhost:<PORT>`, so a fresh install always works

**Restart semantics, stated honestly.** `lib/auth/config.ts` reads
`appUrl().origin` at module load into better-auth's `baseURL`. A domain saved in
Settings therefore cannot fully apply to the auth endpoints until the process
restarts. The design accepts this rather than hiding it:

better-auth is already configured as `baseURL: { allowedHosts, fallback }`, so it
derives the origin from the *request host* whenever that host is allowed. The
only thing that must be true at process start is that the configured domain is
in `allowedHosts`. That gives a simpler mechanism than threading an async
resolver through every call site:

- `appUrl()` stays synchronous and env/default-based, for module-load consumers.
- `docker-entrypoint.sh` — which already applies migrations before starting the
  server — reads the configured domain from `instance_settings` and exports it
  as `APP_URL` when the variable is not already set explicitly. A restart is
  therefore all it takes for the whole app to agree on the new origin, with no
  lazily-initialised auth config and no second resolution path in application
  code.
- Saving a domain shows that a restart is needed to finish applying it, with a
  button that performs it through the Docker socket Paco already mounts.

SMTP needs no such treatment: it is read when a message is sent, from the
background worker, which is already asynchronous. Changing SMTP settings takes
effect immediately.

**SMTP moves into the database.** `instance_settings` gains host, port, secure,
user, sealed password, and from-address. The password is sealed with
`lib/crypto/secret-box.ts` (`seal`/`open`), the same mechanism as GitHub tokens,
because nodemailer needs the original on every send. `SMTP_*` environment
variables remain a fallback so existing compose deployments keep working.
Settings gains a "send a test email" action, since a wrong SMTP setting
otherwise surfaces only when an invitation silently fails.

### Data model

`instance_settings` gains: `app_domain`, `tls_enabled`, `smtp_host`,
`smtp_port`, `smtp_secure`, `smtp_user`, `smtp_password_sealed`, `smtp_from`,
`preview_base_domain`.

---

## Phase 2 — Organisation and invite-only access

**Two tables, not better-auth's organisation plugin.** The plugin brings
org-switching, slugs and invitation machinery built for multi-tenancy this
product does not have, and its schema would be harder to walk back than two
tables we own.

- `organizations` — `id`, `name`, `created_at`. At most one row.
- `organization_members` — `organization_id`, `user_id`, `role`
  (`owner` | `admin` | `member`), `created_at`.

Sessions and chats stay owned by users. The organisation is the membership
boundary: who may sign in, who may invite, who may see the usage page.

**Invitations replace open sign-up.** A new `invitations` table holds `email`,
`role`, `token`, `invited_by`, `expires_at`, `accepted_at`.
`assertSignUpAllowed()` in `lib/auth/signup-policy.ts` changes from "first user,
or the global toggle is on" to "first user, or a live unaccepted invitation
exists for this address". The `allow_new_users` toggle and
`app/settings/signup-access-section.tsx` are removed — an instance-wide "anyone
may join" switch is exactly what this phase exists to delete.

**First run signs the admin in directly.** With no SMTP configured there is no
way to deliver a magic link, and telling an operator to read `docker logs` to
sign in to their own install is not acceptable. When the users table is empty
the sign-in page renders a registration form; submitting it creates the user,
creates the organisation, makes that user its owner, and establishes a session
with no email round trip. This is safe precisely because it is only reachable
when no account exists — the same condition that already grants first-user
admin in `lib/auth/config.ts`.

Once any account exists the form is gone and the only route in is a magic link
to an invited address.

**Delete the marketing surface.** `components/landing/*` and the unauthenticated
landing page go. Signed out, Paco is a sign-in box.

---

## Phase 3 — Installer, upgrade, and the published image

**Image.** `ghcr.io/stack256org/paco`, public, multi-architecture
(`linux/amd64`, `linux/arm64`). A release workflow beside the existing
`.github/workflows/ci.yml` builds and pushes on a version tag, publishing both
the tag and `latest`.

**Installer.** `curl -fsSL https://raw.githubusercontent.com/stack256org/paco/main/install.sh | sh`

The script is non-interactive. It:

1. checks it is running as root on a systemd Linux host;
2. installs Docker Engine and the compose plugin if absent;
3. creates `/opt/paco`, writes `docker-compose.yml` and a generated `.env`
   containing `APP_SECRET` and a Postgres password from `openssl rand`;
4. pulls the image and starts Paco, Postgres and Traefik;
5. prints the URL to open — `http://<server-ip>` — and stops.

No domain, no SMTP, no certificate. Those are configured in the running product.
Flags exist for operators who want them set upfront (`--port`, `--app-url`), and
`APP_URL` is honoured if exported.

**One published port.** Traefik owns `:80` from the moment of install, and `:443`
additionally once TLS is enabled. Paco itself is *not* published to the host —
it is reachable only through Traefik, which routes the catch-all host to it
until a domain is configured and continues to route that domain afterwards.

This is a deliberate reading of two things that were asked for together: "expose
one port" and "at first it will be on localhost with some port, maybe 3000".
Publishing Paco on `:3000` *and* Traefik on `:80` would be two ports and two
different URLs for the same app, with the URL changing the moment a domain was
added. Routing everything through Traefik from the start means one port, one
URL that keeps working, and no second code path that only ever runs before a
domain exists. `--port` moves Traefik's HTTP entrypoint for anyone who needs
`:80` free.

**Upgrade.** `install.sh` also installs a small `paco` command. `paco upgrade`
pulls the newest image and recreates the containers; migrations run in
`docker-entrypoint.sh` as they do today. `paco logs`, `paco restart` and
`paco status` round it out. There is no `paco uninstall`.

**Testing.** Krova Cloud is the test target: `krova cubes create --image
ubuntu-24.04-docker`, then run the installer over `krova ssh`, then assert the
sign-in page answers. Every installer change is validated on a fresh Cube, since
the only interesting bug class here is "works on a machine that already has
things installed".

---

## Phase 4 — Preview routing with Traefik

**Traefik with the Docker provider, driven by labels.** Sandbox containers
already carry a `Labels` map (`packages/sandbox/docker/sandbox.ts`), so routing
is set where the container is created. Traefik watches the Docker socket, and no
file needs to stay in step with container lifecycle.

Paco and the sandboxes share a Docker network so Traefik reaches containers
directly. Sandbox ports stop being published to the host once routing is on,
which also removes today's random host-port surface.

**Per-host certificates, not a wildcard.** A `*.previews.example.com`
certificate requires a DNS-01 challenge and therefore a DNS-provider API token —
a per-provider credential the installer would have to prompt for, which
contradicts a non-interactive install. Instead the operator points a wildcard
*DNS record* at the server, and Traefik issues an individual certificate per
preview hostname over HTTP-01 as each router appears. No provider credential,
any registrar, and TLS stays genuinely optional: the ACME resolver is defined in
static config but only referenced by routers when the operator enables TLS, so
turning it on is a label change rather than a Traefik restart.

**Access control.** Previews are private by default and shareable per preview.
A private preview's router carries a forward-auth middleware pointing at a new
Paco endpoint, which authorises the request against the session and the
preview's visibility. Making one public removes the middleware. Visibility is a
column on the chat that owns the sandbox.

**Hostnames.** `<chat-slug>.<preview_base_domain>`, where the slug is derived
from the chat id — already unguessable, and stable across restarts so a shared
link keeps working.

---

## Phase 5 — Usage and monitoring

One page, visible to organisation admins and owners, extending the existing
`app/settings/usage/`:

- running sandboxes, with the chat each belongs to and its uptime
- workspace disk usage per session, and the total against the volume
- token and cost totals per member, from the existing `usage_events` table
- Postgres reachability and pending-migration state
- the last errors from the job queue, since a silently failing queue currently
  looks like nothing happening

Read-only. Actions that already exist elsewhere are not duplicated here.

---

## Error handling

Failures in this design are mostly configuration failures, and the rule is that
each names the setting that is wrong and where to change it:

- SMTP unset while inviting: refuse the invitation with a message pointing at
  Settings, rather than queueing mail nothing can deliver.
- SMTP wrong: surfaced by the test-email action, not by a silent invitation.
- Domain saved but DNS not pointed: previews resolve nowhere; the settings page
  states the record required and what it should point at.
- TLS enabled before DNS resolves: ACME fails per host; Traefik keeps serving
  the preview over HTTP and the failure is reported on the monitoring page
  rather than only in Traefik's logs.
- Installer on a host without systemd or with Docker already present in a
  broken state: fail before writing anything to `/opt/paco`.

## Testing

- `lib/app-url.ts` resolution order, including the DB override and the localhost
  default, as unit tests.
- `assertSignUpAllowed()` across its four cases: first user, live invitation,
  expired invitation, no invitation.
- First-run: registration renders only when the users table is empty, and the
  route refuses once any account exists.
- Traefik label generation for a sandbox: private and public, TLS on and off, as
  a pure function over sandbox state.
- The installer end-to-end on a fresh Krova Cube, asserting the sign-in page
  answers.

## Build order

Phase 1 first: it unblocks the published image and both Phase 2 and Phase 4
depend on runtime configuration existing. Phase 3 can proceed in parallel with
Phase 2 — the installer does not care about the auth model. Phase 4 needs the
domain from Phase 1 and the installed Traefik from Phase 3. Phase 5 last.

**Each phase gets its own implementation plan.** This document is the shared
design; it is deliberately too large to implement in one pass, and a plan that
tried to would be impossible to review. Phase 1 is the first plan to write.

## Consequences worth naming

- `pnpm build` output stops being environment-specific. That is the property
  that makes one public image legitimate, and it is a behaviour change for
  anyone currently baking their own image with the build argument; they pass
  `APP_URL` at run time instead.
- Removing `allow_new_users` removes the only way to open an instance to the
  public. That is intended, and it is a breaking change for any existing
  install relying on it.
- Sandbox ports stop being published to the host once preview routing is on.
  Anything depending on `localhost:<random-port>` moves to the preview
  hostname.
