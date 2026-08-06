# Native Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paco installs as a native Debian package. `curl … | sudo sh` adds a signed APT repository and installs it; `apt upgrade` updates it thereafter. Postgres, nginx and the Claude CLI are host packages. Docker exists only to run sandboxes.

**Architecture:** A `.deb` ships Paco's built output plus a bundled Node runtime under `/usr/lib/paco`, a systemd unit, and maintainer scripts that create the `paco` service user, provision the database over a Unix socket, and reload nginx. State lives in `/var/lib/paco` — workspaces, and the Claude credential — which `dpkg` never touches on upgrade, so an upgrade cannot log the operator out of Claude the way removing a container could. nginx replaces Traefik: Paco writes a server block per preview and reloads, and nginx's `auth_request` takes the place of forward-auth, so Phase 4's `/api/preview-auth` and `decidePreviewAccess` survive unchanged. The proxy needs no Docker access at all, which removes the socket exposure Phase 3's review flagged.

**Tech Stack:** Debian packaging (`dpkg-deb`, no `debhelper` — the payload is a build output, not a compile), systemd, nginx, certbot, PostgreSQL from the distro, Node 24 bundled, POSIX `sh`.

## Global Constraints

- **Maintainer scripts and the installer are POSIX `sh`.** They run before anything is guaranteed present.
- **Idempotent.** Reinstalling or upgrading must never regenerate a secret, drop a database, or revoke Claude's credential.
- **Never print or log a secret.** `APP_SECRET` lives in `/etc/paco/paco.env`, mode `640`, owned `root:paco`.
- **Postgres must not listen on TCP at all.** Connection is over the Unix socket. This is stronger than an unpublished port and is the point of the exercise.
- **`/var/lib/paco` is sacred.** `dpkg` must not remove it on upgrade or on `remove`. Only `purge` may, and only after saying so.
- **Never use `any`** in TypeScript — `unknown` plus type guards. No `.js` extensions in imports. Double quotes, 2-space indent (`pnpm fix`).
- **UI work goes through the daisyUI Blueprint MCP.**
- **`pnpm run ci` runs ONCE**, at the end.

---

## What this replaces

Phase 3 delivered Paco as a Docker Compose stack. That stays in the repository for development, but stops being the supported production path. Concretely:

- `deploy/docker-compose.yml` and `deploy/traefik/` are **deleted**.
- `install.sh` is **rewritten** — it adds an APT source and installs a package.
- `scripts/paco` keeps its command surface (`upgrade`, `logs`, `restart`, `status`) but operates on systemd and `apt`.
- The release workflow stops publishing the app image and starts publishing **the sandbox image**, which every host genuinely needs and today has to be built by hand.
- Phase 4's `previewLabels` is replaced by nginx config generation. `previewSlug`, `previewHostname`, `decidePreviewAccess`, `/api/preview-auth` and the visibility column all survive.

---

## File Structure

| File | Responsibility |
|---|---|
| `packaging/debian/control` (create) | Package metadata and dependencies |
| `packaging/debian/postinst` (create) | Create user, database, config; enable the unit |
| `packaging/debian/prerm` / `postrm` (create) | Stop cleanly; preserve state unless purged |
| `packaging/paco.service` (create) | systemd unit |
| `packaging/nginx/paco.conf.template` (create) | The app's own server block |
| `packaging/build-deb.sh` (create) | Assemble the `.deb` from a built tree |
| `.github/workflows/release.yml` (modify) | Build the `.deb`, publish the APT repo and the sandbox image |
| `install.sh` (rewrite) | Add the APT source and install |
| `scripts/paco` (rewrite) | systemd/apt operations |
| `apps/web/lib/preview/nginx-config.ts` (create) | Generate a preview server block — pure function |
| `apps/web/lib/preview/nginx-reload.ts` (create) | Write the file and reload nginx |
| `apps/web/lib/preview/labels.ts` (delete) | Replaced |
| `README.md`, `docs/self-hosting.md`, `docs/contributing.md` | Restructured |

---

### Task 1: The systemd unit and the package skeleton

**Files:** create `packaging/debian/control`, `packaging/paco.service`, `packaging/build-deb.sh`.

**Interfaces:**
- Produces: `paco_<version>_<arch>.deb` containing `/usr/lib/paco` (built app + bundled Node), `/usr/bin/paco`, `/lib/systemd/system/paco.service`.

- [ ] **Step 1: Write the control file**

`Depends:` must name what Paco genuinely cannot run without: `postgresql`, `nginx`, `git`, `ca-certificates`. **`docker.io` is a `Recommends`, not a `Depends`** — Paco starts and serves its UI without Docker; only chats need a sandbox, and an operator installing on a host with an existing Docker setup should not have a second one pulled in.

`gh` is neither: it comes from GitHub's own repository and is only needed once someone connects an account. Note it in the description and let `postinst` warn if absent.

Architecture is `amd64` and `arm64`, built separately, because the bundled Node is architecture-specific.

- [ ] **Step 2: Write the systemd unit**

```ini
[Unit]
Description=Paco
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=paco
Group=paco
WorkingDirectory=/usr/lib/paco
EnvironmentFile=/etc/paco/paco.env
ExecStart=/usr/lib/paco/node/bin/node /usr/lib/paco/apps/web/server.js
Restart=always
RestartSec=5
StateDirectory=paco
```

**Do not add sandboxing directives** (`ProtectSystem=strict`, `PrivateTmp`, etc.) without testing each one. Paco shells out to `git`, `gh` and `docker`, and reads a Docker socket — several of the obvious hardening options break exactly that, silently, at the first chat. If you add any, verify a chat still runs and say which you tested.

- [ ] **Step 3: Write `build-deb.sh`**

POSIX `sh`. Takes a version and an architecture, expects `apps/web/.next/standalone` to exist, stages the tree, downloads the matching Node tarball, writes `control` with the version substituted, and runs `dpkg-deb --build --root-owner-group`.

**Verify the bundled Node runs before packaging it**: execute `node --version` from the staged path and compare to what the build expects. A wrong-architecture tarball produces an exec-format error at first boot that reads like a corrupt install.

- [ ] **Step 4: Build one and inspect it**

Run: `pnpm --dir apps/web build` then `sh packaging/build-deb.sh 0.0.0-dev "$(dpkg --print-architecture)"`
Then: `dpkg-deb --contents paco_0.0.0-dev_*.deb | head -30` and `dpkg-deb --info paco_0.0.0-dev_*.deb`

Confirm no `.env`, no `node_modules/.cache`, and nothing under `/root`.

- [ ] **Step 5: Commit**

---

### Task 2: Maintainer scripts

**Files:** create `packaging/debian/postinst`, `prerm`, `postrm`.

**Interfaces:**
- Produces: a `paco` system user, `/etc/paco/paco.env` with a generated secret, a `paco` Postgres role and database reachable over the Unix socket, and an enabled unit.

- [ ] **Step 1: `postinst`**

In order, each step idempotent because `postinst` runs on **every** upgrade, not just first install:

1. `adduser --system --group --home /var/lib/paco paco` — skip if the user exists.
2. Create `/etc/paco` (`0750`, `root:paco`) and `/var/lib/paco` (`0750`, `paco:paco`).
3. **Generate `APP_SECRET` only if `/etc/paco/paco.env` does not already exist.** Regenerating it invalidates every session *and* makes every stored GitHub token permanently undecryptable — the failure Phase 3's review found in the Docker path. Write mode `640`, owner `root:paco`.
4. Create the Postgres role and database **over the Unix socket as the `postgres` user**, both guarded so a second run is a no-op. `POSTGRES_URL` uses the socket path, not `localhost` — so there is no TCP listener to expose, and no password to leak.
5. Install the nginx server block, `nginx -t`, then reload. **If `nginx -t` fails, do not reload** — leave the running config alone and report it. A failed package script that leaves nginx serving is far better than one that takes a working site down.
6. `systemctl daemon-reload`, `enable`, and `restart paco`.
7. Print the URL to open.

**Migrations run at service start, not here.** The unit's `ExecStart` reaches the same `migrate.ts` the container entrypoint used. Running them from `postinst` would mean an `apt upgrade` failing on a migration error, which is a much worse place to discover it.

- [ ] **Step 2: `prerm` and `postrm`**

`prerm`: stop the unit. `postrm`: on `remove`, disable the unit and leave **everything** in `/var/lib/paco` and `/etc/paco` alone. On `purge`, remove config and state — and only then — after `db_input`-style warning is not available, so print plainly what is being destroyed.

**Never drop the database on `remove`.** A remove/reinstall cycle is a normal thing an operator does; losing every session to it is not acceptable.

- [ ] **Step 3: Test the scripts in isolation**

`sh -n` each. Then, on a throwaway VM in Task 6, verify install → upgrade → remove → reinstall preserves `APP_SECRET`, the database, and `/var/lib/paco/.claude`.

- [ ] **Step 4: Commit**

---

### Task 3: Preview routing on nginx

**Files:** create `apps/web/lib/preview/nginx-config.ts` and its test, `apps/web/lib/preview/nginx-reload.ts`; delete `apps/web/lib/preview/labels.ts` and its test; update callers.

**Interfaces:**
- Produces: `previewServerBlock(input: { hostname: string; upstreamPort: number; appPort: number; tlsEnabled: boolean }): string`, and `syncPreviewRoutes(): Promise<void>`.

**What survives unchanged:** `previewSlug`, `previewHostname`, `chats.previewVisibility`, `decidePreviewAccess`, and `GET /api/preview-auth`. Only the mechanism that consults them changes.

- [ ] **Step 1: Write the failing test**

`previewServerBlock` is a pure function producing text, so test the properties that matter rather than the exact string:

```ts
import { describe, expect, test } from "bun:test";
import { previewServerBlock } from "./nginx-config";

const base = { hostname: "abc.previews.example.com", upstreamPort: 49213, appPort: 3000 };

describe("previewServerBlock", () => {
  test("always guards with auth_request", () => {
    // Every preview is authorised by Paco, public or private. The endpoint
    // decides; the config must never decide for it.
    expect(previewServerBlock({ ...base, tlsEnabled: false }))
      .toContain("auth_request /_paco_auth");
  });

  test("passes the real host to the auth endpoint", () => {
    const block = previewServerBlock({ ...base, tlsEnabled: false });
    expect(block).toContain("X-Forwarded-Host $host");
  });

  test("names the hostname exactly once as server_name", () => {
    const block = previewServerBlock({ ...base, tlsEnabled: false });
    expect(block).toMatch(/server_name\s+abc\.previews\.example\.com;/);
  });

  test("refuses a hostname that could break out of the config", () => {
    expect(() =>
      previewServerBlock({ ...base, hostname: "a.com; } server { listen 80;" }),
    ).toThrow();
  });

  test("TLS off emits no ssl_certificate", () => {
    expect(previewServerBlock({ ...base, tlsEnabled: false }))
      .not.toContain("ssl_certificate");
  });

  test("TLS on emits a certificate and an http redirect", () => {
    const block = previewServerBlock({ ...base, tlsEnabled: true });
    expect(block).toContain("ssl_certificate");
    expect(block).toContain("return 301 https://");
  });
});
```

- [ ] **Step 2: Implement**

**The injection guard is the reason this is a function and not a template literal at the call site.** A hostname is derived from a chat id and a configured domain, so it should always be safe — but "should" is not a guarantee, and nginx config is executed as configuration. Validate against a strict hostname pattern and throw otherwise.

`auth_request` points at an internal location proxying `/api/preview-auth` on `127.0.0.1:<appPort>` — the loopback, not the public origin, for exactly the reason Phase 4 discovered: a request that re-enters the public entrypoint has its forwarded headers rewritten.

**Emit `auth_request` unconditionally**, never conditioned on visibility. Phase 4 learned this the hard way: a config conditioned on visibility can only ever describe the visibility at generation time, and turning a preview private again must take effect at once.

- [ ] **Step 3: `nginx-reload.ts`**

Write one file per active preview under `/etc/nginx/conf.d/paco-preview-*.conf`, remove stale ones, run `nginx -t`, and **only reload if it passes**. On failure, restore what was there and report — never leave nginx unable to start.

Paco runs as `paco`, not root, so this needs a narrow sudoers rule for `nginx -t` and `systemctl reload nginx` only. Install it from `postinst` at `/etc/sudoers.d/paco`, mode `440`, and validate with `visudo -c` before installing — a malformed sudoers file locks out `sudo` entirely.

- [ ] **Step 4: Replace the callers, delete the labels module, commit**

---

### Task 4: The APT repository and the release workflow

**Files:** modify `.github/workflows/release.yml`.

- [ ] **Step 1: Build the `.deb` for both architectures and publish an APT repo**

On a `v*` tag: build `amd64` and `arm64` packages, assemble a `Packages`/`Release` index, sign `Release` with a GPG key from repository secrets, and publish to the `gh-pages` branch with a `CNAME` of `apt.stack256.org`.

**Also publish the sandbox image** to `ghcr.io/stack256org/paco-sandbox` from `packages/sandbox/docker`. Every host needs it and today it has to be built by hand — Phase 3's review flagged that a `curl | sh` install could not run a single chat because of it.

**Stop publishing the app image.** Native is the supported path; maintaining a second delivery mechanism is upkeep for a path nobody uses.

- [ ] **Step 2: Gate `:latest` on a final tag**

Keep Phase 3's fix: a prerelease tag such as `v0.2.0-rc1` must not move `latest`, because `latest` is what a default install gets.

- [ ] **Step 3: Validate the YAML and commit**

**Do not push a tag.** Publishing is the operator's decision. Note in the report that `apt.stack256.org` needs a DNS record pointing at `stack256org.github.io` before the repository resolves, and that GitHub Pages must be enabled on the repository.

---

### Task 5: The installer and the `paco` command

**Files:** rewrite `install.sh` and `scripts/paco`.

- [ ] **Step 1: `install.sh`**

1. Require root and a systemd host; refuse clearly otherwise.
2. **Prompt for the domain**, defaulting to the machine's public address when the operator just presses return. Skip the prompt entirely when `--domain` or `PACO_DOMAIN` is given, or when stdin is not a terminal — a `curl | sh` pipeline has no terminal, so it must not hang waiting for input that can never arrive. That case is the one most likely to be got wrong; test it.
3. Install `ca-certificates`, `gnupg`, `curl` if absent; add the signing key and the APT source; `apt-get update`; `apt-get install paco`.
4. Print the URL and what to do next.

Ask for the domain but **do not require it** — Phase 1 made a domain optional on purpose, and an operator trying Paco on a bare IP should not be blocked.

- [ ] **Step 2: `scripts/paco`**

Same command surface, different mechanism: `upgrade` is `apt-get update && apt-get install --only-upgrade paco`; `logs` is `journalctl -u paco`; `restart` is `systemctl restart paco`; `status` reports the unit, the version, the configured domain and whether Claude is authenticated. Add `paco auth` — a thin wrapper running `claude auth login` **as the `paco` user**, so the credential lands in `/var/lib/paco/.claude` and survives every upgrade.

Keep refusing `uninstall`, pointing at `apt remove paco` (keeps data) versus `apt purge paco` (does not).

- [ ] **Step 3: Syntax-check and commit**

---

### Task 6: Prove it on a real machine

The task the work exists for. Nothing here is code.

- [ ] **Step 1: Fresh Cube**

`krova cubes create --name paco-native-test --image ubuntu-24.04 --vcpu 2 --ram 4 --disk 20 --region us --ssh-key <key>`. The plain image — installing Docker is part of what is under test.

- [ ] **Step 2: Install from the built `.deb`**

The APT repository will not exist until a tag is pushed, so copy the `.deb` and `apt install ./paco_*.deb`, which resolves dependencies the same way. Say clearly in the report that this tests the package and not the repository.

- [ ] **Step 3: Assert**

- `systemctl is-active paco` → `active`
- `curl -s -o /dev/null -w "%{http_code}" http://localhost/` → **200**
- `ss -lntp | grep 5432` → **no output**. Postgres must have no TCP listener at all.
- `stat -c "%a %U:%G" /etc/paco/paco.env` → `640 root:paco`
- Neither secret appears anywhere in the installer's output — grep the real values.
- The first-run registration page renders.

- [ ] **Step 4: The upgrade and removal cycle**

Record `APP_SECRET`'s hash, the database's session count, and `/var/lib/paco/.claude`'s presence. Then: reinstall the same `.deb` (upgrade path), `apt remove paco`, reinstall. After each, confirm all three survived. **This is the scenario the whole change exists for** — the container path lost Claude's credential on the documented recovery procedure.

- [ ] **Step 5: Destroy the Cube**, and say how many you used.

---

### Task 7: Documentation

**Files:** `README.md`, `docs/self-hosting.md`, `docs/contributing.md` (create).

- [ ] **Step 1: Restructure the README**

**Deployment first.** Someone landing on the repository wants to know what it is and how to run it, in that order. One command, what it does, the URL, and what to configure afterwards. Requirements stated honestly: a systemd Linux host, root, ports 80 and 443.

Then a short **Contributing** section pointing at `docs/contributing.md` — not the development setup inline, which is what currently pushes deployment down the page.

- [ ] **Step 2: Write `docs/contributing.md`**

The development path, which stays Docker-based and unchanged: prerequisites, `pnpm install`, the local Postgres container, `pnpm web`, how to run tests (`bun test <file>` while iterating, `pnpm run ci` once at the end), the repository layout, and the code-style rules from `AGENTS.md`. Explain that development uses containers while production is a native package, and why — otherwise the difference reads as an inconsistency.

- [ ] **Step 3: Rewrite `docs/self-hosting.md` for the native path**

Install, upgrade, the file layout (`/usr/lib/paco`, `/etc/paco`, `/var/lib/paco`), `paco auth`, what `remove` keeps versus what `purge` destroys, and the DNS records: an A record for the app, and a wildcard for previews.

**Delete the Docker-deployment content** rather than leaving it beside the native path. Two supported-looking install paths where one is unsupported is how an operator ends up on the wrong one.

- [ ] **Step 4: Full checks, once**

Run: `pnpm run ci`

---

## Self-Review

**Coverage of what was asked.** Postgres with no TCP listener (Task 2, asserted in Task 6). The installer prompts for a domain (Task 5) while staying usable in a pipeline. Secrets generated by the installer and never regenerated (Task 2). README restructured with deployment first and a real contributing guide (Task 7). Claude's credential in `/var/lib/paco`, surviving upgrade and removal (Tasks 2 and 5, proven in Task 6 Step 4). Docker used only for sandboxes (Task 1's `Recommends`). `apt upgrade` updates Paco (Task 4).

**What this deliberately breaks.** The Docker Compose production path is deleted, not deprecated. Anyone running it must migrate — and there is no automated migration, because moving a Postgres volume into a native cluster is not something a package script should attempt silently. `docs/self-hosting.md` must say so plainly.

**Known risk.** Task 3 has Paco writing files under `/etc/nginx` and reloading it. That is a privileged operation from a service that runs unprivileged, mediated by a narrow sudoers rule. It is the sharpest edge in this plan: a malformed sudoers file locks out `sudo` entirely, and a malformed nginx config can take the site down. Hence `visudo -c` before installing the rule, and `nginx -t` before every reload, with the previous config restored on failure.

**Unverifiable here.** The APT repository cannot be exercised until a tag is pushed and `apt.stack256.org` has a DNS record pointing at GitHub Pages. Task 6 tests the package directly instead, which covers everything except the repository index and its signature.
