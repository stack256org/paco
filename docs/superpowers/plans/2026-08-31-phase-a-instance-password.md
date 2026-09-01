# Phase A: Instance Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect a Paco instance behind a single nginx basic-auth password that is generated at install time, prompted for when there is a terminal, and rotated with `sudo paco password`.

**Architecture:** nginx gains `auth_basic` on the main server block, reading a bcrypt htpasswd file. `paco password` is the one implementation that writes that file; `postinst` guarantees the file always exists by generating a random password when absent; `install.sh` prompts when it has a terminal and otherwise reports the generated one. Nothing in the Next.js app changes in this phase — Better Auth stays in place and Paco is briefly behind two gates, which is intentional and is what makes Phases B and C safe to do afterwards.

**Tech Stack:** POSIX sh (`scripts/paco`, `install.sh`, `packaging/debian/postinst`), Debian packaging, nginx, `htpasswd` from `apache2-utils`, `bun test` for the shell harness.

**Spec:** [docs/superpowers/specs/2026-08-31-remove-auth-instance-password-design.md](../specs/2026-08-31-remove-auth-instance-password-design.md)

## Global Constraints

- **POSIX sh only** in `scripts/paco`, `install.sh`, and `packaging/debian/postinst`. No bashisms: no arrays, no `[[ ]]`, no `local`. These run on hosts with nothing else guaranteed present.
- **The password never appears in argv.** Use `htpasswd -i` (reads stdin), never `htpasswd -b`. `ps` shows one process's arguments to every user on the machine. This is the rule `AGENTS.md` states for `gh` tokens and it applies identically here.
- **Bcrypt only:** `htpasswd -B`. nginx reads `$2y$` entries; `openssl passwd` cannot produce them.
- **The basic-auth username is the fixed string `paco`.** It is never prompted for and never configurable.
- **`postinst` must be a no-op on re-run.** It runs on every install *and* every upgrade. The password is generated once, ever, guarded on the file not existing — exactly like `APP_SECRET`.
- **A password the operator typed is never echoed back to the terminal.** Only a generated password is ever printed.
- Tests are `bun test`. TypeScript style is Ultracite: double quotes, 2-space indent, no `any`, kebab-case filenames.

## Correction to the spec

The spec places the htpasswd file at `/etc/paco/htpasswd`. **That path cannot work.** `postinst` creates `/etc/paco` as mode `0750 root:paco` ([postinst:47](../../../packaging/debian/postinst#L47)), and nginx's workers run as `www-data`, which is not in the `paco` group and therefore cannot even traverse into that directory.

This plan uses **`/etc/nginx/paco.htpasswd`** (`root:www-data`, `0640`) instead. `/etc/nginx` is `0755 root:root`, so www-data can traverse it, and the group-read bit on the file is what grants nginx the read. `/etc/paco/initial-password` stays under `/etc/paco` — it is read only by root-run tooling (`install.sh`, `paco status`), never by nginx.

---

### Task 1: `paco password` writes the htpasswd file

**Files:**
- Modify: `scripts/paco` — add `NGINX_HTPASSWD` next to the other path variables (near line 16), add `cmd_password()` before the dispatch block (near line 557), add a `password` case to the dispatch (line 574-580), add the command to `usage()` (line 23-86)
- Create: `scripts/paco-password.test.ts`
- Modify: `.github/workflows/ci.yml` — add an apache2-utils install step before the Test step

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the command `paco password [--stdin]`; the file `/etc/nginx/paco.htpasswd` containing exactly one entry, `paco:$2y$...`; the environment override `PACO_HTPASSWD` used by tests and by Task 3's installer call. Deletes `/etc/paco/initial-password` on success. Task 2 seeds the same file path; Task 3 pipes into `paco password --stdin`; Task 4 reads the `initial-password` marker.

- [ ] **Step 1: Write the failing test**

Create `scripts/paco-password.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACO = join(import.meta.dirname, "paco");

type RunResult = { stdout: string; stderr: string; exitCode: number };

async function runPaco(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["sh", PACO, ...args], {
    stdin: options.stdin ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
}

async function htpasswdPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paco-htpasswd-"));
  return join(dir, "paco.htpasswd");
}

describe("paco password", () => {
  test("writes a bcrypt entry for the fixed user 'paco'", async () => {
    const file = await htpasswdPath();

    const result = await runPaco(["password", "--stdin"], {
      stdin: "correct-horse-battery-staple\n",
      env: { PACO_HTPASSWD: file },
    });

    expect(result.exitCode).toBe(0);

    const contents = await readFile(file, "utf8");
    expect(contents).toMatch(/^paco:\$2[aby]\$/);
  });

  test("never stores the password in plaintext", async () => {
    const file = await htpasswdPath();
    const secret = "hunter2-not-in-the-file";

    await runPaco(["password", "--stdin"], {
      stdin: `${secret}\n`,
      env: { PACO_HTPASSWD: file },
    });

    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain(secret);
  });

  test("writes the file group-readable and no wider", async () => {
    const file = await htpasswdPath();

    await runPaco(["password", "--stdin"], {
      stdin: "some-password\n",
      env: { PACO_HTPASSWD: file },
    });

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  test("replaces the previous entry rather than appending a second", async () => {
    const file = await htpasswdPath();

    await runPaco(["password", "--stdin"], {
      stdin: "first-password\n",
      env: { PACO_HTPASSWD: file },
    });
    await runPaco(["password", "--stdin"], {
      stdin: "second-password\n",
      env: { PACO_HTPASSWD: file },
    });

    const lines = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  test("refuses an empty password", async () => {
    const file = await htpasswdPath();

    const result = await runPaco(["password", "--stdin"], {
      stdin: "\n",
      env: { PACO_HTPASSWD: file },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("empty password");
  });

  test("refuses an unknown argument", async () => {
    const file = await htpasswdPath();

    const result = await runPaco(["password", "--wat"], {
      env: { PACO_HTPASSWD: file },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--wat");
  });

  test("is listed in the help output", async () => {
    const result = await runPaco(["--help"]);

    expect(result.stdout).toContain("password");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test scripts/paco-password.test.ts`

Expected: FAIL. Every test that runs `paco password` fails because the dispatch falls through to the `*)` case, printing `paco: unknown command: password` and exiting non-zero, so no file is created and `readFile` rejects with `ENOENT`.

- [ ] **Step 3: Add the htpasswd path variable**

In `scripts/paco`, after the `NGINX_SITE=/etc/nginx/sites-available/paco` line (line 16), add:

```sh
# The instance password, as an nginx htpasswd file.
#
# Under /etc/nginx rather than /etc/paco because $PACO_ETC is 0750 root:paco
# and nginx's workers run as www-data — not in that group, and so unable even
# to traverse into it. /etc/nginx is 0755 root:root, so www-data gets there,
# and the file's group-read bit is what lets it read this.
#
# Overridable so the test suite can point it at a temporary path; see the
# /etc/* guard in cmd_password for why that does not weaken the root check.
NGINX_HTPASSWD="${PACO_HTPASSWD:-/etc/nginx/paco.htpasswd}"
```

- [ ] **Step 4: Add `cmd_password`**

In `scripts/paco`, immediately before the `# --- dispatch ---` comment (line 566), add:

```sh
# --- password ----------------------------------------------------------------

read_password_twice() {
  [ -t 0 ] || fail "password: no terminal to prompt on. Use 'paco password --stdin'."

  printf 'New password for this Paco instance: '
  stty -echo 2>/dev/null || true
  IFS= read -r new_password || true
  stty echo 2>/dev/null || true
  printf '\n'

  printf 'Confirm: '
  stty -echo 2>/dev/null || true
  IFS= read -r confirm_password || true
  stty echo 2>/dev/null || true
  printf '\n'

  [ "$new_password" = "$confirm_password" ] \
    || fail "password: the two entries did not match. Nothing was changed."
}

cmd_password() {
  use_stdin=0
  case "${1:-}" in
    --stdin) use_stdin=1 ;;
    "") ;;
    *) fail "password: unknown argument: $1" ;;
  esac

  # Root is required to write the real file under /etc, and only for that.
  # A run pointed somewhere writable by $PACO_HTPASSWD needs no privilege,
  # which is what makes this command testable without weakening the check:
  # the guard is on the path actually being written, not on an opt-out flag.
  case "$NGINX_HTPASSWD" in
    /etc/*) require_root password ;;
  esac

  command -v htpasswd >/dev/null 2>&1 \
    || fail "password: htpasswd not found. Install apache2-utils."

  new_password=""
  confirm_password=""

  if [ "$use_stdin" -eq 1 ]; then
    IFS= read -r new_password || true
  else
    read_password_twice
  fi

  [ -n "$new_password" ] || fail "password: an empty password is not allowed."

  # -i reads the password from stdin. `htpasswd -b` would put it in argv,
  # where `ps` shows it to every user on this machine. -B is bcrypt, which
  # nginx reads and `openssl passwd` cannot produce. -c truncates, which is
  # what we want: this file holds exactly one entry and rotating replaces it.
  umask 027
  printf '%s' "$new_password" \
    | htpasswd -i -B -c "$NGINX_HTPASSWD" paco >/dev/null 2>&1 \
    || fail "password: htpasswd failed to write $NGINX_HTPASSWD."

  # Best-effort: fails harmlessly when this is a test run as a normal user.
  chown root:www-data "$NGINX_HTPASSWD" 2>/dev/null || true
  chmod 640 "$NGINX_HTPASSWD"

  # The generated password is no longer a fact about this system.
  rm -f "$PACO_ETC/initial-password"

  # No `systemctl reload`: nginx reads auth_basic_user_file per request, so
  # this is already in effect. Browsers holding the old password start
  # getting 401s and re-prompt on their own — that is the re-authentication.
  echo "paco: password updated. Browsers will ask for it again on their next request."
}
```

- [ ] **Step 5: Wire the dispatch and the help text**

In `scripts/paco`, add to the `case "$command"` block after the `auth) cmd_auth "$@" ;;` line:

```sh
  password) cmd_password "$@" ;;
```

And in `usage()`, after the `auth [PROVIDER] [ARGS...]` entry and before the `tls DOMAIN` entry, add:

```text
  password   Set the password protecting this instance, asked for by the
             browser as user `paco`. Requires root.

             paco password           Prompts twice, with echo off.
             paco password --stdin   Reads the password from stdin, for
                                     scripts and for install.sh.

             Takes effect immediately — nginx re-reads the password file on
             every request, so there is nothing to restart. Browsers holding
             the old password are asked again on their next request; that is
             what replaces signing out.
```

- [ ] **Step 6: Give CI the `htpasswd` binary**

These tests shell out to `htpasswd`, and `scripts/test-isolated.ts` globs `**/*.test.ts` from the repository root, so CI will run them. `htpasswd` is not guaranteed to be on a GitHub runner, and without it every test in this file fails on `htpasswd not found` rather than on anything real.

In `.github/workflows/ci.yml`, add a step immediately before the `- name: Test` step:

```yaml
      # scripts/paco-password.test.ts and packaging/postinst-nginx.test.ts
      # exercise the real `htpasswd`, because the thing worth testing is the
      # hash nginx will actually read. It is not guaranteed on the runner
      # image, and `paco password` refuses to run without it.
      - name: Install htpasswd
        run: sudo apt-get update && sudo apt-get install -y apache2-utils
```

Do not make the tests skip when `htpasswd` is missing. A skipped test on the runner looks identical to a passing one, and this is the security-critical half of the feature.

- [ ] **Step 7: Run the test and verify it passes**

Run: `bun test scripts/paco-password.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add scripts/paco scripts/paco-password.test.ts .github/workflows/ci.yml
git commit -m "feat(cli): add 'paco password' to set the instance password"
```

---

### Task 2: postinst seeds the password and nginx requires it

**Files:**
- Modify: `packaging/debian/postinst` — add `NGINX_HTPASSWD` to the variables (near line 16), add step 2b after the directories block (line 55), add `auth_basic` to the nginx site heredoc (line 124-143)
- Modify: `packaging/debian/control:6` — add `apache2-utils` to `Depends`
- Create: `packaging/postinst-nginx.test.ts`

**Interfaces:**
- Consumes: the file path `/etc/nginx/paco.htpasswd` and the single-entry `paco:` format established in Task 1.
- Produces: the guarantee that `/etc/nginx/paco.htpasswd` exists after `apt-get install paco`, and the marker file `/etc/paco/initial-password` (`0600 root:root`) holding the generated password in plaintext. Task 3 reads that marker to print the password; Task 4 reads it to report status.

- [ ] **Step 1: Write the failing test**

Create `packaging/postinst-nginx.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const POSTINST = join(import.meta.dirname, "debian", "postinst");
const CONTROL = join(import.meta.dirname, "debian", "control");

describe("packaging protects the instance", () => {
  test("the nginx site requires basic auth", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    expect(postinst).toContain('auth_basic "Paco"');
    expect(postinst).toContain(
      "auth_basic_user_file /etc/nginx/paco.htpasswd;",
    );
  });

  test("the password file is generated only when absent", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    // Guarded on the file not existing, the same shape as the APP_SECRET
    // guard above it. An upgrade must never change the operator's password.
    expect(postinst).toContain('if [ ! -f "$NGINX_HTPASSWD" ]; then');
  });

  test("the generated password is hashed, never written in the clear", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    expect(postinst).toContain("htpasswd -i -B -c");
    expect(postinst).not.toContain("htpasswd -b");
  });

  test("htpasswd is guaranteed present by a package dependency", async () => {
    const control = await readFile(CONTROL, "utf8");

    const depends = control
      .split("\n")
      .find((line) => line.startsWith("Depends:"));

    expect(depends).toBeDefined();
    expect(depends).toContain("apache2-utils");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test packaging/postinst-nginx.test.ts`

Expected: FAIL, 4 tests. `postinst` contains no `auth_basic` and no `NGINX_HTPASSWD` guard, and `control`'s `Depends` line has no `apache2-utils`.

**What this test does and does not prove.** It asserts on the *text* of the packaging scripts, not on their behaviour — there is no Debian host in this test run to execute `postinst` against. It is a regression guard: it fails loudly if someone deletes the `auth_basic` lines or switches to the argv-leaking `htpasswd -b`. Actual install behaviour is verified by hand in Task 5.

- [ ] **Step 3: Add the variable and the generation step to postinst**

In `packaging/debian/postinst`, after the `NGINX_ENABLED=/etc/nginx/sites-enabled/paco` line (line 16), add:

```sh
# The instance password, as an nginx htpasswd file. Under /etc/nginx and not
# /etc/paco because $PACO_ETC is 0750 root:paco and nginx's workers are
# www-data, which cannot traverse into it.
NGINX_HTPASSWD=/etc/nginx/paco.htpasswd
```

Then, immediately after the `install -d -m 0750 -o "$PACO_USER" -g "$PACO_GROUP" "$PACO_NGINX_DIR"` line (line 55), add:

```sh
# -----------------------------------------------------------------------------
# 2b. The instance password. This file has to exist before the site in step 5
# is enabled: an `auth_basic_user_file` pointing at a missing path does NOT
# fail `nginx -t` — the file is only opened per request — so the failure would
# surface as a 500 on every visit rather than a password prompt.
#
# Generated once and never regenerated, the same rule as APP_SECRET in step 3:
# an upgrade must not silently change the operator's password. Guarded on the
# file not existing, nothing else.
#
# `apt-get install paco` on its own is a supported entry point, so this cannot
# be left to install.sh. install.sh only ever refines what is written here.
if [ ! -f "$NGINX_HTPASSWD" ]; then
  # Alphanumeric only: this gets read off a terminal and typed into a browser
  # prompt by hand, so base64's +/= are a transcription hazard for no gain.
  generated_password=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-24)

  umask 027
  # -i keeps the password out of argv, where `ps` would show it to every user
  # on this machine; -B is bcrypt, which is what nginx reads.
  printf '%s' "$generated_password" \
    | htpasswd -i -B -c "$NGINX_HTPASSWD" paco >/dev/null 2>&1
  chown root:www-data "$NGINX_HTPASSWD" 2>/dev/null || true
  chmod 640 "$NGINX_HTPASSWD"

  # Root-only, and deliberately plaintext: install.sh prints it in the closing
  # summary and `paco status` reports that the instance is still on a
  # generated password. `paco password` deletes it once a real one is set.
  printf '%s\n' "$generated_password" > "$PACO_ETC/initial-password"
  chown root:root "$PACO_ETC/initial-password"
  chmod 600 "$PACO_ETC/initial-password"
fi
```

- [ ] **Step 4: Require the password in the nginx site**

In `packaging/debian/postinst`, inside the `cat > "$NGINX_SITE" <<'EOF'` heredoc (line 124-143), add the two directives inside the `server { ... }` block, immediately after the `server_name _;` line:

```nginx
    # The instance password. Written by postinst on first install and rotated
    # with `paco password`; nginx re-reads it per request, so a change needs
    # no reload. This is the only thing standing between the public internet
    # and this instance — Paco itself has no sign-in.
    auth_basic "Paco";
    auth_basic_user_file /etc/nginx/paco.htpasswd;
```

The heredoc delimiter is quoted (`<<'EOF'`), so nothing here is expanded by the shell and the path must be written out literally rather than as `$NGINX_HTPASSWD`.

- [ ] **Step 5: Correct the site file's misleading header comment**

The `cat > "$NGINX_SITE"` on line 124 is **unconditional** — it runs on every install *and* every upgrade — but the first two lines it writes claim the opposite and invite the operator to edit the file. An operator who does so loses their edits at the next `apt upgrade`. This is a pre-existing bug, and the comment is the half that is wrong: the unconditional write is what guarantees the `auth_basic` directives reach every install, which is the property we want for a security control.

Inside the same heredoc, replace:

```nginx
# Installed by paco's postinst. Edit freely — this file is never
# regenerated once it exists, only re-tested and reloaded on upgrade.
```

with:

```nginx
# Installed by paco's postinst, and REWRITTEN by it on every upgrade.
# Do not edit: your changes will be overwritten. This is deliberate — the
# auth_basic directives below are the only thing protecting this instance,
# so an upgrade has to be able to repair them. Put local customisation in
# a separate server block or an include, not here.
```

- [ ] **Step 6: Add the package dependency**

In `packaging/debian/control`, change line 6 from:

```text
Depends: postgresql, postgresql-client, nginx, git, ca-certificates, adduser, sudo
```

to:

```text
Depends: postgresql, postgresql-client, nginx, git, ca-certificates, adduser, sudo, apache2-utils
```

- [ ] **Step 7: Run the test and verify it passes**

Run: `bun test packaging/postinst-nginx.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add packaging/debian/postinst packaging/debian/control packaging/postinst-nginx.test.ts
git commit -m "feat(packaging): require an instance password in the nginx site"
```

---

### Task 3: `install.sh` prompts for the password, or reports the generated one

**Files:**
- Modify: `install.sh` — add `PASSWORD`/`password_given` to the variables (line 50-51), add `--password` to `usage()` (line 59-72) and to the argument loop (line 76-97), add the prompt as a new step after the domain prompt (line 158), apply it after the package install (line 400), extend the closing summary (line 414-441)
- Create: `install-password.test.ts` at the repository root, beside `install.sh`

**Interfaces:**
- Consumes: `paco password --stdin` from Task 1; `/etc/paco/initial-password` from Task 2.
- Produces: the flag `--password VALUE` and the environment variable `PACO_PASSWORD`; a closing summary that always prints the username `paco` and prints the password itself only when it was generated rather than chosen.

- [ ] **Step 1: Write the failing test**

Create `install-password.test.ts` at the repository root:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const INSTALL = join(import.meta.dirname, "install.sh");

type RunResult = { stdout: string; stderr: string; exitCode: number };

async function runInstall(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["sh", INSTALL, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
}

describe("install.sh password handling", () => {
  test("documents --password and PACO_PASSWORD", async () => {
    const result = await runInstall(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--password");
    expect(result.stdout).toContain("PACO_PASSWORD");
  });

  test("states that a password is always set", async () => {
    const result = await runInstall(["--help"]);

    // The no-TTY path must be discoverable from --help alone: someone
    // reading this before piping it to sh needs to know an unattended
    // install still ends up protected.
    expect(result.stdout).toContain("generated");
  });

  test("rejects --password with no value", async () => {
    const result = await runInstall(["--password"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--password needs a value");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test install-password.test.ts`

Expected: FAIL, 3 tests. `--help` mentions neither `--password` nor `PACO_PASSWORD`, and `--password` is rejected by the `*)` branch as an unrecognised argument rather than by a value check.

Note that these tests exercise only the paths reachable without root — argument parsing and help text. `install.sh` requires root at step 1, before any of the install work, so the prompt and summary paths cannot run in the test suite. They are verified by hand in Task 5.

- [ ] **Step 3: Add the variables and argument parsing**

In `install.sh`, after the `DRY_RUN=0` line (line 51), add:

```sh
PASSWORD=""
password_given=0
```

In the argument loop, after the `--domain` case block (line 78-83), add:

```sh
    --password)
      [ $# -ge 2 ] || fail "--password needs a value"
      PASSWORD="$2"
      password_given=1
      shift 2
      ;;
```

- [ ] **Step 4: Document it in `usage()`**

In `install.sh`, in the `usage()` heredoc, after the `--domain HOST` entry and before `--dry-run`, add:

```text
  --password PW  The password that will protect this instance in the browser
                 (username: paco). Optional. Also read from PACO_PASSWORD.
                 With a terminal and neither of these given, you are prompted
                 for one. With no terminal — a piped `curl ... | sudo sh` —
                 a strong password is generated and printed at the end.
                 Change it any time with `sudo paco password`.
```

- [ ] **Step 5: Add the prompt**

In `install.sh`, immediately after the domain prompt block ends (after line 158, the `fi` closing `if [ "$domain_given" -eq 0 ]`), add:

```sh
# --- 2b. The password prompt, guarded exactly as the domain prompt above. ---
# `[ -t 0 ]` is true only when stdin is a real terminal. The advertised
# install is `curl -fsSL ... | sudo sh`, which has none: a `read` here would
# hang it forever. With no terminal we do not prompt and do not fail — the
# package's postinst has already generated a password, and the summary at the
# end prints it.
if [ "$password_given" -eq 0 ] && [ "${PACO_PASSWORD+is_set}" = "is_set" ]; then
  PASSWORD="$PACO_PASSWORD"
  password_given=1
fi

if [ "$password_given" -eq 0 ] && [ -t 0 ]; then
  printf 'Password to protect this Paco instance in the browser (username: paco).\n'
  printf 'Leave blank to have one generated for you.\n'

  printf 'Password: '
  stty -echo 2>/dev/null || true
  password_input=""
  read -r password_input || true
  stty echo 2>/dev/null || true
  printf '\n'

  if [ -n "$password_input" ]; then
    printf 'Confirm: '
    stty -echo 2>/dev/null || true
    password_confirm=""
    read -r password_confirm || true
    stty echo 2>/dev/null || true
    printf '\n'

    if [ "$password_input" = "$password_confirm" ]; then
      PASSWORD="$password_input"
      password_given=1
    else
      # Not fatal: a generated password is a perfectly good outcome, and
      # failing the whole install over a typo would be worse than falling
      # back to one the operator can change with `paco password`.
      echo "install.sh: the two entries did not match - generating a password instead."
    fi
  fi
fi
```

- [ ] **Step 6: Apply the chosen password after the package is installed**

In `install.sh`, in step 4, immediately before the `echo` that begins the closing summary (line 413), add:

```sh
# postinst has generated a password by this point. If the operator chose one,
# replace it now — `paco password` is the single implementation, so the
# installer never writes the htpasswd file itself. Piped on stdin, never
# passed as an argument: `ps` shows one process's arguments to every user.
if [ "$password_given" -eq 1 ] && [ -n "$PASSWORD" ]; then
  printf '%s' "$PASSWORD" | paco password --stdin >/dev/null \
    || fail "could not set the password. The instance is protected by the generated one; change it with 'sudo paco password'."
fi
```

- [ ] **Step 7: Report the password in the closing summary**

In `install.sh`, immediately after the `if [ -n "$DOMAIN" ] ... fi` block that prints the URL (after line 441) and before the `echo` preceding the Docker status block, add:

```sh
echo
# The username is always printed; the password only when it was generated.
# One the operator typed is theirs already, and echoing it back would put a
# chosen secret into the terminal scrollback for no benefit.
if [ -f "$PACO_ETC/initial-password" ]; then
  echo "It is protected by a password, which was generated for you:"
  echo
  echo "    username: paco"
  echo "    password: $(cat "$PACO_ETC/initial-password")"
  echo
  echo "Write it down - this is the only time it is printed. Change it with"
  echo "'sudo paco password'."
else
  echo "It is protected by the password you chose (username: paco)."
  echo "Change it with 'sudo paco password'."
fi
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `bun test install-password.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 9: Commit**

```bash
git add install.sh install-password.test.ts
git commit -m "feat(install): prompt for the instance password, or report the generated one"
```

---

### Task 4: `paco status` reports whether the password is still the generated one

**Files:**
- Modify: `scripts/paco` — add a `password_state()` helper beside `claude_auth_state()` (near line 478), add a line to `cmd_status()` (line 557-563)
- Modify: `scripts/paco-password.test.ts` — add the status test

**Interfaces:**
- Consumes: `/etc/paco/initial-password` from Task 2, `NGINX_HTPASSWD` from Task 1.
- Produces: a `Password:` row in `paco status`. Nothing else depends on it.

- [ ] **Step 1: Write the failing test**

Append to the `describe("paco password", ...)` block in `scripts/paco-password.test.ts`:

```ts
  test("status reports the password state", async () => {
    const result = await runPaco(["status"]);

    // `paco status` degrades rather than failing off a Debian host: every
    // other row prints "unknown" here. All this asserts is that the row
    // exists at all, which is what a regression would remove.
    expect(result.stdout).toContain("Password:");
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test scripts/paco-password.test.ts`

Expected: FAIL on the new test only — `cmd_status` prints `Unit:`, `Version:`, `Domain:`, `CLI:`, `Claude:` and `Poolside:`, with no `Password:` row. The 7 tests from Task 1 still pass.

- [ ] **Step 3: Add the helper**

In `scripts/paco`, immediately before `cmd_status()` (line 557), add:

```sh
# Whether this instance is still using the password postinst generated.
#
# The marker file is what distinguishes the two, not the hash: a bcrypt hash
# cannot be compared against anything without the original. `paco password`
# deletes the marker, so its presence means "generated, never changed".
password_state() {
  if [ ! -f "$NGINX_HTPASSWD" ]; then
    echo "NOT SET - this instance is unprotected. Run 'sudo paco password'."
    return 0
  fi

  if [ -f "$PACO_ETC/initial-password" ]; then
    echo "set (still the one generated at install; change with 'sudo paco password')"
    return 0
  fi

  echo "set"
}
```

- [ ] **Step 4: Add the row to `cmd_status`**

In `scripts/paco`, in `cmd_status()`, after the `echo "Domain:    $(configured_domain)"` line, add:

```sh
  echo "Password:  $(password_state)"
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `bun test scripts/paco-password.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/paco scripts/paco-password.test.ts
git commit -m "feat(cli): report the instance password state in 'paco status'"
```

---

### Task 5: Documentation and end-to-end verification

**Files:**
- Modify: `README.md` — the installation section, to say the instance is password-protected and how to change it
- Modify: `docs/self-hosting.md` — add `paco password` to the command reference and describe the generated-password flow
- Modify: `docs/contributing.md` — note that a dev checkout has no nginx and therefore no password
- Modify: `AGENTS.md` — add the instance password to the Authentication section as the *deployment* gate, alongside the existing Better Auth description which is still accurate in this phase
- Modify: `package.json:3` — bump `version` to `0.3.0` so the merge cuts a release

**Interfaces:**
- Consumes: everything from Tasks 1-4. Produces: no code.

- [ ] **Step 1: Update `AGENTS.md`**

In the `## Authentication` section, after the existing paragraphs, add:

```markdown
Separately from the above, a packaged install is protected by an **instance
password**: nginx `auth_basic` reading `/etc/nginx/paco.htpasswd`, with the
fixed username `paco`. It is generated by `postinst` on first install, can be
chosen during `install.sh`, and is rotated with `sudo paco password`. nginx
re-reads the file per request, so a change needs no reload and browsers
holding the old password re-prompt on their own.

This gate exists only where nginx does — the `.deb` install. A development
checkout (`pnpm web`) and any container run have no nginx and no password.
```

- [ ] **Step 2: Update `docs/self-hosting.md`**

Add a new section. Place it beside the other operational sections, and add `paco password` to the command reference wherever `paco tls` and `paco auth` are already listed:

```markdown
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
```

- [ ] **Step 3: Update `README.md`**

In the installation section, immediately after the install command, add:

```markdown
The instance comes up protected by a password, asked for by the browser with
the username `paco`. The installer either asks you to choose one or generates
it and prints it when it finishes. Change it later with `sudo paco password`;
see [The instance password](docs/self-hosting.md#the-instance-password).
```

- [ ] **Step 4: Update `docs/contributing.md`**

In the setup section, immediately after step 6 (`pnpm web`), add:

```markdown
> **A development checkout has no password.** The instance password is
> enforced by nginx, which only the `.deb` install sets up — so `pnpm web`
> serves an unprotected Paco. That is fine on localhost and is the only
> supported unprotected configuration; do not expose it to a network.
```

- [ ] **Step 5: Bump the version so merging cuts a release**

`.github/workflows/release.yml` treats `version` in the root `package.json` as the source of truth: a push to main carrying a version with no matching tag is tagged, built, published, and pushed to `apt.stack256.org`; a version that already has a tag publishes nothing. `v0.2.2` already exists, so merging without this step ships nothing.

In the root `package.json`, change:

```json
  "version": "0.2.2",
```

to:

```json
  "version": "0.3.0",
```

Minor, not patch: this adds a user-visible feature and changes install behaviour (an install now ends up password-protected), which is more than a patch conveys. It is not a major bump because nothing existing breaks — Phase C is where that happens.

Do not create the tag by hand. The release workflow does it, and the file's own header records that hand-pushed tags silently failed to trigger a build three times.

- [ ] **Step 6: Run the full check**

Run: `pnpm run ci`

Expected: PASS. Per `AGENTS.md` this is the once-at-the-end check; it runs format, lint, typecheck and the full suite.

- [ ] **Step 7: Verify on a real install by hand**

The packaging tests assert on script text, not behaviour, so the install itself is verified manually. On a throwaway Debian VM or container:

```bash
# 1. Unattended install: no terminal, so a password is generated.
curl -fsSL https://apt.stack256.org/paco/install.sh | sudo sh
#    Expect: the closing summary prints "username: paco" and a password.

# 2. The gate is real.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/
#    Expect: 401

curl -s -o /dev/null -w '%{http_code}\n' -u paco:<printed password> http://localhost/
#    Expect: 200

# 3. Rotation takes effect with no reload.
sudo paco password        # type a new one twice
curl -s -o /dev/null -w '%{http_code}\n' -u paco:<old password> http://localhost/
#    Expect: 401
curl -s -o /dev/null -w '%{http_code}\n' -u paco:<new password> http://localhost/
#    Expect: 200

# 4. The marker is gone and status says so.
sudo paco status
#    Expect: "Password:  set" (no longer "still the one generated at install")

# 5. Upgrade does not change the password.
sudo paco upgrade
curl -s -o /dev/null -w '%{http_code}\n' -u paco:<new password> http://localhost/
#    Expect: 200
```

- [ ] **Step 8: Commit**

```bash
git add README.md docs/self-hosting.md docs/contributing.md AGENTS.md
git commit -m "docs: document the instance password"
```

---

## What Phase A deliberately does not do

- **Previews are untouched.** They keep their `auth_request` to `/api/preview-auth`, which still authorizes against chat ownership because Better Auth is still present. Phase B replaces that mechanism with `auth_basic`; until then there is no gap, because the existing mechanism still works.
- **The app is unchanged.** No route, component, or schema is modified. Paco is briefly behind two gates — the instance password and Better Auth — which is the intended state between Phase A and Phase C.
- **A development checkout gains no protection.** This is a consequence of enforcing at nginx, recorded in the spec's "Consequences accepted", and documented in Task 5 rather than worked around.
