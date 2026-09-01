# Paco

Self-hosted coding agents. Describe a task, and an agent works in an isolated
sandbox until it's done — editing files, running the app, committing, and
opening a pull request.

Paco is open source and runs entirely on your own machine or server. There is no
vendor account to sign up for and no API key to buy.

## How it works

```text
Browser  ->  Next.js + durable workflow  ->  Claude Code (host)  ->  Docker sandbox
```

- **The agent is the Claude Code CLI.** Paco drives it headlessly and reads its
  streaming JSON protocol, so you get the same agent loop, tools, and context
  management as the terminal app. Authentication uses your existing Claude
  subscription — no API key.
- **The sandbox is a Docker container.** Each session gets a workspace directory
  on the host, mounted into a container. The agent edits files on the host; the
  container runs them, with dev-server ports published for previews. Because the
  workspace is a real directory, state survives container restarts without
  snapshots.
- **A session is a git repository; a chat is a worktree of it.** Every chat works
  on its own `chat/<id>` branch in its own directory, so two chats in one session
  can change the same file without colliding, and each gets its own diff and its
  own pull request.
- **Destructive actions ask first.** The agent runs with the CLI's prompts
  bypassed — every other mode blocks Bash and breaks the product — so Paco gates
  tool calls itself. Reads, in-worktree edits, and ordinary development commands
  run untouched; `rm -rf`, force pushes, `sudo`, and writes outside the worktree
  stop and wait for you.
- **Runs are durable.** The [Workflow SDK](https://workflow-sdk.dev) persists
  each step to Postgres, so a run survives restarts and can be resumed or
  cancelled.
- **Work is tiered across models.** An Opus-class model orchestrates while
  Sonnet and Haiku subagents do the mechanical work, which is where most of the
  token volume goes. The roster of subagents — who they are, what model tier
  and tools each gets — is editable per organisation in **Settings → Agents**.

## Beyond one chat

The same instance runs five things that outlive a single conversation. Each
one is documented for operators in
[docs/self-hosting.md](docs/self-hosting.md).

- **A task board.** `/tasks` is an organisation-wide backlog. A task runs
  unattended in its own chat and moves `todo → running → review → done`,
  gated by a `reviewer` subagent that can send work back — twice, then it
  blocks for a human. Hand it a large goal instead and a planner decomposes it
  into a tree first.
- **Schedules.** A cron expression, a session, and a goal: **Settings →
  Schedules** files and starts a task on every tick. UTC, no catch-up for
  missed windows.
- **Memory.** Notes distilled out of chat turns and fed back into later ones,
  in two scopes — the instance's and the project's. Plain markdown you can
  read and edit in **Settings → Memory**. A daily reflection
  pass looks for friction that repeats and *proposes* encoding it as a skill;
  it never writes one itself.
- **Design mode.** A per-message toggle in the composer that runs two or three
  designer turns side by side, each in its own worktree and branch, each with
  its own live preview URL — so you compare running alternatives instead of
  one. Needs a preview domain configured; without one the candidates run but
  there is nothing to look at.
- **Plugins.** Third-party code, running in a separate hardened OS process,
  that can contribute model-facing tools, receive session events, post
  messages, create tasks, or accept an inbound webhook. Nothing is granted
  until an operator reviews what the manifest asks for, capability by
  capability.
  See
  [docs/plugins.md](docs/plugins.md), which walks the first-party Slack
  plugin — `@`-mention the bot and it files a task — end to end.
  **Plugin workers require Node >= 24**; the packaged install bundles it, a
  development checkout on an older Node does not.

## Installing

One command, on a fresh Linux host running systemd:

```bash
curl -fsSL https://apt.stack256.org/paco/install.sh | sudo sh
```

The instance comes up protected by a password, asked for by the browser with
the username `paco`. The installer either asks you to choose one or generates
it and prints it when it finishes. Change it later with `sudo paco password`;
see [The instance password](docs/self-hosting.md#the-instance-password).

That is the whole install. It brings its own dependencies — you do not install
Docker, or a database, or a web server, and there is nothing to wire together
afterwards:

- **Docker**, installed and started, and the service account put in the
  `docker` group. Chats run in containers, so this is not optional; the
  installer does it rather than telling you to. It has to be the ordinary
  **rootful** daemon: a sandbox runs as the host's own uid and shares the
  workspace directory with it, and a rootless daemon remaps every uid through
  a user namespace, so the files it writes come back owned by an id the
  service cannot read. Paco detects that and refuses rather than failing
  halfway; if this host already runs Docker rootless, read
  [docs/self-hosting.md](docs/self-hosting.md) §1 before installing — the
  installer sees a working `docker` and will not replace it.
- **PostgreSQL and nginx** as ordinary host packages. Postgres is reached over
  a Unix socket, with no TCP listener at all.
- **Its own bundled Node and Claude Code CLI**, pinned — no system Node, no npm.
- **The database created, a secret generated, and the service started**, all
  before the command returns.
- **`apt upgrade` as the update mechanism** thereafter — the same trust model
  and the same command as every other package on the host.

When it finishes there is exactly **one** thing left, and only because it needs
your Claude account:

```bash
sudo paco auth
```

Then open the URL it printed and create your account.

**What it needs:** a Linux host running systemd, root access, ports 80 and
443 free — nginx owns both, and there's no flag to move them — and, if Docker
is already installed here, a rootful daemon rather than a rootless one.

### About the domain

**You do not need one to get in.** Paco answers on whatever address the request
arrived at, so the IP the installer prints works immediately — nothing to point,
nothing to configure first.

**You do need one for the links Paco sends and for previews.** Without a
domain, pull-request descriptions Paco opens link back to a localhost
address that only this server can open, and preview hostnames (see
[docs/self-hosting.md](docs/self-hosting.md)) have nothing to attach to.

So: point an **A record at the IP the installer printed**, then set the
domain.

```text
paco.example.com.   A   203.0.113.10
```

`--domain` at install time does this up front, and
**Settings → Admin → Domain** changes it later. Reaching the app never
depended on any of this — only the links it sends, and previews, do.

For HTTPS, run `sudo paco tls <domain>` once the record resolves — unless
something in front of you already terminates TLS, in which case skip it.

<details>
<summary>What the installer actually does, if you'd rather not pipe a script into a shell</summary>

It adds one signed APT source

```text
deb [signed-by=/etc/apt/keyrings/stack256-archive-keyring.gpg] https://apt.stack256.org stable main
```

— one source and one key for every Stack256 package, not just this one —
installs `docker.io` if no container runtime is present, then installs `paco`,
which pulls in PostgreSQL and nginx and runs the setup above from its
`postinst`. Run it with `--dry-run` to have it print each of those steps
without doing any of them, or read it first: it is served from
[apt.stack256.org/paco/install.sh](https://apt.stack256.org/paco/install.sh) and
lives at [`install.sh`](install.sh) in this repository. It is served under
`/paco/` rather than at the site root because that repository serves every
Stack256 product, and there is only one root for them to fight over — the old
root path still works, for anyone who copied it from an earlier release.

`apt install paco` on a host that already has the source works identically —
the package does its own setup, so neither route leaves you with steps to
finish by hand.

Building the package yourself instead is in
[docs/self-hosting.md](docs/self-hosting.md).

</details>

## After you install

Open `http://<this host's address>/` (or `http://<domain>/`, if you passed
`--domain` or answered the installer's prompt). Type the instance password
and you are in the app — there is no account to create and no onboarding
flow, because there are no accounts.

A few things still need doing:

- **`sudo paco auth`** signs the service into Claude Code. The one step the
  installer cannot do for you, because it needs your account — and every turn
  fails with nothing to run until it is done.
- **The first chat is slower than the rest.** It pulls
  `ghcr.io/stack256org/paco-sandbox`, the image your app is built inside, which
  is a few gigabytes and happens once. Nothing to do — but
  `docker pull ghcr.io/stack256org/paco-sandbox:v$(paco status | awk '/^Version/{print $2}')`
  moves that wait somewhere you chose, and `PACO_SANDBOX_IMAGE` points it at
  your own mirror. The tag matches your installed version rather than being
  `latest`, because the container runs as your own uid and the image has to be
  built for that.
- **TLS** is `sudo paco tls <domain>`, once DNS for that domain resolves here
  — a per-hostname Let's Encrypt certificate over HTTP-01. No wildcard, no DNS
  credential, and it does not cover preview hostnames (see below and
  [docs/self-hosting.md](docs/self-hosting.md)).
- **GitHub** is connected instance-wide, from **Settings → Connections** by
  pasting a personal access token with `repo` access
  ([create one](https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=Paco)).
  Paco drives it through the [`gh` CLI](https://cli.github.com) (`Suggests`,
  not bundled — install it yourself); there is no GitHub App and no webhook,
  which matters for a self-hosted install since GitHub cannot deliver a
  webhook to a private address anyway. The token is stored encrypted, keyed
  from `APP_SECRET` — the instance's only token, used for every chat.

[docs/self-hosting.md](docs/self-hosting.md) covers the rest of what an
operator needs: the file layout, upgrading, what `apt remove` keeps versus
what `apt purge` destroys, the DNS records for the app and for previews, the
full `paco` command reference, backup and restore, every environment variable,
one section each for plugins, memory, tasks, the agent roster, design mode,
schedules, and troubleshooting.
[docs/README.md](docs/README.md) indexes the rest of the documentation.

## Contributing

Development stays Docker-based — a disposable Postgres container, the same
sandbox image chats use — and is unchanged by any of the above. See
[docs/contributing.md](docs/contributing.md) for the setup, the repository
layout, running tests, and code style.

## License

See [LICENSE.md](LICENSE.md).
