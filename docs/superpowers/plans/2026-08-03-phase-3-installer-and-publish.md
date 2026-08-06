# Phase 3: Installer, Published Image and Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command on a bare Ubuntu VPS produces a working Paco. One published image serves every installation. Upgrades are one command. There is no uninstall.

**Architecture:** A release workflow builds a multi-architecture image and pushes it to `ghcr.io/stack256org/paco` on a version tag. `install.sh` is non-interactive: it installs Docker if absent, writes `/opt/paco/docker-compose.yml` and a generated `.env`, starts the stack, and prints one URL. Traefik owns `:80` from the moment of install so there is one port and one URL that keeps working when a domain is added later — Paco itself is never published to the host. A small `paco` command wraps upgrade, logs, restart and status. Domain, TLS and SMTP are configured in the product afterwards, which Phase 1 already made possible.

**Tech Stack:** Docker + Compose v2, Traefik v3, GitHub Actions, POSIX `sh`, Ubuntu 24.04 (the Krova test target).

## Global Constraints

- **`install.sh` and `paco` are POSIX `sh`** — no bashisms, no arrays, no `[[ ]]`. They run on a bare host before anything is guaranteed present.
- **Non-interactive by default.** No prompts. Flags and environment only.
- **Idempotent.** Running the installer twice must not destroy an existing installation or overwrite a generated secret.
- **Never print or log a generated secret.** `APP_SECRET` and the Postgres password go into `/opt/paco/.env` with restrictive permissions and are never echoed.
- **No uninstall.** Out of scope by design — a broken install is replaced.
- Shell is checked with `sh -n` and, where available, `shellcheck -s sh`.
- **`pnpm run ci` runs ONCE**, at the end of the phase.

---

## File Structure

| File | Responsibility |
|---|---|
| `.github/workflows/release.yml` (create) | Build and push the multi-arch image to GHCR on a tag |
| `install.sh` (create) | One-command install on a bare host |
| `scripts/paco` (create) | The `paco` command: upgrade, logs, restart, status |
| `deploy/docker-compose.yml` (create) | What the installer writes to `/opt/paco` — includes Traefik |
| `deploy/traefik/traefik.yml` (create) | Traefik static config: entrypoints, providers, ACME resolver |
| `docker-compose.yml` (modify) | The repo's own dev/compose file gains Traefik to match |
| `README.md` (modify) | Deploying section becomes the one-command install |
| `docs/self-hosting.md` (modify) | Install, upgrade, and what the installer does |

---

### Task 1: Publish the image to GHCR

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: `ghcr.io/stack256org/paco:<tag>` and `:latest`, `linux/amd64` + `linux/arm64`.

- [ ] **Step 1: Create the workflow**

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      tag:
        description: "Image tag to publish (e.g. v0.1.0)"
        required: true

# The image is public and the workflow needs to write it; nothing else.
permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # arm64 matters: a large share of cheap VPS capacity is Ampere, and an
      # amd64-only image fails there with an exec-format error that reads like
      # a corrupt install rather than a wrong architecture.
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/stack256org/paco
          tags: |
            type=ref,event=tag
            type=raw,value=${{ inputs.tag }},enable=${{ github.event_name == 'workflow_dispatch' }}
            type=raw,value=latest

      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Validate the workflow syntax**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('valid yaml')"`
Expected: `valid yaml`.

Then, if the `gh` CLI is authenticated: `gh workflow list` to confirm the file parses server-side once pushed. **Do not push a tag** — publishing is the operator's decision, and the account running this may not have write access to the organisation.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish a multi-architecture image to GHCR on a tag"
```

---

### Task 2: The deployment compose file and Traefik

**Files:**
- Create: `deploy/docker-compose.yml`, `deploy/traefik/traefik.yml`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `ghcr.io/stack256org/paco:latest`; the `APP_URL`, `POSTGRES_URL`, `APP_SECRET` environment contract from Phase 1.
- Produces: a compose stack of `traefik`, `paco`, `postgres` on a shared network, with **only Traefik publishing ports**.

- [ ] **Step 1: Write `deploy/traefik/traefik.yml`**

Static configuration. Entrypoints `web` on `:80` and `websecure` on `:443`. The Docker provider watching the socket, with `exposedByDefault: false` so nothing is routed unless it opts in with labels. An ACME resolver defined with the HTTP challenge on the `web` entrypoint — **defined unconditionally but referenced by no router until the operator enables TLS**, which is what makes TLS a label change rather than a Traefik restart.

The ACME email comes from an environment variable the installer sets; leave it empty and Let's Encrypt still issues, it just cannot warn about expiry.

- [ ] **Step 2: Write `deploy/docker-compose.yml`**

Three services:

- **`traefik`** — `traefik:v3`, publishes `${PACO_HTTP_PORT:-80}:80` and `443:443`, mounts the Docker socket read-only and `deploy/traefik/traefik.yml` plus an `acme.json` volume for certificates.
- **`paco`** — `ghcr.io/stack256org/paco:latest`, **no `ports:` at all**. It is reached only through Traefik. Labels give it a catch-all router on the `web` entrypoint at the lowest priority, so a bare IP reaches it before any domain exists, and the domain router added later wins. Mounts the Docker socket and the workspace path at the identical path on both sides, exactly as the repo's own compose file explains.
- **`postgres`** — `postgres:17-alpine`, no published ports, healthchecked, with a named volume.

Every secret comes from the `.env` the installer writes. Nothing has a default that would be a working credential.

- [ ] **Step 3: Bring the repo's own `docker-compose.yml` into line**

It currently publishes `3000:3000` for `paco` and has no Traefik. Add Traefik and remove the direct port publication so the development stack and the deployed stack fail the same way. Keep the `build: .` escape hatch that Phase 1 restored, and keep the comment explaining that the published image arrives with this phase — then update that comment, because it now has.

- [ ] **Step 4: Validate**

Run: `docker compose -f deploy/docker-compose.yml config >/dev/null && echo "deploy compose valid"`
Run: `docker compose config >/dev/null && echo "repo compose valid"`
Expected: both print. Unset-variable warnings are expected and are not failures.

- [ ] **Step 5: Commit**

```bash
git add deploy docker-compose.yml
git commit -m "feat: deployment stack with Traefik owning the only published port"
```

---

### Task 3: `install.sh`

**Files:**
- Create: `install.sh`

**Interfaces:**
- Produces: `/opt/paco/{docker-compose.yml,.env,traefik/traefik.yml}`, a running stack, and `/usr/local/bin/paco`.

- [ ] **Step 1: Write the installer**

POSIX `sh`. In order:

1. **Refuse early and clearly.** Not root → explain and exit. No systemd → explain that Paco expects a systemd host and exit. Already installed (`/opt/paco/.env` exists) → say so and point at `paco upgrade` rather than overwriting anything.
2. **Install Docker if absent** via `get.docker.com`, then verify `docker compose version` works. If Docker exists but the daemon is not running, say that rather than installing over it.
3. **Create `/opt/paco`** and write the compose file and Traefik config. Fetch them from the repository at the tag being installed rather than embedding them in the script, so one script does not drift from the stack it installs.
4. **Generate secrets** — `APP_SECRET` and a Postgres password from `openssl rand -hex 32`, written to `/opt/paco/.env` with mode `600`. **Never echo them.** If `.env` already exists, keep the existing values.
5. **Pull and start.**
6. **Print the URL and stop.** `http://<public-ip>` — no domain, no SMTP, no certificate. Say in one line that the domain and mail server are configured inside the product.

Flags: `--port` (Traefik's HTTP entrypoint, default 80), `--app-url` (sets `APP_URL` for an operator who already knows their domain), `--version` (image tag, default `latest`). `APP_URL` is honoured from the environment too.

**The public IP is a best-effort convenience, not a dependency.** Try a metadata service or an external echo with a short timeout; if it fails, print the hostname instead and carry on. An installer that fails because it could not learn its own IP is worse than one that prints a slightly wrong URL.

- [ ] **Step 2: Syntax-check**

Run: `sh -n install.sh && echo "posix ok"`
Run: `shellcheck -s sh install.sh || echo "(shellcheck unavailable or reported issues — read them)"`
Expected: `posix ok`; address anything shellcheck reports that is a real defect.

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: one-command install on a bare host"
```

---

### Task 4: The `paco` command

**Files:**
- Create: `scripts/paco`

**Interfaces:**
- Produces: `paco upgrade|logs|restart|status|version`, installed to `/usr/local/bin/paco` by the installer.

- [ ] **Step 1: Write it**

POSIX `sh`, operating on `/opt/paco`:

- **`upgrade`** — pull the newest image, recreate the containers, and report the version before and after. Migrations run in `docker-entrypoint.sh`, so nothing extra is needed here; say so in a comment so nobody adds a migration step that races the entrypoint.
- **`logs`** — follow Paco's logs; `paco logs traefik` or `paco logs postgres` for the others.
- **`restart`** — restart Paco only. This is what the Settings page's restart button does through the socket, and what an operator does after changing a domain.
- **`status`** — container states, the resolved `APP_URL`, and whether a domain is configured.
- **`version`** — the running image digest and tag.

**No `uninstall`.** If someone types it, say plainly that there isn't one and that a broken install is replaced by re-running the installer.

- [ ] **Step 2: Syntax-check and commit**

Run: `sh -n scripts/paco && echo "posix ok"`

```bash
git add scripts/paco
git commit -m "feat: the paco command for upgrades and diagnostics"
```

---

### Task 5: Prove it on a real machine

**Files:** none — this task produces evidence, not code.

This is the task the phase exists for. An installer that has only been read is not an installer.

- [ ] **Step 1: Create a throwaway VM**

The Krova CLI is authenticated on this machine and creates Firecracker microVMs:

```bash
krova cubes create --name paco-install-test --image ubuntu-24.04 --vcpu 2 --ram 4 --disk 20
```

Use the **plain** `ubuntu-24.04` image, not `ubuntu-24.04-docker` — installing Docker is the step most likely to be wrong, and starting from an image that already has it would skip exactly what needs testing.

- [ ] **Step 2: Run the installer over SSH**

Copy the working tree's `install.sh` to the Cube and run it as root. Do **not** curl it from GitHub — the branch is not pushed, and the point is to test this working copy.

- [ ] **Step 3: Assert it worked**

From the Cube: `curl -s -o /dev/null -w "%{http_code}" http://localhost/` must return `200`. `docker compose -f /opt/paco/docker-compose.yml ps` must show `traefik`, `paco` and `postgres` running. `/opt/paco/.env` must be mode `600`. The installer's output must not contain either generated secret.

Then, from your own machine, fetch the Cube's public address and confirm the sign-in page is reachable — the first-run registration form should render, because the instance is unclaimed.

- [ ] **Step 4: Test the upgrade path and idempotence**

Run `paco status`, then `paco upgrade`, and confirm the stack comes back. Then run `install.sh` a second time and confirm it refuses without destroying anything and without regenerating `APP_SECRET` — compare the file before and after.

- [ ] **Step 5: Destroy the VM**

```bash
krova cubes rm paco-install-test
```

Record every command and its output in the report. If anything failed, fix it and run the whole sequence again on a **fresh** Cube — a second run on a dirtied machine proves nothing about a bare host.

- [ ] **Step 6: Commit any fixes the real run forced**

```bash
git add -A
git commit -m "fix: what installing on a bare host actually required"
```

---

### Task 6: Documentation and close-out

- [ ] **Step 1: Rewrite the Deploying section**

`README.md` becomes: one command, what it does, the URL it prints, and that the domain, TLS and mail server are configured in Settings afterwards. `docs/self-hosting.md` gets the same install path plus `paco upgrade`, what each `paco` subcommand does, and an explicit line that there is no uninstall and why.

State the requirements honestly: a systemd Linux host, root, and ports 80/443 free.

- [ ] **Step 2: Confirm the image name is consistent**

Run: `grep -rn "ghcr.io" --include="*.yml" --include="*.sh" --include="*.md" . | grep -v node_modules | grep -v '/.next/' | grep -v '/.superpowers/'`
Expected: every hit is `ghcr.io/stack256org/paco`.

- [ ] **Step 3: Run the full checks, once**

Run: `pnpm run ci`
Expected: passes. This phase barely touches TypeScript, so a failure here means something unrelated broke — read it rather than assuming it is noise.

- [ ] **Step 4: Commit**

```bash
pnpm fix
git add -A
git commit -m "docs: one-command install, upgrades, and no uninstall"
```

---

## Self-Review

**Spec coverage.** The spec's Phase 3 asks for a public multi-arch GHCR image (Task 1), a non-interactive installer that installs Docker, writes a generated `.env`, and starts the stack (Task 3), one published port with Traefik owning `:80` (Task 2), a `paco upgrade` with no uninstall (Task 4), and validation on a real VM (Task 5). All covered.

**The known blocker, stated plainly.** The GitHub account authenticated here (`krova-admin`) is **not a member of `stack256org`** — the membership API returns 404. So Task 1's workflow is written and syntax-checked but **cannot be proven to publish**, and `docker compose pull` on the test VM will fail until the image exists. Task 5 works around this by building the image on the VM from the copied source rather than pulling it; that tests the installer and the stack, not the registry. Publishing needs the operator to grant access and push a tag. This is a limitation of the environment, not of the code, and it must be reported as such rather than papered over.

**Type consistency.** Not applicable — this phase is shell, YAML and documentation. The one interface it consumes is Phase 1's environment contract (`APP_URL` optional, `POSTGRES_URL` and `APP_SECRET` required), which the installer satisfies by generating the latter two.

**Known risk.** Traefik's catch-all router for a bare IP and the domain router added in Phase 4 must not fight. Task 2 handles this with router priority — the catch-all is lowest — but the interaction is only fully exercised once Phase 4 adds real hosts, so the reviewer should treat the priority as load-bearing rather than cosmetic.
