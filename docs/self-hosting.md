# Running Paco yourself

Operator notes for a Paco instance you own: how to install it, what to back
up, how to restore it, who is allowed to sign in, how to upgrade, and where
the disk goes.

This describes the **native package** (systemd + `apt`) — the only supported
production path. Development is a separate thing and stays Docker-based; see
[docs/contributing.md](contributing.md) if that's what brought you here.

---

## 1. Installing

```bash
curl -fsSL https://apt.stack256.org/install.sh | sudo sh
```

> **This is live and verified.** `apt.stack256.org` serves a signed index over
> a Let's Encrypt certificate, and the command above works.
>
> **What has been verified**, on bare Ubuntu 24.04 VMs, by installing the real
> `.deb` and driving it in a browser rather than with `curl`:
>
> - `systemctl is-active paco` → `active`; `/` → 307 to `/onboarding`, then 200.
> - Postgres listens on the loopback only, the port is closed from off-host,
>   and a TCP connection is refused even locally — the role is passwordless and
>   peer-auth only, by design (§4).
> - `/etc/paco/paco.env` is `640 root:paco`, and neither generated secret
>   appears anywhere in the install output.
> - The bundled Claude Code CLI runs as the `paco` user; `/usr/bin/paco` is the
>   operator CLI, not the service entrypoint; the sudoers rules pass `visudo`.
> - The whole first-run walk: claim the instance → Platform → Mail (with a bad
>   SMTP server's verbatim error) → Done, and the **Restart now** button
>   actually restarting the unit.
> - `APP_SECRET`, the database, and `/var/lib/paco/.claude` all survive
>   reinstall → `apt remove` → reinstall. `apt purge` removes exactly the two
>   things it says it will, and leaves the Postgres database alone (§10).
> - A real domain with a real Let's Encrypt chain, served over HTTPS — via the
>   platform's edge, with `paco tls` and **Request certificate** both correctly
>   declining rather than running certbot (§8).
> - And the delivery path itself, against the live repository: the keyring
>   fetched, `apt update` accepting the signature with no warning, and
>   `apt install paco` resolving and downloading the real 230&nbsp;MB package.
>
> That pass found five bugs that every earlier check had missed, each of which
> would have hit every install: a `devDependencies`-only `dotenv` that
> crash-looped the service, `.next/static` never packaged so every page loaded
> with no CSS or JavaScript, Settings pages prerendered at build time so
> Settings → Admin was permanently unreachable, a **Restart now** button
> calling deleted Docker code, and `paco-tls-hook` querying Postgres as the
> wrong user. Nothing before that pass exercised a page the way a browser does.
>
> Building the package yourself is still supported, and is what you want for a
> change you have not released — it has to be built on the same architecture it
> installs on, never cross-compiled:
>
> ```bash
> git clone https://github.com/stack256org/paco.git
> cd paco
> corepack enable && pnpm install --frozen-lockfile
> pnpm --dir apps/web exec next build   # not "pnpm --dir apps/web build" — that
>                                        # also runs migrations against a real
>                                        # database, which packaging must not do
> sh packaging/build-deb.sh 0.0.0-dev amd64   # or arm64 — match this host
> sudo apt install ./paco_0.0.0-dev_amd64.deb
> ```

Run as root — the installer refuses otherwise — on a host running systemd; it
refuses on anything else too, since there is no other supported native
install path. It optionally prompts for a domain first: pass `--domain`,
set `PACO_DOMAIN`, or just answer the prompt if one appears. None of that
ever blocks a piped `curl | sudo sh` — the prompt only appears when standard
input is a real terminal, so a pipe (which has none) skips straight past it
and installs with no domain, exactly as if `--domain ""` had been passed. Set
one later from Settings if you skip it here.

The real work happens in the package's own `postinst`, which runs on every
install *and* every upgrade:

- creates the `paco` system user and its home, `/var/lib/paco`;
- creates `/etc/paco` and generates `/etc/paco/paco.env` — **once, ever** —
  with a fresh `APP_SECRET`, the Postgres connection string, and the
  workspace root (see §2 and §12);
- creates the `paco` Postgres role and the `paco` database, over a Unix
  socket, as the `postgres` OS user — there is no TCP listener to reach, and
  no password, ever (peer authentication matches the connecting OS user to
  the Postgres role of the same name);
- installs an nginx site that proxies to the app on `127.0.0.1:3000`,
  gated on `nginx -t`: a config that fails the test is left untested and
  un-reloaded, with the previous config (or nginx's own stock page)
  continuing to serve, rather than taking the site down;
- enables and starts `paco.service`;
- warns — without failing the install — if the bundled Claude Code CLI is
  somehow missing (that means the `.deb` itself was built or staged
  incorrectly) or if `gh` isn't on `PATH` (it never ships bundled; see below).

If a domain was given, `install.sh` writes `APP_URL=http://<domain>` into
`paco.env` afterward and restarts the service — the one place the domain
prompt does something beyond cosmetic. `postinst` itself never touches
`paco.env` once it exists, on this or any later run.

It ends by printing:

```text
paco: installed. Open http://<this host>/ to finish setup.
```

### First run

Open that URL (or your domain, if you gave one). First run is a guided setup
that walks through claiming the instance:

1. **Account** — "Claim this instance." Not skippable: this is what makes an
   account exist at all, and the account created here becomes the
   administrator. One email address, one optional organisation name (defaults
   to "Paco").
2. **Platform** — confirms the address, preview domain, and TLS setting the
   installer already established (or left blank). The same form as **Settings
   → Admin → Domain**; nothing here is a one-time-only choice.
3. **Mail server** — the same form as **Settings → Admin → Mail server**.
   **Skippable**, with a warning that says exactly what skipping costs:
   nobody else can be invited until a mail server is set, because the invite
   form itself refuses without one. Finish it later from Settings if you skip
   it now.
4. **Done** — "Go to Paco."

Re-visiting `/` or `/onboarding` after this redirects straight past it; it
only ever runs once, for the account that claims the instance.

### What installing does not do for you

Three things need a manual step after `apt install paco` finishes, none of
which the package does automatically:

- **`sudo paco auth`** — see §3. Nothing runs a chat until this is done.
- **Docker, for chats.** The package only recommends Docker, it does not
  depend on it — Paco starts and serves its UI without it. To actually run
  chats:

  ```bash
  sudo apt install docker.io                                    # if not already present
  sudo usermod -aG docker paco && sudo systemctl restart paco    # let the service reach it
  ```

  Nothing in the package does the second step for you — without it, every
  chat fails trying to reach the Docker socket. See §14 if that happens
  after you've done both.

  The workspace image needs no step of its own: the first chat pulls
  `ghcr.io/stack256org/paco-sandbox` itself. It is a few gigabytes, so
  `docker pull ghcr.io/stack256org/paco-sandbox:latest` ahead of time moves
  that wait somewhere you chose.
- **A certificate**, if you want `https://`. See §8.

**Requirements, honestly:** a Linux host running systemd, root access, and
ports 80 and 443 free. nginx owns both, and there is no flag to move either
one (unlike the Traefik-based installer this replaced, which had `--port`).

---

## 2. The file layout

| Path | What's there |
| --- | --- |
| `/usr/lib/paco` | The app: `apps/web/server.js`, its migration scripts, and a real `node_modules` — plus a bundled Node runtime and the Claude Code CLI, both under `node/`, so nothing else needs installing on the host to run either one. |
| `/usr/bin/paco` | The operator command (`scripts/paco`): `upgrade`, `logs`, `restart`, `status`, `auth`, `tls`. See §3. |
| `/usr/lib/paco/paco-entrypoint.sh` | What `paco.service` runs: applies pending migrations, resolves a domain saved in Settings into `APP_URL`, then `exec`s the server so systemd signals the Node process rather than a wrapper. |
| `/usr/bin/claude` | A thin wrapper `exec`ing `/usr/lib/paco/node/bin/claude`, so `claude` is on `PATH` without also putting the bundled Node/npm/npx on it. |
| `/etc/paco/paco.env` | Configuration: `POSTGRES_URL`, `PGHOST`, `APP_SECRET`, `PACO_WORKSPACE_ROOT`, plus anything you or `install.sh --domain` add (`APP_URL`, `SMTP_*`). Mode `640`, owned `root:paco` — generated once by `postinst` and never regenerated. See §12. |
| `/var/lib/paco` | The `paco` user's home, and all of its state: `workspaces/` (every session's git repository and chat worktrees) and `.claude/` (the Claude Code credential, written by `paco auth`). This directory is the entire reason the delivery model changed — see §3. |
| `/etc/nginx/sites-available/paco` (+ `sites-enabled/paco`) | The nginx site proxying to the app. Edited by `paco tls` when you add a domain (§8). |
| `/lib/systemd/system/paco.service` | The systemd unit. `Requires=postgresql.service`; runs as `User=paco Group=paco`. |

A `paco` Postgres role and a `paco` database also exist, reached over
`/var/run/postgresql` — not a file under any of the paths above, and not
paco's own to remove (see §5).

---

## 3. `paco auth`, and why any of this is a `.deb` at all

The Claude Code CLI authenticates with a subscription, not an API key, so
there is a credential to keep. Under the Docker Compose deployment this
replaced, that credential lived on a named volume — durable in principle, but
one more piece of state an operator had to know to back up separately, and
exactly the kind of thing a `docker compose down -v` could take out by
accident (see the old deployment's own warnings about that command). Under
the native package it is a plain directory, `/var/lib/paco/.claude`, and
`dpkg` never touches `/var/lib/paco` on an upgrade — only `apt purge` does
(§5). **That's the whole reason the delivery model changed:** an `apt
upgrade` should never be able to sign Claude out, and a directory `dpkg`
already knows not to touch on upgrade is a simpler guarantee of that than a
Docker volume an operator has to remember exists.

```bash
sudo paco auth
```

Runs `claude auth login` as the `paco` user, so the credential lands at
`/var/lib/paco/.claude`. Do this before the first chat — without it, every
turn fails with nothing to run.

### The `paco` command

`/usr/bin/paco` is `scripts/paco`, installed byte-for-byte by
`packaging/build-deb.sh`. The service entrypoint lives separately at
`/usr/lib/paco/paco-entrypoint.sh`, so the two never collide.

| Command | What it does |
| --- | --- |
| `paco upgrade` | `apt-get update && apt-get install --only-upgrade paco` |
| `paco logs [-n N]` | Follow the unit's journal; extra args pass through |
| `paco restart` | Re-reads `paco.env` — the only way to apply a hand-edited `APP_URL` or `SMTP_*` |
| `paco status` | Unit state, installed version, configured domain, whether the bundled CLI is present, whether `paco` is authenticated |
| `paco auth` | Signs the `paco` user into Claude Code, so the credential lands in `/var/lib/paco/.claude` and survives every upgrade |
| `paco tls <domain>` | A certificate via certbot, DNS-checked first, nginx reloaded after. Optional — and skip it entirely if something in front of this host already terminates TLS (§8) |

There is no `uninstall`; it refuses on purpose and points at `apt remove` /
`apt purge` (§5).

---

## 4. Upgrading

```bash
sudo apt update && sudo apt upgrade paco   # or: apt-get install --only-upgrade paco
```

That's the whole mechanism — the same trust model and the same command as
every other package on the host, nothing Paco-specific to remember. It works
because `postinst` runs again on every upgrade (§1) and ends by restarting
`paco.service`, and the service's own entrypoint (`/usr/bin/paco`) applies
pending migrations every time it starts, not only at install:

```text
paco: applying migrations
paco: starting server
```

A failed migration fails the `systemctl start` that follows, which
`Restart=always` retries and `journalctl -u paco` explains — visibly, rather
than an `apt upgrade` that silently leaves migrations half-applied.

**Migrations are forward-only** — there is no down migration to run if a
release turns out to be wrong. Back up first:

```bash
sudo -u paco pg_dump -h /var/run/postgresql -Fc paco > pre-upgrade-$(date +%F).dump
```

---

## 5. Removing: `apt remove` vs `apt purge`

```bash
sudo apt remove paco     # stops Paco; keeps /etc/paco and /var/lib/paco
sudo apt purge paco      # stops Paco; destroys both
```

**`apt remove`** stops and disables the service and leaves `/etc/paco` and
`/var/lib/paco` exactly as they were. Nothing about your data changes — this
is what you want to pin a different version, work around a bad package, or
reinstall cleanly without losing the Claude credential or a single
workspace.

**`apt purge`** does the same, then deletes both directories — and says
exactly what it's about to destroy before doing it, since there is no
`debconf` confirmation prompt available by this point in a maintainer
script:

```text
paco: purging — this destroys:
paco:   /etc/paco (APP_SECRET and paco.env)
paco:   /var/lib/paco (chat workspaces, Claude credentials, everything under it)
paco: the Postgres database is NOT touched — see postrm if you also want it gone.
```

It also removes the nginx site files it installed, reloading nginx if the
result still tests clean.

**Neither one touches the `paco` Postgres role or database**, on purpose,
even on purge — they live inside the `postgresql` package's own data
directory, which is that package's lifecycle to own, not paco's. If you want
them gone too:

```bash
sudo -u postgres dropdb paco
sudo -u postgres psql -c "DROP ROLE paco"
```

Do this only after you've decided you don't want the data — there's no
prompt here either.

---

## 6. Backup and restore

Three things to back up, matching §2's file layout. A backup that covers
only one of them is not a backup.

### Postgres

```bash
sudo -u paco pg_dump -h /var/run/postgresql -Fc paco > paco-db-$(date +%F).dump
```

Consistent snapshot; Paco keeps running while it takes it.

### Workspaces

```bash
sudo tar -C /var/lib/paco -czf paco-workspaces-$(date +%F).tar.gz workspaces
```

Not atomic, unlike `pg_dump` — a mid-turn agent can leave a half-written file
or an index lock in the archive. For a clean one, stop the sandbox
containers first (they restart automatically the next time a session
resumes):

```bash
docker stop $(docker ps -q --filter label=paco.sandbox=true)
```

This is usually the largest thing you own — a full clone plus one worktree
per chat. If your repositories all live on GitHub and people push regularly,
backing up Postgres and `APP_SECRET` only, and accepting that uncommitted
work is lost, is a defensible and much cheaper policy. Decide that on
purpose, not by skipping this section.

### The Claude credential

Simplest is not to back it up — after a restore, `sudo paco auth` again. To
keep it anyway, it's now a plain directory, not a Docker volume to unpack
through a throwaway container:

```bash
sudo tar -C /var/lib/paco -czf paco-claude-$(date +%F).tar.gz .claude
```

Treat that archive as a credential: it authenticates as your Claude
subscription.

### `APP_SECRET` and the rest of `paco.env`

```bash
sudo cp /etc/paco/paco.env paco-env-$(date +%F).txt   # contains APP_SECRET — store it encrypted
```

**Read this before you rely on any of the above.** `APP_SECRET` does two
jobs (`apps/web/lib/auth/config.ts`, `apps/web/lib/crypto/secret-box.ts`): it
signs auth sessions, and it derives — via scrypt with a fixed salt — the
AES-256-GCM key that encrypts every stored GitHub token. **A database
restored under a different `APP_SECRET` loses every GitHub token
permanently** — the ciphertext is authenticated, so decryption fails
outright instead of returning garbage, and there is no recovery path short
of every user pasting a new personal access token into Settings →
Connections. The failure is quiet: `getGithubToken()` catches the error,
logs it, and returns `null`; Settings → Connections keeps showing the
account as connected, because that view reads the login and scopes columns
and never decrypts anything — only pushes and pull requests behave as though
nothing were connected. So: back up `paco.env`, specifically `APP_SECRET`,
in a password manager or secrets store — not only as the file sitting on the
machine you're backing up. Changing `APP_SECRET` also signs everyone out
immediately, which is the visible half of the same event.

### Restore

Onto a fresh install of the same package (`sudo apt install paco`, which
generates a *new* `paco.env` you're about to overwrite):

```bash
# 1. Stop the service before anything below touches its state.
sudo systemctl stop paco

# 2. Put the environment back, with the ORIGINAL APP_SECRET — not the one
#    the fresh install just generated.
sudo cp paco-env-2026-01-01.txt /etc/paco/paco.env
sudo chown root:paco /etc/paco/paco.env && sudo chmod 640 /etc/paco/paco.env

# 3. Workspaces and the Claude credential, at the same absolute path.
sudo tar -C /var/lib/paco -xzf paco-workspaces-2026-01-01.tar.gz
sudo tar -C /var/lib/paco -xzf paco-claude-2026-01-01.tar.gz   # if you kept it
sudo chown -R paco:paco /var/lib/paco

# 4. Recreate the database and load the dump. dropdb/createdb need to run as
#    the postgres OS user — the paco role owns the database but was never
#    granted CREATEDB (see postinst); pg_restore itself can run as paco.
sudo -u postgres dropdb --if-exists paco
sudo -u postgres createdb -O paco paco
sudo -u paco pg_restore -h /var/run/postgresql -d paco --no-owner \
  < paco-db-2026-01-01.dump

# 5. Start the app. Migrations run here, bringing an older dump up to date.
sudo systemctl start paco

# 6. Re-authenticate the agent if you didn't restore the credential.
sudo paco auth
```

The workspace path must land at the identical absolute path it had before:
Paco hands it to the Docker daemon when bind-mounting a workspace into a
sandbox, and git worktree pointers inside each repository record absolute
paths (`packages/sandbox/docker/layout.ts`). Restoring to a different
directory breaks every worktree.

Existing sandbox containers do not come back with the workspaces — a
container is host state, not part of either archive. Sessions show as
needing a resume, and resuming creates a fresh container over the restored
directory.

**Verify a restore:**

1. `journalctl -u paco` shows `paco: applying migrations` and then `paco:
   starting server`, with no crash in between.
2. Sign in. A restored `APP_SECRET` means existing session cookies still
   work; otherwise everyone gets a fresh magic link.
3. Settings → Connections says "connected" from the database regardless of
   whether decryption actually works — prove it by opening a session and
   pushing, or by checking the server log for "could not be decrypted."
4. Open an existing session, resume the workspace, and check the file list
   and diff — this exercises the workspace directory and its worktrees for
   real.
5. Send a message in a chat. A turn running end to end is the only real
   proof the durable workflow tables came across correctly; the workflow
   bootstrap that `/usr/bin/paco` runs at every start is idempotent and will
   have recreated them if the dump was missing them.

---

## 7. Who can sign in, and who is the administrator

Sign-in is a magic link and nothing else: type an email address, receive a
single-use link valid for 10 minutes. There is no password, and there are no
social providers.

That makes account *creation* the thing to control, because better-auth
creates an account for any address it hasn't seen before. Two rules do it
(`apps/web/lib/auth/signup-policy.ts`, `apps/web/lib/auth/bootstrap-admin.ts`):

1. **The account created during first run's "Account" step (§1) becomes the
   administrator** — this is what claims the instance, and it can only ever
   happen once, while the instance has zero users.
2. **Every later account is refused**, unless an administrator has
   explicitly opened sign-ups.

The risk this defends against is specific: an instance reachable from the
internet, with an empty database, hands full ownership to whoever loads the
URL first. There is no password to guess and no step to get wrong — so on
any machine that is not `localhost`, **finish first run yourself before you
share the address.**

### Adding someone

1. Sign in as the administrator.
2. Settings → Admin, turn **sign-ups** on.
3. Have them sign in with their email address — that creates their account.
4. Turn sign-ups off again.

While sign-ups are on, anyone who can reach the URL can create an account, so
keep the window short. A refused sign-up looks like a failed sign-in and says
nothing about whether the address already exists. Signing *in* to an account
that already exists is never affected by this setting.

Administrators also get Settings → Users and the ability to delete every
stored GitHub credential at once (Settings → Admin). Deleting Paco's copy
does not revoke the token at GitHub — a personal access token belongs to the
user, who revokes it themselves. Nothing in the UI grants admin to a second
person; promotion is `UPDATE users SET is_admin = true` against the database.

---

## 8. DNS, TLS, and previews

### The app's own domain

One **A** (or **AAAA**) record, pointed at this host, is all the app itself
needs — no wildcard, since it only ever answers on the one hostname you give
it. Set it in Settings, or via `install.sh --domain` up front (§1).

### TLS is optional, and there are two ways to get it

Paco serves plain HTTP and works. A certificate is something you ask for when
you want one; nothing in `install.sh` obtains, installs, or configures TLS, and
no upgrade will start doing so.

**Before you reach for either method, check whether you already have HTTPS.**
On a platform that terminates TLS at its own edge, you do — and trying to get
your own certificate on the host is not just unnecessary, it fails in a way
that looks like a Paco bug:

| Your setup | What to do |
| --- | --- |
| A VPS with its own public IP, DNS pointed at it | Use either method below |
| Krova Cloud (a custom domain via `krova domains add`) | **Nothing.** HTTPS is provisioned and renewed for you |
| Cloudflare with the proxy on ("orange cloud") | **Nothing** for the browser-facing half |
| Behind a load balancer or reverse proxy you already run | **Nothing** — terminate there, as you already do |

The reason is the HTTP-01 challenge. Let's Encrypt answers it by connecting to
whatever your domain resolves to on port 80 — and on those platforms that is
the edge, not this host, so the challenge never arrives here and the
certificate can never be issued. `paco tls` detects this case: if the domain
already serves HTTPS, it says so and declines rather than blaming your DNS.

#### From Settings (**Admin → Certificate**)

Save a domain in **Admin → Domain** first, then use **Request certificate**.
It runs the same thing `paco tls` does, and shows you the host's own output —
including the reason for any failure, which is nearly always DNS not pointing
here yet, port 80 unreachable, or the edge-termination case above.

The app cannot run `certbot` itself; it runs unprivileged. It invokes
`/usr/lib/paco/paco-tls-hook` through a sudoers rule that takes **no
argument** — the hook reads the domain from the database itself, so this path
can only ever request a certificate for the domain your instance is configured
with, whatever the app sends.

If it reports that Paco is *not allowed* to run the hook, the package predates
that permission: `sudo apt install --reinstall paco` reinstalls the sudoers
rule.

#### From the command line

```bash
sudo paco tls example.com
```

Checks first — before installing anything or touching nginx — that
`example.com` actually resolves to this host (`getent ahosts`, compared
against this host's own addresses). A bare IP is refused immediately;
Let's Encrypt never issues a certificate for one. Only once that passes does
it install `certbot` and its nginx plugin, add the domain to the nginx
site's `server_name`, and run `certbot --nginx` with the HTTP-01 challenge.
Safe to re-run for a domain that already has a certificate — an unexpired
one is left alone.

**Read the scope carefully: one hostname, over HTTP-01, nothing more.**
There is no wildcard certificate and no DNS-provider credential involved,
which is what keeps this a single command instead of an account with a DNS
API — but it also means **a preview hostname is not covered**. Each preview
is its own hostname (see below), and `paco tls` only ever obtains a
certificate for the one domain you name it. Nothing in this package obtains
certificates for previews at all.

`paco tls` does not flip `APP_URL` from `http://` to `https://` for you —
it prints a reminder instead. Do that in Settings, or by hand in
`/etc/paco/paco.env` followed by `sudo paco restart`.

### Previews

Each chat can be reached at its own hostname — `<slug>.<preview base
domain>`, the slug derived from the chat's id — once an operator sets a
**preview domain** in **Settings → Admin → Domain** (also part of first
run's "Platform" step). Until it's set, the Preview tab says so and links to
Settings instead of a dead link.

**The DNS record is a wildcard A record** — `*.previews.example.com`,
pointed at this host — because a chat's slug isn't known ahead of time; one
record covers every chat that will ever exist.

**How it's routed.** Unlike the Traefik deployment this replaced, which
discovered sandbox containers dynamically through Docker labels, Paco itself
now writes nginx configuration: one generated `server {}` block per active
preview, under `/etc/paco/nginx/paco-preview-<hostname>.conf`
(`apps/web/lib/preview/nginx-config.ts`), proxying to whichever container
published the chat's dev server. Before every reload it snapshots every file
it's about to touch, so a failed `nginx -t` restores exactly what was there
before rather than leaving a half-written config.

**Why that directory and not `/etc/nginx/conf.d`.** Paco runs as the
unprivileged `paco` user, and `/etc/paco/nginx/` is a directory it owns. A
small root-owned shim at `/etc/nginx/conf.d/paco-previews.conf` does nothing
but `include /etc/paco/nginx/*.conf;`. The alternative — making nginx's own
configuration directory writable by the service — would let Paco write
arbitrary nginx configuration, which is a far larger grant than routing a
preview needs.

Reloading still needs root, so `postinst` installs `/etc/sudoers.d/paco`
(mode `0440`) granting the `paco` user exactly two commands and nothing else:
`nginx -t` and `systemctl reload nginx`. It is written to a temporary file
and validated with `visudo -cf` before being moved into place — a malformed
sudoers file locks out `sudo` entirely on the host, which needs console
access to undo.

If a preview hostname fails to come up, `journalctl -u paco` after opening
the link is where a `sudo: a password is required` or a permission error
writing under `/etc/paco/nginx` would appear.

**Privacy is enforced the same way as before, just fronted by nginx instead
of Traefik.** Every preview's `location /` runs `auth_request` against
`GET /api/preview-auth` before proxying anywhere — the same
`decidePreviewAccess` logic as the old deployment, unchanged. New previews
are **private** by default; the chat owner can make one **public** from the
Preview tab, after a warning worth repeating here: a public preview can be
opened by **anyone with the link, no sign-in required**, serving whatever
code the agent has just written — code that may be wired to real credentials
or real data. Treat "make public" as putting a URL on the open internet,
because that is what it does.

One narrowing worth knowing about: nginx's `auth_request` module only
understands three outcomes from that subrequest — 2xx (allow), 401, and 403
(deny) — anything else becomes a bare internal 500. The old Traefik
forward-auth relayed *any* response, including a 302 that let a private
preview's owner get redirected through a "grant" round-trip when their
Paco session cookie couldn't otherwise reach the preview's own hostname.
Both `nginx-config.ts` and the `/api/preview-auth` route's own comments
acknowledge that this redirect no longer survives the move to nginx as
literally as the plain allow/deny paths do — so a private preview's owner,
opening it for the first time without already holding that preview's grant
cookie, may see a 500 rather than being signed in automatically.

#### Previews over HTTPS

Settings has a **Serve previews over HTTPS** toggle. It only takes effect for
a preview hostname that *already* has a certificate on this host, at:

```text
/etc/paco/preview-certs/<preview hostname>/fullchain.pem
/etc/paco/preview-certs/<preview hostname>/privkey.pem
```

**Nothing in this package puts certificates there.** `paco tls` covers one
hostname over HTTP-01 and explicitly excludes previews, and there is no
wildcard support — so unless you are placing certificates in that directory
yourself (from a wildcard you obtained elsewhere, or your own automation), a
preview has no certificate and this toggle changes nothing for it.

A preview without a certificate is served over plain HTTP. That is deliberate,
and it is a change: the toggle used to make every preview's nginx block name a
certificate path whether one existed or not. nginx checks `ssl_certificate`
paths when it tests a config, so a missing file failed `nginx -t` — and because
preview routes are all reconciled together, **no preview on the instance could
be routed at all** until the toggle was turned off again. Serving HTTP is the
correct degradation; refusing to serve is not.

**Only port 3000 gets a preview hostname.** A dev server on any of the other
published ports (§9) has no hostname of its own, preview domain or not.

---

## 9. Ephemeral sandbox ports, published directly by Docker

Independent of preview hostnames, every sandbox container also publishes
`DEFAULT_SANDBOX_PORTS` (`apps/web/lib/sandbox/config.ts`) straight to the
host:

| Container port | Typical use |
| --- | --- |
| 3000 | Next.js, Express, Remix |
| 5173 | Vite, SvelteKit |
| 4321 | Astro |
| 8000 | Python / Django dev servers |

- **The host port is ephemeral.** Paco asks Docker for `HostPort: "0"`, so
  each container gets whatever's free — that's what lets several sandboxes
  run at once. Find them with `docker ps --filter label=paco.sandbox=true`.
- **Not proxied through Paco, and not the preview-hostname path above.** A
  raw port URL (`http://localhost:<ephemeral-port>`) is handed to your
  browser as-is. Nothing about reaching a container this way is
  authenticated, and a chat's private/public setting has no effect on it —
  that setting only governs the nginx-routed hostname.
- **On a public machine, these bind all interfaces by default.** Whatever an
  agent starts on 3000, 5173, 4321, or 8000 inside a sandbox becomes
  reachable from outside on the mapped port unless a firewall says
  otherwise — regardless of whether a preview domain is configured, and
  regardless of that chat's visibility setting. Check `docker ps` and your
  firewall rules on any instance with a public IP.

---

## 10. Disk usage and cleanup

Sandboxes hibernate on inactivity — 30 minutes idle, with a hard bound just
under 5 hours (`docs/agents/sandbox-lifecycle.md`). Hibernation is `docker
stop`; nothing is deleted, which is what makes resuming instant.

| What | Rough size | Reclaim with |
| --- | --- | --- |
| `paco-sandbox:latest` | a few GB, once | `docker image rm` (rebuild before the next sandbox starts) |
| Stopped sandbox containers | small each, but one per session forever | `docker rm` |
| Workspace directories (`/var/lib/paco/workspaces`) | one clone plus one worktree per chat, plus whatever the agent installs | `rm -rf` the directory |
| Postgres | message history and cached diffs | `pg_dump`/`VACUUM FULL`, or delete old sessions |

Sandbox containers are labelled, so they're easy to enumerate:

```bash
docker ps -a --filter label=paco.sandbox=true
docker rm $(docker ps -aq --filter label=paco.sandbox=true --filter status=exited)
```

A container is named `paco-sbx-session_<sessionId>`, and its workspace is
`/var/lib/paco/workspaces/session_<sessionId>` — the session id ties the two
together. Removing a stopped container is safe: Paco recreates it by name
over the same workspace on the next resume.

```bash
sudo du -sh /var/lib/paco/workspaces/* | sort -h | tail -20
```

**Deleting a workspace directory is destructive.** You lose every
uncommitted change and every `chat/<id>` branch that was never pushed —
those branches exist only in that clone. For a session created from a
GitHub repository, the next resume finds no repository in `repo/` and
re-clones it from the remote, so the session keeps working but starts from
the remote's state; for a session not created from a repository, there is
nothing to re-clone. Verify this on your own setup before relying on it for
work you care about.

Paco has no garbage collector for containers or workspaces — everything
above is manual, safe to run on whatever schedule you choose.

---

## 11. Archiving and deleting a session

**Archive** (the button in the UI): refreshes the session's git and
pull-request state, marks it `archived` and hides it from the default list,
then — in background work after the response — stops the sandbox (`docker
stop`) and clears the runtime part of its state. It does **not** remove the
container and does **not** touch the workspace directory; chat branches and
worktrees are untouched. Unarchiving sets it back to `running`; the
workspace is still there and resumes normally.

**Delete** removes the session's rows from Postgres and nothing else — a
single `DELETE`, with foreign keys cascading to its chats, messages, read
markers, and workflow runs. The container and the workspace directory
survive as orphans, cleaned up by hand using the naming in §10. The current
UI exposes Archive, not Delete; deletion is available on the API (`DELETE
/api/sessions/<sessionId>`). Deleting a *user* cascades to their sessions the
same way, with the same orphaned containers and directories left behind.

Deleting a *chat* removes its worktree but deliberately keeps its
`chat/<id>` branch, so commits aren't discarded just because disk was freed.

---

## 12. Environment variables

Everything lives in `/etc/paco/paco.env` — a flat `KEY=value` file, mode
`640`, owned `root:paco`. Hand-edit it and run `sudo paco restart` (or
`sudo systemctl restart paco`) to apply a change; nothing re-reads it on its
own.

### Written once by `postinst`, at first install — don't hand-edit these

| Variable | What it is |
| --- | --- |
| `POSTGRES_URL` | `postgres:///paco` — no host, no password. Both driver libraries Paco uses reject a non-empty username with an empty host outright, so the connection string is deliberately bare; `PGHOST` below and OS-user peer authentication supply the rest. |
| `PGHOST` | `/var/run/postgresql` — the socket directory. |
| `APP_SECRET` | Signs sessions and derives the key that encrypts stored GitHub tokens. Generated once; regenerating it invalidates both. See §6 before you consider changing it. |
| `PACO_WORKSPACE_ROOT` | `/var/lib/paco/workspaces`. |
| `NODE_ENV` | `production`. |
| `PORT` | `3000` — matched by the nginx site's `proxy_pass http://127.0.0.1:3000`. Changing one without the other breaks routing: nginx will keep answering requests but silently proxy to the wrong (or no) port. Edit `/etc/nginx/sites-available/paco` too, `nginx -t`, then reload, if you ever change this. |

### Yours to set

| Variable | What it does | Set it via |
| --- | --- | --- |
| `APP_URL` | Public origin, scheme and port included. Source for magic-link URLs, pull-request links, and the origins better-auth accepts a sign-in callback from. Unset falls back to the domain saved in Settings, then to `http://localhost:3000`. | `install.sh --domain`, Settings, or by hand in `paco.env` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | Outbound mail for magic links and invites. Unset `SMTP_HOST` means links are logged instead of sent — fine for a first look, not for anyone else to sign in. | Settings → Admin → Mail server (recommended), or `paco.env` |

**Settings and the environment don't merge.** If a mail host is saved in
Settings, every `SMTP_*` variable above is ignored entirely, including
fields Settings leaves blank — a partly filled Settings form does not fall
back to the rest of the environment, it just sends unauthenticated. Pick one
place to configure mail.

### Set by Paco itself — do not set these

| Variable | Why |
| --- | --- |
| `WORKFLOW_POSTGRES_URL` | Overwritten with `POSTGRES_URL` by `lib/db/migrate.ts`, and ignored at runtime regardless. |
| `WORKFLOW_TARGET_WORLD` | Always `@workflow/world-postgres`. |
| `PACO_APPROVAL_URL`, `PACO_APPROVAL_TOKEN`, `PACO_APPROVAL_CHAT_ID` | Injected per turn so the approval hook can call back into Paco. Meaningless outside that process. |

---

## 13. Instance health

Settings → Health (admin only) answers "is this instance healthy, and what
is it costing me?" without grepping logs or opening `psql`. It's read-only;
reclaiming disk or editing SMTP still happens from Settings → Admin.

- **Queue.** pg-boss delivers every sign-in and invitation email; when it
  stalls, nothing looks broken anywhere else — the symptom a user reports is
  "I never got the email." Reads as *idle*, *working*, *backed-up* (the
  oldest pending job has waited long enough that a magic link sent then has
  already expired), or *failing*. Backed-up or failing means check the mail
  server, not the application.
- **Migrations.** *In sync* is normal. *Pending* names the migrations that
  haven't run — **the card's own text still says to run `pnpm --dir apps/web
  db:migrate:apply`, which is stale, dev-oriented copy that predates this
  package and won't even work against what a native install actually has on
  disk.** On a native install, `sudo systemctl restart paco` is what applies
  pending migrations — they run at every service start (§4), not only at
  install. *Out of order* is rarer and sharper: either a migration recorded
  as applied with a timestamp newer than one still in the journal, or the
  reverse. Either shape can make the migrator silently skip entries in
  between while still reporting success — don't run one blindly out of that
  state; compare `drizzle.__drizzle_migrations` against
  `apps/web/lib/db/migrations/meta/_journal.json` first.
- **Spend.** Per-member token totals and estimated cost over a selectable
  window. Tokens on a model with no published price are marked `unpriced`
  rather than folded into the total as if free.
- **Storage & containers.** The same disk and container counts as §10,
  summarized read-only here.

Any card can read **Unavailable** instead of a number — Postgres or Docker
unreachable — which is deliberately not the same as zero: a metric that
couldn't be read is unknown, not clean.

---

## 14. Troubleshooting

### "Paco couldn't download the workspace image"

Paco pulls `ghcr.io/stack256org/paco-sandbox` on the first chat, so this means
the pull failed rather than that a build step was skipped. Reproduce it by hand
to see what the registry actually said:

```bash
docker pull ghcr.io/stack256org/paco-sandbox:latest
docker images ghcr.io/stack256org/paco-sandbox
```

- `denied` or `manifest unknown` — the package is not readable anonymously.
  That is a publishing fault on our side, not yours; please open an issue.
- A timeout or DNS failure — this host cannot reach `ghcr.io`. On a network
  that does not allow it, mirror the image internally and set
  `PACO_SANDBOX_IMAGE` in `/etc/paco/paco.env` to your copy, then
  `sudo systemctl restart paco`.

A locally built image still wins if it is tagged as what Paco asks for — the
pull only happens when the image is absent — which is how a development host
avoids the download entirely.

> Older installs failed with `Sandbox image "paco-sandbox:latest" is not built`
> and told you to `docker build` from a checkout. That was impossible on a host
> installed from the `.deb`, which has none. Upgrade, and the image is fetched
> for you.

### Chats fail immediately, or the agent never starts

```bash
sudo paco auth
sudo su -s /bin/sh -l paco -c "claude auth status"   # should print a logged-in account
```

### Chats fail trying to reach Docker, even though the image is built

Nothing in this package puts the `paco` user in the `docker` group — install
does not do it for you:

```bash
sudo usermod -aG docker paco
sudo systemctl restart paco
```

Group membership for `/var/run/docker.sock` is equivalent to root on this
host: a process that can reach it can create its own privileged container.
Grant it only where you're comfortable with that.

### `paco status` / `paco logs` / `paco tls` isn't a recognised command

See §3 — as this branch currently packages, none of `scripts/paco`'s
commands are installed onto the target system. Use the systemd/apt
equivalent from that table directly until it's fixed.

### GitHub actions fail, but Settings says connected

Two candidates. `gh` isn't installed — Paco says so plainly: *"Paco needs
GitHub's own command-line tool to do this, and it isn't installed on this
machine."* It's a `Suggests`, not bundled — `postinst` warns at install time
if it's missing, but install it yourself:
<https://github.com/cli/cli/blob/trunk/docs/install_linux.md>.

Or the stored token no longer decrypts because `APP_SECRET` changed — see
§6. The server log shows `Stored token for user … could not be decrypted`.
Either restore the original `APP_SECRET`, or have each user reconnect in
Settings → Connections.

### The sign-in link never arrives

With no mail server configured (§12), Paco doesn't send email — it logs the
message, link included:

```text
[email] SMTP is not configured; logging instead of sending.
```

```bash
sudo paco logs   # or: journalctl -u paco -f
```

Mail is delivered by a background worker, so it appears a moment after the
request. Links expire in 10 minutes and are single-use.

### Sign-in is refused for a new colleague

Expected — new accounts are off by default. See §7.

### Preview links don't open

- A **preview hostname** not resolving or refusing to load most likely means
  the sudoers/permissions gap in §8 — check `journalctl -u paco` right after
  opening the link.
- No preview domain set in Settings yet — the Preview tab says so.
- The wildcard DNS record isn't in place, or hasn't propagated.
- A private preview refusing you specifically, while opening for its owner,
  is the access check working as intended, not a fault — though see §8 for
  the one case (a private preview's *owner*, first visit) where that check
  itself may currently misbehave.
- A **direct ephemeral port link** only ever opens from this host itself (or
  through an SSH tunnel) — expected, see §9.

### An agent's work vanished after a restore

The workspace root has to land at the identical absolute path it had before
— see §6.
