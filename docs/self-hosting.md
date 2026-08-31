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
curl -fsSL https://apt.stack256.org/paco/install.sh | sudo sh
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
  workspace root (see §2 and §20);
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
  incorrectly) or if `gh` isn't on `PATH` (it is a `Recommends`, so apt
  normally installs it, and it never ships bundled; see below).

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

Almost nothing. Docker is installed and started, the `paco` user is put in the
`docker` group, PostgreSQL and nginx are configured, a secret is generated and
the service is running — all before the installer returns. What is left:

- **`sudo paco auth`** — see §3. It needs your Claude account, so no installer
  can do it for you, and nothing runs a chat until it is done.
- **A domain**, entered in step 2 of the wizard, which will not continue without
  one. Not for reaching Paco — it answers on whatever address the request came
  in on, so the IP the installer prints works straight away — but for the links
  it *sends*. Invitations and sign-in links are built from this; unset, they are
  built from a localhost fallback and arrive in somebody else's inbox pointing
  at a host only this server can open. Point an A record at this host, then
  enter it. `--domain` at install time sets the same value up front.
- **A certificate**, if you want `https://`. See §8.

Two things that look like steps but are not:

- **The workspace image.** The first chat pulls
  `ghcr.io/stack256org/paco-sandbox` itself. It is a few gigabytes, so
  pulling it ahead of time moves that wait somewhere you chose — but doing
  nothing is fine. The tag is `v<your version>`, not `latest`; see §22 for the
  exact command.
- **The docker group.** `postinst` adds the `paco` user to it, so
  `apt install paco` is as complete as the `curl | sh` route. It only skips
  this if Docker is absent at that moment, and says so when it does. Be aware
  of what it grants: access to `/var/run/docker.sock` is equivalent to root on
  this host, because a process that can reach it can create its own privileged
  container. That is inherent to running containers on behalf of an agent
  rather than something this package adds — but it is real, and worth knowing
  before you put Paco on a host that does other things.

**Requirements, honestly:** a Linux host running systemd, root access, and
ports 80 and 443 free. nginx owns both, and there is no flag to move either
one (unlike the Traefik-based installer this replaced, which had `--port`).
And a **rootful** Docker daemon — the ordinary system-wide one, which is what
`install.sh` installs. Rootless Docker does not work; the next section says
exactly why.

### Rootless Docker is not supported

If you run Docker rootless — `dockerd-rootless.sh`, the socket under
`$XDG_RUNTIME_DIR` — **Paco cannot use it, and there is no configuration that
makes it work.** This is a real limitation, not a missing feature, and it is
stated here rather than left to be discovered because a rootless daemon
answers every call Paco makes and then breaks the workspace silently.

The reason is the uid. A sandbox container runs as *this host's own uid* —
`User: hostContainerUser()` in `packages/sandbox/docker/sandbox.ts` — and the
workspace is a bind mount shared by both sides: the agent edits files on the
host as the `paco` user, the container runs them, and git worktrees are
created on one side and resolved from the other. As that file puts it,
"matching the uid is the only arrangement where both sides can read and write
the same tree."

A rootless daemon puts the container in a user namespace, so the uid the
container claims is not the uid the kernel writes to disk. Measured on Ubuntu
24.04, with the stock `/etc/subuid` entry `ubuntu:100000:65536`:

```text
inside the namespace:   uid=106 gid=109
on the host afterwards: uid=100106 gid=100109
```

`paco` is uid 106 on a packaged install. So every file the sandbox created
came back owned by uid 100106 — an id that exists on no account on the
machine — and the service could neither read nor write its own workspace.
Writing into a normally-permissioned directory failed outright with
`Permission denied`.

Nothing in Paco can bridge that. There is no uid the container can claim that
arrives on the host as `paco`, and Paco is unprivileged, so it cannot chown
its way out either.

There is a second, more confusing symptom worth knowing about, because it
does not look like this at all. Paco talks to Docker through `dockerode`,
whose socket discovery (`docker-modem@5.0.7/lib/modem.js:80`) probes exactly
`$HOME/.docker/run/docker.sock` and then `/var/run/docker.sock`. It never
looks at `$XDG_RUNTIME_DIR/docker.sock`, which is where a rootless daemon
listens — and neither `packaging/paco.service` nor `paco.env` sets
`DOCKER_HOST`, which `dockerode` *does* honour. So on a host with **only** a
rootless daemon, `docker info` works perfectly in your shell while Paco
reports that Docker is not running. Setting `DOCKER_HOST` to the rootless
socket does not fix it; it just moves you to the uid problem above, which
Paco now detects and refuses up front (`docker info`'s `SecurityOptions`
contains `name=rootless`).

**What to do instead:** install the system-wide daemon, the one that runs as
root, and put the `paco` user in the `docker` group — which is what
`install.sh` and the package's `postinst` do on a host with no container
runtime. Be clear-eyed about what that grants: membership of the `docker`
group is equivalent to root on this host, because a process that can reach
`/var/run/docker.sock` can create its own privileged container. That is
inherent to running containers on behalf of an agent, and it is the reason
rootless is an attractive idea here — it simply cannot be made to work with a
shared-uid bind mount.

### "We couldn't set up a workspace", but only sometimes

If chats fail right after a reboot or right after an `apt upgrade`, and then
start working again on their own, this is what it was.

`paco.service` used to be ordered only against the network and PostgreSQL. It
had no `After=docker.service` at all, so on a boot where systemd happened to
start Paco first, Paco came up before `/var/run/docker.sock` existed and every
chat failed with `Cannot connect to the Docker daemon` until something
retried. A race, which is exactly why it was intermittent rather than
constant. The unit now carries:

```ini
After=network-online.target postgresql.service docker.socket docker.service
Wants=docker.service
```

`Wants=`, not `Requires=`, and the difference matters if you edit this file.
`Requires=` couples the two lifecycles: systemd would stop Paco whenever
Docker stopped, so upgrading `docker.io` — which restarts the daemon — would
take the whole web UI down and leave it down, and a host where Docker failed
to start would refuse to start Paco at all. `Wants=` + `After=` gets the
ordering without any of that. PostgreSQL keeps `Requires=` for the opposite
reason: migrations run against it before the server starts and every page
reads from it, so Paco genuinely cannot run without it, whereas Docker is
needed per chat and a chat that cannot start now explains itself.

`postinst` also asks for `docker.service` before it restarts Paco. Unit
ordering governs boot; a manual `systemctl restart` — which is what the
package script does — starts the unit immediately regardless, so an upgrade
that restarts Docker in the same apt run would otherwise recreate the same
race by hand.

Two smaller changes go with it. A preflight that finds no daemon now re-probes
twice, 250 ms and then 750 ms later, before failing the turn — enough for a
daemon restart landing mid-session, not enough to make a host whose Docker is
simply switched off feel slow. A daemon that *answers* and refuses (the
`docker` group) or reports itself rootless fails immediately: retrying those
is pure latency in front of an answer that is already correct.

### Paco says Docker is not running, but `docker version` works

Almost always one of two things, and the error message now names which.

The first is the rootless case above. The second happens on developer machines
more than servers: `dockerode` picks its socket by **existence**, not by
whether anything is listening. `docker-modem`'s `findDefaultUnixSocket` checks
`$HOME/.docker/run/docker.sock` first and uses it if the file is there,
falling back to `/var/run/docker.sock` only when it is not. A Docker Desktop
install that has since been replaced leaves that per-user socket behind, dead,
and every Docker client that reads `DOCKER_HOST` or looks at `/var/run` keeps
working while Paco addresses the corpse. Reproduced exactly that way on a Mac
running OrbStack:

```text
~/.docker/run/docker.sock   present, dead (Docker Desktop leftover)
/var/run/docker.sock        alive, OrbStack, server 29.4.0
```

Paco's error now names the socket it tried and, when a system-wide socket also
exists, says so. It deliberately does **not** fall back to the other socket on
its own. `dockerode` resolves the socket on every connection, so a preflight
that quietly succeeded against a socket the sandbox will not use would trade a
clear failure at the door for an obscure one halfway through creating a
container — and on a host that really is running two daemons, silently
preferring the one you did not name would put Paco's containers where your own
`docker ps` cannot see them.

The fix is one line, and it is yours to choose: either remove the stale socket,
or point Paco at the daemon you meant by adding

```ini
DOCKER_HOST=unix:///var/run/docker.sock
```

to `/etc/paco/paco.env` (`dockerode` honours it) and restarting `paco`.

---

## 2. The file layout

| Path | What's there |
| --- | --- |
| `/usr/lib/paco` | The app: `apps/web/server.js`, its migration scripts, and a real `node_modules` — plus a bundled Node runtime and the Claude Code CLI, both under `node/`, so nothing else needs installing on the host to run either one. |
| `/usr/bin/paco` | The operator command (`scripts/paco`): `upgrade`, `logs`, `restart`, `status`, `auth [claude\|poolside]`, `tls`. See §3. |
| `/usr/lib/paco/paco-entrypoint.sh` | What `paco.service` runs: applies pending migrations, resolves a domain saved in Settings into `APP_URL`, then `exec`s the server so systemd signals the Node process rather than a wrapper. |
| `/usr/bin/claude` | A thin wrapper `exec`ing `/usr/lib/paco/node/bin/claude`, so `claude` is on `PATH` without also putting the bundled Node/npm/npx on it. |
| `/etc/paco/paco.env` | Configuration: `POSTGRES_URL`, `PGHOST`, `APP_SECRET`, `PACO_WORKSPACE_ROOT`, plus anything you or `install.sh --domain` add (`APP_URL`, `SMTP_*`). Mode `640`, owned `root:paco` — generated once by `postinst` and never regenerated. See §20. |
| `/var/lib/paco` | The `paco` user's home, and all of its state: `workspaces/` (every session's git repository and chat worktrees), `.claude/` (the Claude Code credential, written by `paco auth`) and — if you use Poolside and signed in rather than pasting a key — `.config/poolside/` (written by `paco auth poolside`, §18). This directory is the entire reason the delivery model changed — see §3. |
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

A provider name is an optional first argument, added when the Poolside backend
(§18) grew a second credential to keep. Bare `paco auth` still means Claude and
always will — it is what every runbook and every older copy of this document
says — so `paco auth` and `paco auth claude` are the same command.
`paco auth poolside` is the other one, and §18 covers it: it runs `pool login`
as the same service user, into the same `/var/lib/paco` that `dpkg` does not
touch, for the same reason.

### The `paco` command

`/usr/bin/paco` is `scripts/paco`, installed byte-for-byte by
`packaging/build-deb.sh`. The service entrypoint lives separately at
`/usr/lib/paco/paco-entrypoint.sh`, so the two never collide.

| Command | What it does |
| --- | --- |
| `paco upgrade` | `apt-get update && apt-get install --only-upgrade paco` |
| `paco logs [-n N]` | Follow the unit's journal; extra args pass through |
| `paco restart` | Re-reads `paco.env` — the only way to apply a hand-edited `APP_URL` or `SMTP_*` |
| `paco status` | Unit state, installed version, configured domain, whether the bundled CLI is present, whether `paco` is authenticated, and how Poolside is signed in |
| `paco auth` | Unchanged: the same as `paco auth claude` |
| `paco auth claude` | Signs the `paco` user into Claude Code, so the credential lands in `/var/lib/paco/.claude` and survives every upgrade |
| `paco auth poolside` | Runs `pool login` as the `paco` user, for the Poolside backend (§18). You install `pool` yourself; extra arguments pass through to it |
| `paco tls <domain>` | A certificate via certbot, DNS-checked first, nginx reloaded after. Optional — and skip it entirely if something in front of this host already terminates TLS (§8) |
| `paco password` | Rotates the instance password; prompts twice (or reads stdin with `paco password --stdin`) |

There is no `uninstall`; it refuses on purpose and points at `apt remove` /
`apt purge` (§5).

---

## The instance password

Paco is protected by one password, checked by nginx before a request ever
reaches the app. The username is always `paco`.

It is set for you at install time. If you install with a terminal, you are
asked to choose one; if you pipe the installer (`curl ... | sudo sh`), there
is no terminal to ask on, so a strong password is generated and printed in
the closing summary. That summary is the only time it is printed — write it
down.

Change it at any time:

    sudo paco password

Nothing needs restarting. nginx re-reads the password file on every request,
so the new password works immediately and any browser holding the old one is
asked again on its next request. That re-prompt is what replaces signing out;
there is no sign-out button, because there is no session to end.

`paco status` shows whether the instance is still using the password
generated at install:

    Password:  set (still the one generated at install; change with 'sudo paco password')

Until it is changed, that generated password is also readable at
`/etc/paco/initial-password`, which is root-only. `paco password` deletes
that file, so its absence is what "the operator has set their own" means.

**This protection exists only where nginx does** — the `.deb` install. A
development checkout run with `pnpm web` has no nginx and no password, and
must not be exposed to a network.

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

`apt-get install paco` — with no `install.sh` — is itself a supported way to
get a first install, and `postinst` generates the instance password silently
on that path: nothing in apt's own output says a password exists. Read it
with:

    sudo cat /etc/paco/initial-password

and change it any time with:

    sudo paco password

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

(And, on a Poolside instance signed in from the terminal, `.config/poolside`
beside it — same reasoning, same commands, `sudo paco auth poolside` to
recreate it.)

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
# ...and `sudo paco auth poolside` too, on an instance that uses Poolside
# without an API key in Settings (§18).
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

**A preview is behind the same instance password as everything else — nothing
more, nothing less.** Every generated `server {}` block carries `auth_basic
"Paco"` reading `/etc/nginx/paco.htpasswd`, the identical pair the package
writes for the main site (§`The instance password`). There is no per-chat
public/private toggle, no "make public" action, and no shareable link that
bypasses it — a preview that used to be public before this change is no
longer reachable without the password. **To let someone else see a preview,
give them the instance password** (or rotate it with `sudo paco password`
once they no longer need access) — there is no narrower way to share one.

This replaced the old `auth_request` subrequest to `/api/preview-auth` and
its per-chat `decidePreviewAccess` logic entirely, along with the "grant
cookie" round-trip that used to sign a preview's owner in automatically. Both
are gone: `auth_basic` is a static check against one password file, so there
is no subrequest, no cookie, and no separate code path to fail into a bare
500.

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
| `ghcr.io/stack256org/paco-sandbox:v<version>` | a few GB, once | `docker image rm` (re-pulled before the next sandbox starts) |
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

## 12. Plugins

Paco can run third-party plugins. A plugin contributes model-facing tools,
subscribes to session events, posts messages into chats, creates tasks on the
board, or accepts an inbound webhook on a `channels/` slot — and its code runs
in a separate, hardened OS process, never in the Next.js process and never in a
request handler.

**Installing and granting capabilities is
[docs/plugins.md](plugins.md)** — the three-step install → consent → enable
flow, how an inbound webhook is authenticated, and a full worked example
wiring up the first-party Slack plugin. What follows is only the part an
operator has to run rather than click: the runtime requirement, where plugins
land on disk, and how each failure presents.
[`packages/plugin-host/SECURITY.md`](../packages/plugin-host/SECURITY.md) is
the authoritative statement of what the plugin sandbox does and does not
contain.

### The Node >= 24 floor, and what it looks like when you miss it

**Hardened plugin workers require Node >= 24, and `PluginHost.start()` refuses
below it.** It reads the version of the binary it is about to spawn and rejects
— naming the required version and the fix — rather than starting a worker
without the sandbox it promises.

**On the native package this is already satisfied and there is nothing to do.**
`packaging/build-deb.sh` bundles Node 24.19.0 at `/usr/lib/paco/node/bin/node`,
and that is the binary `paco.service` runs the server with, so plugin workers
inherit it through `process.execPath`.

It is a development checkout, or a hand-rolled deployment on a distribution's
own Node, that misses the floor — and when it does, **every enabled plugin
fails, all at once, for the same reason**:

- The Plugins page shows each of them with a **`not-running`** badge. Not
  `crashed` — a plugin that fails `start()` is never entered into the registry
  at all (`lib/plugins/registry.ts`), and `not-running` is what a plugin with
  no registry entry reports. There is no banner, and nothing on the page says
  the word "Node".
- The only diagnosis is one line in the server log, emitted once per plugin:

  ```text
  plugin registry: host runtime is below the required Node floor — every plugin
  will fail to start until PACO_PLUGIN_NODE_EXECUTABLE points at Node >= 24
  ```

  ```bash
  sudo paco logs | grep "plugin registry"   # or: journalctl -u paco
  ```

- The fix is to point `PACO_PLUGIN_NODE_EXECUTABLE` at a Node >= 24 binary in
  `/etc/paco/paco.env` and restart (§20). It is a pointer, not a bypass:
  `start()` re-checks whatever it resolves to and refuses again if that binary
  is also too old.

**Why the floor exists, since it is the kind of thing an operator is tempted to
work around.** Node >= 24 gates network sockets inside its permission model,
and that gate is the backstop behind every other claim in `SECURITY.md`. On
Node 22.x there is no socket gate, so the in-process module allowlist would be
the only barrier between a plugin and the network — a position three
adversarial reviews have already shown to be one missed name away from failing.
Two of those reviews got a real TLS connection out of a plugin holding no
network grant, on 22.21.1. There is no `hardened: false` for production; it
exists for that package's own tests and nothing else.

### Where plugins live on disk

`<data dir>/plugins/<plugin id>`, where the data dir is `PACO_HOME` if set and
otherwise the service user's home plus `/.paco`. **On the native package that
resolves to `/var/lib/paco/.paco/plugins`** — `postinst` uses `PACO_HOME` as a
shell variable while generating `paco.env` but never writes it into the file,
so the home-relative fallback is what actually applies, and the `paco` user's
home is `/var/lib/paco`. `PACO_PLUGINS_DIR` overrides the whole path (§20).

That directory is inside `/var/lib/paco`, so `apt remove` keeps it and
`apt purge` destroys it (§5) — but **§6's workspaces tarball does not cover
it**, because that archive names `workspaces` specifically. If you have
plugins installed, back up `/var/lib/paco/.paco` as well:

```bash
sudo tar -C /var/lib/paco -czf paco-data-$(date +%F).tar.gz .paco
```

Losing it costs you the installed plugin trees and every plugin's granted
state; the `plugins` table in Postgres survives in the database dump, so what
you get back after restoring only the database is a row pointing at a directory
that is no longer there — which fails the integrity re-check and shows as a
plugin that will not start.

### The other ways a plugin fails, and where each one shows up

| What happens | Where you see it |
| --- | --- |
| **A symlink anywhere in the plugin's directory tree.** Install refuses outright, and so does every later `start()`. The path-prefix permission model follows links, so a plugin shipping `escape -> /` would be granted the whole filesystem through its own directory — see `SECURITY.md`. A consequence: plugin dependencies must be real files, never a symlinked `node_modules`. | The install dialog's error, or `plugin registry: failed to start plugin, skipping` in the log |
| **The plugin's files changed on disk since install.** The recorded content hash is re-checked before every start. | Same log line; the plugin stays out of the registry and reads `not-running` |
| **The worker crashes after starting.** Up to three restart attempts, with no timed backoff — each attempt rides on whatever already calls into the registry (server boot, sandbox provisioning, a plugin-tool call). After the third, it is left crashed for good until you disable and re-enable it. | A **`crashed`** badge on the Plugins page, plus a logged crash per attempt |
| **A capability the plugin needs was never granted.** Nothing is enforced by the plugin; the host simply declines to act on its behalf. A plugin without `tools:register` contributes no tools, one without `events:subscribe` receives nothing. | Silently nothing happens. Compare the consent screen's grants against what the plugin's `plugin.json` asks for |
| **The ingress secret was lost.** It is shown exactly once, at enable time. | Remove and re-enable the plugin to mint a new one |

A broken plugin never fails a turn or a request. That is deliberate (the
degradation invariant), and it is also why nothing shouts at you: the cost of
"a plugin can never break a chat" is that a plugin that does nothing looks
exactly like a plugin that has nothing to do.

### Wiring Slack is a setup step with no UI

Worth knowing before you plan the work, because it is the one part of a plugin
install that does not happen in Settings. The first-party Slack plugin is
configured by running its `slack_setup` tool **from inside a Paco chat** —
ask the agent to run it, with the bot token, signing secret, app URL and
channel map as its input. There is no form for this anywhere in the interface,
and the plugin does nothing at all until it has been run. The full input shape,
and what each value is checked against, is in
[docs/plugins.md](plugins.md#3-run-slack_setup-from-a-paco-chat).

### The tool bridge, and the two variables it carries

A plugin's registered tools reach the agent over MCP through a small bridge
process (`apps/web/scripts/plugin-mcp-server.ts`) that Paco spawns per turn.
It is given exactly three environment variables — `PACO_INTERNAL_URL`,
`PACO_INTERNAL_TOKEN` and `PACO_PLUGIN_TOOLS` — and deletes every other key off
`process.env` before its first network call, recording on stderr which keys
survived. **These are set by Paco, per turn; never put them in `paco.env`**
(§20).

The callback URL is loopback, derived from `APP_URL`'s port — and `APP_URL` on
a native install usually names no port, so it falls back to `:80`. On this
package that is nginx, not the app: the bridge's call reaches the app back
through the same proxy a browser does. It works, and it is worth knowing about
if plugin tools fail on an instance where something unusual is answering on
port 80.

---

## 13. Memory

Paco distils durable notes out of chat turns and feeds a scored selection of
them back into later turns' system prompts. There are three scopes — project,
user, and organisation — all stored as plain markdown files with YAML
frontmatter, readable and editable by hand.

**There is nothing to turn on.** Memory is always active; the only operator
surface is **Settings → Memory**, where any member sees and edits their own
user memory, and an admin also sees the organisation's. Project memory is not
shown there at all.

### Where each scope actually lives

| Scope | Path | Written by |
| --- | --- | --- |
| **User** | `<data dir>/memory/users/<user id>/` | Post-turn distillation, and hand edits in Settings → Memory |
| **Organisation** | `<data dir>/memory/orgs/<org id>/` | Promotion only — never automatically |
| **Project** | `<session workspace>/repo/.paco/memory/` | Post-turn distillation only |

The data dir is `PACO_HOME`, or the service user's home plus `/.paco` — on the
native package, `/var/lib/paco/.paco/memory` (§12 has the same note for
plugins, and the same backup gap: §6's workspaces tarball does not include it).

### Project memory is not versioned, and is lost with the workspace

**Read this before you rely on project memory for anything.** Its path looks
like history and is not: `<session repo>/.paco/memory` is inside the session's
own clone on the host, which is a real git repository — but **nothing in Paco
ever stages or commits it.** There is no `git add` of that path anywhere,
`.paco/` is not in the baseline `.gitignore` Paco writes into a fresh
workspace, and no agent is told to commit it. So what it actually is:

- **Untracked files in one server-side checkout.** They accumulate under
  `/var/lib/paco/workspaces/session_<id>/repo/.paco/memory/` and are never
  pushed anywhere.
- **Invisible in a chat's diff.** Each chat works in its own worktree, a
  sibling directory; project memory is written into `repo/`, so it does not
  appear in `git status` inside a chat's worktree and no chat's pull request
  will ever carry it.
- **Lost when the workspace is.** Delete the workspace directory to reclaim
  disk (§10) and it is gone — and the re-clone that follows on the next resume
  brings back the remote's state, which never contained it. Restore to a
  different absolute path and the same thing happens.
- **Not shared between sessions.** Two sessions cloned from the same repository
  have two independent project memories, because they have two independent
  clones.

None of that is an oversight. The session repo is checked out on the default
branch, which Paco never pushes — its only publish path is a pull request from
a chat's worktree branch — so committing there would still share nothing;
committing from a chat's worktree instead would put distilled notes into the
diff a human reviews, on every turn. Neither is a thing to do to somebody's
repository unattended, so the files are left in the working tree and the
Settings → Memory copy says so.

Two consequences for you. The workspace tarball in §6 already covers project
memory, because it sits under `workspaces/`. Nothing makes it survive a
workspace reclaim, or reach another machine — **commit `.paco/memory` yourself
if you want it shared and reviewable.** Until you do, treat it as a cache that
improves turns in a long-lived session, not as a record.

User and organisation memory are unaffected by any of this: they live in the
data dir, keyed by id, and have no relationship to a repository at all.

### What runs, and when

- **Post-turn distillation.** After a qualifying turn, one cheap Haiku call
  extracts at most three project entries and two user entries. Turns with a
  prompt under 20 characters, or under 500 output tokens, are skipped as too
  trivial to teach anything. It costs a model call per qualifying turn.
- **Daily reflection, at 04:00 UTC.** A pg-boss cron job looks across up to 50
  recent turns for friction that repeats and proposes encoding it as a project
  skill. It is **human-gated by construction**: a proposal only ever files a
  `blocked` task on the board (§14), and never writes a skill file itself.
- **Promotion to org memory.** An admin's "promote" writes immediately. A
  non-admin member's promote writes nothing and files a `blocked` proposal task
  for an admin to review.

Two costs worth stating plainly. **Distillation and reflection are always
Claude Code**, not the chat's backend — so a chat you moved to Poolside
specifically to avoid Claude still has its memory distilled by Claude
(`lib/memory/distill.ts` says so at the call site). And **organisation memory
is injected into every member's turns**, so a promoted entry is shared context
for the whole instance; that is why promotion is admin-gated and never
automatic.

Nothing here can fail a turn. A missing or unreadable memory directory reads as
an empty list, and any unexpected error is logged and treated as "nothing to
add."

---

## 14. Tasks and orchestration

**`/tasks`** is an organisation-wide board — reached from the sessions list, not
from Settings. A task is a unit of work with a goal, optionally an assigned
roster agent, and a session to run in; starting one creates a chat, runs an
unattended agent turn against it, and moves the task through
`todo → running → review → done`.

**There is nothing to turn on**, and no environment variable. What an operator
needs to know is where an unattended turn can stop, because a stopped task waits
for a human indefinitely.

### The state machine, and every place it stops

`todo → running → review → done` is the happy path. The edges that matter to an
operator are the ones that end somewhere else:

- **`blocked`** — a running task hit an approval prompt, or one of the cases
  below. Nothing moves it but a person, from the board's unblock dialog.
- **`failed`** — the turn could not be started or could not run. Offers Retry,
  which puts it back to `todo`.
- **A reviewer rejection loops back to `running`, but only twice.** On the
  third it goes `blocked` instead of looping forever.
- **`done` is terminal.** There is no edge out of it.

### Four ways an unattended task ends that are not "it worked"

1. **An approval prompt.** An unattended turn hits exactly the same approval
   gate a human's chat does, and there is nobody watching it. The task blocks.
2. **No reviewer in the roster.** With no *enabled* `reviewer` agent, the gate
   auto-approves and records `"No reviewer configured; auto-approved."` — the
   task reaches `done` without anything having reviewed it. That only happens
   if someone disabled the seeded `reviewer` (§15); builtin agents cannot be
   deleted.
3. **A chat running on Poolside.** The reviewer answers through structured
   output, which Poolside cannot produce (§18). The gate detects this *before*
   spending a turn and blocks the task with
   `Not reviewed: backend "poolside" cannot produce structured output …`. It
   deliberately does not pass the task, does not fail it, and does not try to
   read a verdict out of free text.
4. **The 200-turn cap.** An unattended task gets `TASK_DEFAULT_MAX_TURNS`
   rather than the much larger interactive default, so a runaway task fails
   loudly instead of burning turns indefinitely.

### The planner

"Plan this goal" on the new-task dialog hands the goal to a headless planning
turn that decomposes it into a tree: a root grouping node plus one child per
unit of work. Two things follow from that:

- **The root is never startable.** `startTask` refuses a task with children —
  it is a container, not work. Start its leaves, or use the column action that
  starts every `todo` leaf under it.
- **The planner needs a materialised session.** It runs against the session's
  repository directory, so a session whose sandbox has never been provisioned
  is rejected with `has no sandbox to plan against`. Open a chat in that session
  first.

The planner holds no tool that can change anything (no `Bash`, no `Write`),
because there is no chat for an approval prompt to appear in. The reviewer does
hold `Bash` — a review worth having runs the project's tests — and *is* gated,
because it runs against a real chat's worktree.

### Where tasks come from

`origin` on each card says which, and there are exactly five:

| Origin | Filed by |
| --- | --- |
| **User** | The board's own "new task", and a member's org-memory proposal (§13) |
| **Planner** | A decomposed goal — the root node and every child |
| **Schedule** | A cron tick, or "Run now" (§17) |
| **Channel** | A plugin holding `tasks:create` — a Slack mention, for instance (§12). Hardcoded at the call site, never read from the plugin's payload |
| **Reflection** | The daily reflection pass, proposing a skill (§13) |

A proposal task — from reflection, or from a non-admin's memory promotion —
has **no session at all**, and is filed already `blocked`. That is why
`tasks.sessionId` is nullable, and why unblocking one releases it into the
backlog for someone to act on rather than resuming a turn that never ran.

---

## 15. Agents (the roster)

**Settings → Agents** (admin only) is the organisation's subagent roster: the
named personas a turn can delegate to, each with its own prompt, model tier and
tool list. Every chat turn is handed the enabled ones; a task can be assigned to
one by name.

Four ship as builtins — `explorer`, `executor`, `reviewer`, `designer`. They
are editable but not deletable, so a roster can always be repaired by resetting
a definition rather than reconstructed from nothing.

### The roster seeds on first read, not at first run

**Nothing writes the four builtins when the organisation is created.** They are
seeded lazily, by whichever read gets there first — a chat turn resolving the
roster, the schedule editor's agent picker, or opening Settings → Agents. All
of them go through the same `listRosterRows`, which seeds when it finds zero
rows and then re-reads.

That matters for one reason: **a brand-new instance's `roster_agents` table is
empty until something reads it.** If you go looking in `psql` before anyone has
sent a message or opened the page, an empty table is expected and not a failed
install.

### What a turn skips silently, and the page does not

`getRoster` — the read a turn uses — filters out two kinds of row without
saying anything, on the principle that one bad row must never fail every turn
in the organisation. Settings → Agents deliberately shows both, because seeing
and fixing them is the whole job of that page:

- **An invalid row.** Definitions are re-validated on read, not only on write,
  so a row written before a schema tightening shows as invalid with a
  placeholder definition. A turn skips it and logs.
- **A disabled row.** Nothing warns you about the consequences elsewhere:
  disabling `reviewer` turns the task board's review gate into an
  auto-approval (§14), and disabling an agent a schedule already names leaves
  that schedule firing with a stale name (§17).

---

## 16. Design mode

**Design mode runs several designer turns side by side** — two or three
candidates, each in its own git worktree on its own `design/<chat id>/<n>`
branch — so you can look at real, running alternatives instead of one. It is
the **Design** button in a chat's composer, and it is per-message: it decides
how the *next* send runs, and nothing on the chat row records it — a chat never
sits "in" design mode.

**There is nothing to install, and no environment variable.** What there is, is
one piece of configuration without which half the feature is invisible, and a
port convention that is honoured by convention rather than enforced.

### A preview domain is required to see anything

Each candidate is served at its own hostname — `<chat slug>-d<n>.<preview base
domain>` — routed by the same generated nginx blocks and the same
`auth_basic` instance-password gate as an ordinary preview (§8). **With no preview base
domain set in Settings → Admin → Domain, `buildCandidatePreviews` returns an
empty list and the design panel has nothing to embed.** The candidates still
run, still commit, and are still there as branches — you just cannot look at
them, which is most of the point.

The DNS record is the same wildcard §8 already asks for; `*.previews.example.com`
covers `…-d1`, `…-d2` and `…-d3` without anything extra. TLS is *not* extra
either, in the sense that `paco tls` does not cover any preview hostname,
candidate or otherwise — a candidate without a certificate in
`/etc/paco/preview-certs/<hostname>/` is served over plain HTTP, deliberately
(§8).

### The port contract is a sentence in a prompt

Each candidate is told, in its system prompt, to bind a specific port —
**5173, 4321 and 8000 for candidates 1, 2 and 3** — and the nginx block for its
hostname proxies to exactly that port. Nothing in Paco starts those dev servers
and nothing verifies they were started.

The failure is quiet by nature. Docker publishes all four ports when the
container is created, so the nginx block for candidate `n` is written the
moment its worktree exists — whether or not anything is listening behind it.
A candidate whose agent ignored the instruction, bound its framework's default
port instead, or never got as far as starting a server, gets a **502 from
nginx** and shows in the design panel as unreachable. Nothing downstream can
tell that apart from "it has not started yet", so no error is surfaced
anywhere. A 502 where you expected a page is the signal; ask the candidate's
own chat what it started and on what port, since that turn is the only thing
that knows. Neither `ss` nor `lsof` is in the sandbox image, which is why
Paco's own probe walks `/proc` rather than shelling out to either.

Those are three of the four ports every sandbox already publishes to the host
(§9), and the chat's own dev server is legitimately allowed to use them too.
That is why the reclaim path is narrow: a listener is only ever killed when its
working directory is inside `<workspace>/designs/`, proved by reading
`/proc/<pid>/cwd` in the container. "Something is listening on 5173" is not
enough reason to touch it.

### The sweep that keeps it honest

A reconciliation pass runs in-process, every 60 seconds, 15 seconds after boot
(`lib/preview/reconcile-job.ts`). It re-derives every preview's nginx block and
reclaims the ports and worktrees design candidates leave behind — the case
where a process died mid-design-turn, or an operator removed a worktree by
hand, and the candidate's dev server kept its port for the life of the
container while its `paco-preview-<slug>-d<n>.conf` pointed at a dead upstream
forever.

It is an in-process timer rather than a pg-boss job on purpose: everything it
reconciles is state on *this* host — this machine's nginx, this machine's
containers, this machine's disk — so it has to run in every app process on
every host, which is the opposite of what a queue-distributed job guarantees.
It is also the authority: the edge triggers elsewhere only make the common case
fast.

### Cost

N parallel agent turns per send, each capped at 40 turns. That is the reason
Design is a deliberate press before one message rather than a mode a chat sits
in, and it is worth saying to anyone you hand the instance to.

---

## 17. Schedules

**Settings → Schedules** runs a task on a cron expression: a name, a target
session, a cron, a goal, and optionally a roster agent to assign it to. Each
tick creates a task with `origin: "schedule"` in that session and starts it
through exactly the same path the board's own start uses (§14).

Every member can see the list; **only an admin can create, edit, delete, toggle
or run one**. The session picker only ever offers the caller's own sessions,
and that ownership is re-checked on every edit, not just on create.

### What to expect from the clock

- **Cron entries are registered with pg-boss**, one per schedule row, keyed by
  the schedule's id — created and re-synced on every create, edit and toggle.
  pg-boss polls on its own loop; a tick can be up to about half a minute late.
- **Everything is UTC.** `tz: "UTC"` is passed for every schedule, and there is
  no per-organisation timezone setting anywhere to read instead. A `0 4 * * *`
  schedule fires at 04:00 UTC regardless of where the instance or its operator
  is.
- **There is no catch-up for missed windows.** If the process was down at 02:00,
  or the schedule sat disabled through several would-be ticks, nothing later
  fires once per missed window. The next real tick is the only thing that fires
  it, and `lastFiredAt` only ever shows the most recent actual fire — never a
  backfilled history.
- **A cron expression is validated when you save it**, by the same parser
  pg-boss validates against, so a bad one is a field error rather than a
  schedule that quietly never fires.
- **An assigned agent is checked against the enabled roster on save**, and only
  on save. Disable a roster agent (§15) that an existing schedule already names
  and that schedule keeps firing with the stale name — every fire then tells
  the executor to delegate to a subagent that no longer exists. The next *edit*
  of that schedule is what refuses it. Re-check your schedules after disabling
  an agent.

### "Run now" on a disabled schedule fails, by design

`fireSchedule` re-checks `enabled` itself, not only at registration time, and
"Run now" goes through that same function — so clicking it on a disabled
schedule returns `Schedule "<id>" is disabled` and creates nothing.

That is not an oversight to work around. The check is defence in depth against
a job already enqueued for a tick at the moment the schedule was disabled, and
"disabled" has to mean the same thing on both paths or it means nothing.
**Enable the schedule first, then run it.**

### Two failures that leave a trace and not much else

- **The task starts and then fails.** `lastFiredAt` is stamped as soon as the
  task exists — firing means "produced a task and attempted to start it" — so a
  schedule whose target session is broken looks like it fired, and the failure
  is recorded on the task (`failed`, on the board) rather than on the schedule.
  A `[jobs] schedule "<id>" fire did not start a task:` line appears in the log.
- **The session was deleted.** `schedules.sessionId` cascades, so the schedule
  row disappears with no application code in the loop to unregister its cron
  entry. The first tick afterwards notices, removes its own orphaned
  registration and logs it once. Expected housekeeping, not a fault.

---

## 18. The Poolside backend

A chat can run on **Poolside** instead of Claude Code — a second agent
backend, driven over ACP (`pool acp`, one process per turn) rather than the
Claude Code CLI. It is chosen per chat, from the composer's backend control,
and it exists so an instance is not tied to one provider.

### You install the binary; nothing here does

**Paco does not ship, download, or build `pool`.** You install it with
Poolside's own installer. Paco spawns whatever `pool` is on `PATH`, or the
absolute path you put in **Settings → Models → Poolside**. On a native install
that means the binary has to be reachable by the `paco` service user, and
`PATH` under systemd is not your login shell's — give it an absolute path
rather than relying on `PATH` picking it up.

The environment that process gets is **built from scratch**, not inherited
from the service: `PATH`, `HOME`, `XDG_CONFIG_HOME`, and the credentials
below. Two consequences worth knowing before you debug one of them:

- Putting `POOLSIDE_API_KEY` in the instance's `.env` does nothing. The key
  comes from Settings, and only from there.
- `pool login` still works, because `HOME`/`XDG_CONFIG_HOME` are passed
  through and `pool` reads `~/.config/poolside/credentials.json` under them —
  but it is the **service user's** home that counts, not yours. `sudo paco
  auth poolside` is how you sign that user in without a `su` incantation; see
  *Two ways to authenticate* below.

Configure it in **Settings → Models → Poolside** (admin only):

| Field | What it does |
| --- | --- |
| **Binary path** | Absolute path to `pool`. Unset, Paco spawns the bare name `pool` and relies on the service's `PATH`. |
| **API key** | Optional — see *Two ways to authenticate* below. Passed to the process as `POOLSIDE_API_KEY`. Sealed with `APP_SECRET` the same way GitHub tokens and the SMTP password are, and never sent back to the browser. Unset, `pool` falls back to the credentials `pool login` wrote in the service user's home; **set, it wins over them.** |
| **Base URL** | Passed to the process as `POOLSIDE_STANDALONE_BASE_URL`, and genuinely honoured — point it at your own Poolside deployment. Unset, `pool` uses its own default (`inference.poolside.ai`). |

Settings are read fresh on every turn rather than cached, so an edit takes
effect on the very next turn with no restart.

### Two ways to authenticate

The form above lists an API key, and it is easy to read that as a requirement.
It is not one. `pool` takes a credential from either of two places, and the
one most operators want is the terminal:

```bash
sudo paco auth poolside
```

That runs `pool login` as the `paco` user — Poolside's own sign-in, driven by
Poolside, not by Paco — so the credential lands in that user's own config
directory (`/var/lib/paco/.config/poolside/`, which `pool config` will print
for you) rather than in Paco's database. Nothing goes in Settings at all.

It is the same shape as `paco auth` for Claude, with one difference that
changes the error you get when it goes wrong: **Paco ships `claude` and does
not ship `pool`.** A missing `claude` means a broken package; a missing `pool`
means you have not installed it yet, and the command says so rather than
telling you to reinstall Paco.

Two details worth knowing before you run it:

- **It signs in the binary your turns run.** If **Binary path** is set in
  Settings, that is the binary `paco auth poolside` invokes — not some other
  `pool` earlier on root's `PATH`. Signing in the wrong one is the failure
  mode this avoids: a login that succeeds while every turn keeps failing.
- **Extra arguments go through to `pool login`.** `paco auth poolside
  --api-url https://tenant.example` configures enterprise tenant mode;
  `--api-key …` configures standalone mode without the browser step, if you
  would rather not store a key in Paco's database.

**No restart afterwards.** Every turn spawns a fresh `pool` process which
reads the credential off disk as it starts, so the next turn picks it up.
That is the same reason a Settings edit needs no restart, arrived at from the
other direction.

`sudo paco status` reports what it found:

```text
Poolside:  credential file present (/var/lib/paco/.config/poolside/credentials.json)
```

Read that line for exactly what it says. `pool` has no `auth status`
subcommand to ask, so this is the presence of the credential *file* and not a
statement that the service still accepts it — a revoked credential looks
identical here. The first turn is what proves it. The line also names the
other two states plainly: `no login, using the API key in Settings` when a key
is stored and no file exists, and `not installed` when `pool` is not runnable
by the service user at all.

#### If you use the API key instead

Two behaviours of `pool` 1.0.16, both checked against the binary rather than
inferred, decide how the two ways interact:

- **The key wins.** `POOLSIDE_API_KEY` overrides the credentials file. Set
  both and the key is the one in use — which is why `paco auth poolside`
  prints a warning when it finds a key stored, and why `paco status` says
  "but an API key in Settings takes precedence over it".
- **The key alone is not enough.** `pool` resolves an API *URL* separately —
  from the `settings.yaml` that `pool login` writes, or from
  `POOLSIDE_STANDALONE_BASE_URL`. On a host that has never run `pool login`,
  a key with no **Base URL** fails every session with `Authentication
  required` / `API URL not configured`, which reads like a rejected key and
  is not one. **Set Base URL to `https://inference.poolside.ai`** (or your own
  deployment) alongside the key, or sign in from the terminal and skip the key
  entirely.

### Prove it before a chat depends on it

**Test connection** on that same page spawns the binary, exchanges the
`initialize` handshake, and tears the process down — the same first frame a
real turn exchanges, with a 15-second timeout, without creating a session or
running a prompt. A missing binary, a wrong path, or a process that never
answers is reported here with the host's own error text. It runs against a
temporary directory, so nothing in a chat's worktree affects the result.

It uses the *same* settings-to-process mapping a real turn uses, so a green
result is a statement about the configuration a turn would actually run with,
not a hand-written approximation of it.

A green result also reports **the endpoint the binary resolved** — read out of
the handshake's own `poolside/service_mode`, `provider: inference.poolside.ai`
by default. Check it against what you typed: a wrong **Base URL** is the
likeliest mistake on this form, and a handshake succeeds against the wrong
endpoint exactly as happily as the right one. (Some builds do not report it;
then the result simply makes the weaker claim.)

Be clear about what a green result proves: **the binary starts, speaks the
protocol, and resolved that endpoint.** It creates no session and runs no
prompt, so it does not exercise the API key against a provider — `initialize`
does not authenticate. A working handshake and a failing first turn is a
credential problem, not a path problem.

### What a Poolside chat keeps

Worth stating first, because a second backend is usually assumed to be a
stripped-down one. These are not degraded on Poolside:

- **Memory, skills, and project instructions.** They ride in ahead of the
  prompt on every turn, so the agent has the same briefing a Claude Code chat
  gets (§13).
- **Plugin MCP servers and any project MCP configuration.** They are really
  spawned and handshaken by `pool`, not merely accepted and dropped.
- **Session resume.** A later turn reattaches to Poolside's own session rather
  than replaying the conversation.
- **The model picker**, narrowed to the model ids Poolside publishes for
  itself. They are Poolside's own — not Claude tier names — so the picker
  offers what the backend will actually accept.
- **Approvals.** Every tool call arrives as a permission request and is
  answered by Paco's own approval policy, the same gate a Claude Code chat
  passes through.

### What a chat gives up by running on Poolside

These are not opinions about the backend; they are the capabilities it reports
as unsupported, each with a visible consequence:

| Not supported | Consequence |
| --- | --- |
| **Reasoning effort** | Poolside has a thinking level of its own, but with two settings against Paco's five — there is no honest mapping, so the instruction is simply not passed on. The effort control is hidden and the chat runs at Poolside's own default. It is not thinking less hard; it is not taking the instruction. |
| **Custom subagents** | Paco's roster (§15) and its per-agent model tiers have no way in — Poolside's protocol can select an agent it already defines, but not define one. Poolside delegates to its own internal subagents instead. |
| **Structured output** | Turns that need a schema-shaped answer cannot run. Concretely: the task board's reviewer gate blocks the task rather than guessing a verdict (§14), and task planning does not use a chat backend at all. |

The composer hides the controls that do not apply, and Settings → Models lists
these same lines — derived from what the backend reports, not written out by
hand — so choosing Poolside is a visible trade rather than a silent downgrade.

One cost that is *not* on that list, because it is not a capability: **memory
distillation and daily reflection always run on Claude Code** regardless of a
chat's backend (§13). An instance that moved to Poolside to avoid Claude
entirely will still see Claude usage from those two paths.

---

## 19. Two kinds of administrator

Worth knowing before it reaches you as a bug report, because the two are not
interchangeable in the database even though they are everywhere in the product.

"Administrator" has two independent sources, and the shared check
(`lib/admin/require-admin.ts`) is an **OR** of them, never a replacement of one
by the other:

- **`users.is_admin`** — set for the account that claims the instance during
  first run (§7), and for anyone migration `0005` promoted on an upgraded
  install. That migration makes only the *oldest* such account an organisation
  `owner`; **the rest keep `is_admin` with no organisation membership row at
  all.**
- **The organisation `admin`/`owner` role**, granted through an invitation.
  `owner` and `admin` differ only in that an owner cannot be removed.

Dropping either half strands someone who has access today, which is why both
are checked. Every org-scoped surface — the task board, Schedules, Memory
promotion, Evals — accepts a membership row **or** the flag, so a flag-only
admin is not locked out of any of them.

Two practical consequences:

- **Promotion is still a database write.** Nothing in the UI grants admin to a
  second person; §7 covers this. `UPDATE users SET is_admin = true` gives the
  flag; an invitation gives the role. Prefer the invitation — it produces the
  membership row too, so the account looks the same as every other admin.
- **A flag-only admin has no organisation membership row**, which is not
  visible anywhere in the interface. If you are debugging a permissions
  question in `psql`, check `organization_members` before concluding an account
  is not an admin.

---

## 20. Environment variables

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
| `PACO_HOME` | Paco's own data directory — the root under which memory (§13) and installed plugins (§12) live. Unset, it falls back to the service user's home plus `/.paco`, which on this package is `/var/lib/paco/.paco`. `postinst` does **not** write it into `paco.env`, so the fallback is what applies unless you add it. Moving it moves both subsystems; nothing migrates the old directory for you. | `paco.env` |
| `PACO_PLUGINS_DIR` | Where plugins are installed, overriding `<data dir>/plugins` for plugins only. A relative value is resolved against the server process's working directory (`/usr/lib/paco`), so give it an absolute path. Unset, plugins go to `/var/lib/paco/.paco/plugins`. | `paco.env` |
| `PACO_PLUGIN_NODE_EXECUTABLE` | The Node binary plugin workers are spawned with. Unset, Paco spawns plugin workers with the runtime it is itself running on — correct on this package, whose bundled Node is 24.19.0. Point it at a Node >= 24 binary on any host whose runtime is older: below the floor **every** plugin fails to start, with `not-running` on the Plugins page and one log line as the only diagnosis (§12). | `paco.env` |
| `PACO_SANDBOX_IMAGE` | A full image reference for the sandbox, overriding the `ghcr.io/stack256org/paco-sandbox:v<version>` tag Paco derives from the installed package. For a mirror or a locally built image; see §22. | `paco.env` |

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
| `PACO_INTERNAL_URL`, `PACO_INTERNAL_TOKEN`, `PACO_PLUGIN_TOOLS` | Injected per turn into the plugin tool bridge (§12) — a loopback callback URL, a token scoped to exactly the plugins that bridge fronts, and the tool list itself. The bridge deletes every other environment key before its first network call, so a value set here is scrubbed rather than honoured. |
| `PACO_PLUGIN_ID`, `PACO_PLUGIN_STATE_DIR` | The only two variables a plugin worker's environment carries, besides `PATH`. That environment is constructed from scratch rather than filtered from the host's, which is why `APP_SECRET` and `POSTGRES_URL` are absent from it — see `packages/plugin-host/SECURITY.md`. |
| `PACO_VERSION` | The installed package's version, shipped in `/usr/lib/paco/version.env` and read to pin the sandbox image tag. Set it in `paco.env` and you pin the image to a version that is not the one you are running. |

One more you may find referenced and should not put in `paco.env`:
**`PACO_NODE_EXECUTABLE`** is read only by `@paco/plugin-host`'s own test
suite, which uses it to add a Node binary to the set of runtime tiers it
verifies containment on. Nothing in the running application reads it. The
variable an operator wants is `PACO_PLUGIN_NODE_EXECUTABLE`, above.

---

## 21. Instance health

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

## 22. Troubleshooting

### "Paco couldn't download the workspace image"

Paco pulls `ghcr.io/stack256org/paco-sandbox` on the first chat, so this means
the pull failed rather than that a build step was skipped.

The tag it asks for is **`v<your installed version>`**, not `latest` — the image
has to match the package, because the container runs as your host's uid and only
an image built for that works. `paco status` prints the version, or:

```bash
. /usr/lib/paco/version.env && echo "$PACO_VERSION"
docker pull "ghcr.io/stack256org/paco-sandbox:v$PACO_VERSION"
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

For a chat whose backend is Poolside, it is a different credential entirely —
`paco auth` does not touch it. Use `sudo paco status` and §18.

### Chats fail trying to reach the Docker socket

`postinst` puts the `paco` user in the `docker` group, so this should not
happen. It does if Docker was installed *after* Paco — the group did not exist
when the package was configured, and the install said so at the time.

Check first, then repair:

```bash
id -nG paco                      # should list: paco docker
sudo usermod -aG docker paco
sudo systemctl restart paco      # membership is read at process start
```

The restart is not optional: a running process keeps the groups it started
with, so adding the user without it changes nothing until the service bounces.

Group membership for `/var/run/docker.sock` is equivalent to root on this
host: a process that can reach it can create its own privileged container.
That is inherent to running containers on behalf of an agent, but grant it only
where you are comfortable with it.

If the chat instead says Paco does not support rootless Docker, believe it:
that message comes from asking the daemon about itself, not from guessing.
`docker info` on the host will show `name=rootless` under **Security
Options**, and §1 has the fix and the reason there is no other one.

### `docker info` works in my shell, but Paco says Docker isn't running

Almost always a host with **only** a rootless daemon. Paco's Docker client
looks for `$HOME/.docker/run/docker.sock` and `/var/run/docker.sock` and
nothing else; a rootless daemon listens on `$XDG_RUNTIME_DIR/docker.sock`,
which is never probed. Your shell finds it because the rootless installer put
`DOCKER_HOST` in your profile; the service has no such thing.

Do not point `DOCKER_HOST` at the rootless socket to close the gap — Paco will
then reach the daemon and refuse it, for the reason in §1. Install the
system-wide daemon instead:

```bash
docker info --format '{{.SecurityOptions}}'   # `name=rootless` present?
sudo apt-get install -y docker.io
sudo systemctl enable --now docker.service
sudo usermod -aG docker paco
sudo systemctl restart paco
```

### `paco status` / `paco logs` / `paco tls` isn't a recognised command

See §3 — as this branch currently packages, none of `scripts/paco`'s
commands are installed onto the target system. Use the systemd/apt
equivalent from that table directly until it's fixed.

### GitHub actions fail, but Settings says connected

Two candidates. `gh` isn't installed — Paco says so plainly: *"Paco needs
GitHub's own command-line tool to do this, and it isn't installed on this
machine."* It is a `Recommends` as of 0.2.2, so `apt install paco` brings it
and reaching this state means `--no-install-recommends`, or `gh` removed
afterwards. Install it with `sudo apt-get install -y gh` — Ubuntu carries it
in `universe`. It was a `Suggests` before 0.2.2, on the incorrect premise that
it was only available from GitHub's own repository, so a server installed
before then has no `gh` and this is exactly what it looks like. If `apt`
reports no such package, `universe` is disabled on that host and GitHub's
repository is the alternative:
<https://github.com/cli/cli/blob/trunk/docs/install_linux.md>.

Or the stored token no longer decrypts because `APP_SECRET` changed — see
§6. The server log shows `Stored token for user … could not be decrypted`.
Either restore the original `APP_SECRET`, or have each user reconnect in
Settings → Connections.

### The sign-in link never arrives

With no mail server configured (§20), Paco doesn't send email — it logs the
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

### Every plugin shows `not-running`

Not one plugin at a time — all of them, immediately after enabling. That
shape is the Node floor, and the page will not say so:

```bash
sudo paco logs | grep "plugin registry"
```

`host runtime is below the required Node floor` is the line. Set
`PACO_PLUGIN_NODE_EXECUTABLE` to a Node >= 24 binary and restart (§12, §20).
A single plugin reading `not-running` while the others run is a different
problem — a symlink in its tree, or its files changing on disk since install
— and the same log grep names it.

### A plugin is enabled but nothing it contributes appears

- **A tool never shows up in a chat**: the plugin needs `tools:register`, and
  the grant is what the consent screen recorded, not what `plugin.json` asked
  for. Re-check it on the Plugins page.
- **A webhook is never delivered**: the plugin needs `channels:ingress`, must
  be running, and — on a `shared-secret` channel — the caller must send the
  ingress secret in `x-paco-channel-secret`. See
  [docs/plugins.md](plugins.md).
- **The Slack plugin does nothing at all**: `slack_setup` has not been run.
  It is a tool call from inside a chat, not a settings form (§12).

### A scheduled task never ran

- **"Run now" says the schedule is disabled** — that is the check, not a bug
  (§17). Enable it first.
- **A tick was missed while the host was down** — nothing catches up. The next
  real tick is the only thing that fires (§17).
- **The time looks wrong by hours** — every schedule is UTC, with no
  per-organisation timezone setting anywhere (§17).
- **`lastFiredAt` moved but nothing happened** — the schedule fired and the
  task failed to start. Look on the task board for a `failed` task in that
  session, and for `[jobs] schedule … did not start a task` in the log.

### A task is stuck in `blocked` and nobody knows why

Read the task's own summary on the card — it says which of the four cases it
is (§14). `Not reviewed: backend "poolside" cannot produce structured output`
is the one that surprises people: the chat was moved to Poolside, and the
reviewer cannot return a verdict there (§18).

### A design candidate's preview is blank or unreachable

- **No preview base domain is set** — then there are no candidate URLs at all,
  and the panel has nothing to embed (§16). Settings → Admin → Domain.
- **The candidate's dev server was never started, or bound the wrong port.**
  Each candidate is *told* to bind 5173, 4321 or 8000 by index; nothing
  enforces it. Nothing logs it either — an unreachable candidate looks
  identical to one whose agent ignored the instruction.
- **A previous candidate is still holding the port.** The 60-second
  reconciliation sweep reclaims those (§16); give it a minute before
  concluding anything.

### Poolside chats fail on the first turn, but Test connection passed

Test connection proves the binary starts and completes the `initialize`
handshake. It creates no session and runs no prompt, so it never exercises
the API key against a provider (§18). A green test and a failing first turn
points at the credential, not the path — either the API key in Settings, or
the `pool login` credentials it falls back to, which live in the *service
user's* home and not yours.

```bash
sudo paco status          # the Poolside: line says which of the two it found
sudo paco auth poolside   # sign the service user in, if it found neither
```

Two failures here are worth telling apart, because both name a credential and
only one is about one. `Authentication required` with no API key stored means
exactly what it says: sign in. The same message *with* a key stored usually
means the key has no API URL to go with it — set **Base URL** as well, or sign
in from the terminal and clear the key (§18, *If you use the API key
instead*).

If instead the turns succeed but reach the wrong deployment, compare the
endpoint Test connection reports with the **Base URL** you typed (§18).

### An admin is refused somewhere, but not everywhere

Check whether that account has an organisation membership row at all — a
flag-only admin (`users.is_admin`, no row in `organization_members`) is a real
and supported state, and §19 explains where it comes from. Every org-scoped
surface accepts either source today, so a refusal on one page and not another
is worth reporting rather than working around.
