#!/bin/sh
# Build paco_<version>_<arch>.deb from apps/web/.next/standalone.
#
# Usage: sh packaging/build-deb.sh <version> <arch>
#   <version>  e.g. 0.0.0-dev, or a real release version (no leading "v")
#   <arch>     amd64 or arm64 — must match the machine `dpkg -i` will run
#              this package on, not the machine building it: the bundled
#              Node tarball is architecture-specific.
#
# Prerequisite: `pnpm --dir apps/web exec next build` must already have
# produced apps/web/.next/standalone.
#
# Deliberately NOT `pnpm --dir apps/web build` — that script also runs
# database migrations (`db:migrate:apply`) before `next build`, and
# migrations must not run at package-build time: they need a real,
# reachable Postgres, and baking one environment's migration state into an
# artefact meant to install anywhere is exactly wrong. Migrations run from
# `/usr/lib/paco/paco-entrypoint.sh` (paco.service's ExecStart — see
# packaging/paco.service) at every service start instead.
set -e

# So `cd` below always prints the path it changed to, not a CDPATH match.
CDPATH=''

VERSION="$1"
ARCH="$2"

if [ -z "$VERSION" ] || [ -z "$ARCH" ]; then
  echo "usage: $0 <version> <arch (amd64|arm64)>" >&2
  exit 1
fi

case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *)
    echo "build-deb: unsupported architecture '$ARCH' (want amd64 or arm64)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
WEB_DIR="$REPO_ROOT/apps/web"
STANDALONE="$WEB_DIR/.next/standalone"
NODE_VERSION="${NODE_VERSION:-24.19.0}"
# Pinned, not `latest`: two builds of the same release tag must produce the
# same package. See the bundling block below and
# .superpowers/sdd/2026-08-05-native-installation/gaps-report.md (GAP 1).
# Bump this to pick up a new Claude Code release.
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.220}"

if [ ! -d "$STANDALONE" ]; then
  echo "build-deb: $STANDALONE does not exist." >&2
  echo "Run this first (not 'pnpm --dir apps/web build' — see the header of this script):" >&2
  echo "  pnpm --dir apps/web exec next build" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT INT TERM

PKGROOT="$WORKDIR/pkgroot"
mkdir -p "$PKGROOT/usr/lib/paco" "$PKGROOT/usr/bin" \
  "$PKGROOT/lib/systemd/system" "$PKGROOT/DEBIAN"

echo "build-deb: staging apps/web/.next/standalone"
cp -a "$STANDALONE/." "$PKGROOT/usr/lib/paco/"

# `.next/standalone` is Next's own server + node_modules only. `public/` gets
# copied into it automatically (confirmed by inspecting the output on this
# Next version), but `.next/static` — every CSS and client-JS chunk the
# server refers to at request time — is not, per Next's own standalone
# deployment docs: it must be copied in by hand. Skipping this is silent at
# every layer this packaging pipeline had tested before: the server boots,
# every API route resolves its modules and reaches a real (or deliberately
# fake) database call, and `curl /` returns a 200 — because the *document*
# has no dependency on the assets it links to. Only a real browser loading
# the page notices: no CSS, no client-side JS, every `/_next/static/...`
# request 404s. Found by doing exactly that against an installed package.
echo "build-deb: staging apps/web/.next/static"
mkdir -p "$PKGROOT/usr/lib/paco/apps/web/.next/static"
cp -a "$WEB_DIR/.next/static/." "$PKGROOT/usr/lib/paco/apps/web/.next/static/"

# -----------------------------------------------------------------------------
# Repair Turbopack's externalized native-module copies — BEFORE anything
# below deletes or replaces node_modules.
#
# `.next/node_modules/<pkg>-<hash>/` is Turbopack's own copy of a handful of
# packages it decided to `require()` at runtime instead of bundling (native
# modules mostly — on this codebase: `pg`, `cpu-features`, `typescript`,
# `shiki`). What ends up there varies build to build: sometimes a real copy
# of the package's own files without its dependencies (`pg` then fails on
# "Cannot find module 'pg-types'"), sometimes a symlink straight into this
# *repo's* node_modules — which the next step below deletes, so reading it
# has to happen first. Both were reproduced by booting `.next/standalone`
# fully isolated from this repo's own node_modules; see
# .superpowers/sdd/2026-08-05-native-installation/task-12-report.md.
# flatten-closure.mjs replaces each such directory outright with a
# dereferenced copy of the real package plus its full dependency closure,
# resolved fresh via Node's own resolver against this repo's real
# node_modules (correct regardless of pnpm's nested-scope layout, unlike
# re-implementing pnpm's own algorithm).
for next_nm in \
  "$PKGROOT/usr/lib/paco/apps/web/.next/node_modules" \
  "$PKGROOT/usr/lib/paco/.next/node_modules"
do
  [ -d "$next_nm" ] || continue
  for pkgdir in "$next_nm"/*/; do
    [ -e "$pkgdir" ] || continue
    pkgjson="${pkgdir}package.json"
    [ -f "$pkgjson" ] || continue

    name=$(node -e "console.log(require(process.argv[1]).name)" "$pkgjson")
    version=$(node -e "console.log(require(process.argv[1]).version)" "$pkgjson")
    [ -n "$name" ] || continue

    # pnpm store directories are named "<name-with-slash-as-plus>@<version>[_peerhash]".
    encoded=$(printf '%s' "$name" | sed 's,/,+,g')
    scope_dir=""
    for candidate in \
      "$REPO_ROOT/node_modules/.pnpm/${encoded}@${version}" \
      "$REPO_ROOT/node_modules/.pnpm/${encoded}@${version}"_*
    do
      if [ -d "$candidate/node_modules" ]; then
        scope_dir="$candidate/node_modules"
        break
      fi
    done

    if [ -z "$scope_dir" ]; then
      echo "build-deb: warning: no pnpm store scope found for $name@$version ($pkgdir) — leaving it as-is, which may be a dangling symlink" >&2
      continue
    fi

    node "$SCRIPT_DIR/flatten-closure.mjs" "$pkgdir" "$scope_dir"
  done
done

# -----------------------------------------------------------------------------
# Replace the standalone node_modules with a real, complete one.
#
# Turbopack's build-time file tracer, on this codebase, also sometimes omits
# real runtime dependencies from `.next/standalone`'s own top-level
# node_modules copy — same isolated-boot test as above: `drizzle-orm`,
# `postgres`, and `@swc/helpers` were each missing on different runs of an
# otherwise-identical build, and every database-touching route 500'd with
# "Cannot find module". This is not something to patch by whitelisting the
# specific packages found missing so far (`outputFileTracingIncludes` in
# next.config.ts) — the set that goes missing varies build to build, so a
# fixed whitelist is a false sense of safety.
#
# `pnpm deploy` is pnpm's own supported mechanism for producing a complete,
# self-contained install of one workspace package (it resolves
# `workspace:*` protocol dependencies for real and does not go through
# Turbopack's tracer at all), so it replaces the broken copy entirely rather
# than patching around it.
echo "build-deb: resolving a complete node_modules via pnpm deploy"
DEPLOY_DIR="$WORKDIR/deploy"
( cd "$REPO_ROOT" && CI=true pnpm --filter=web deploy --prod --legacy "$DEPLOY_DIR" >/dev/null )

rm -rf "$PKGROOT/usr/lib/paco/node_modules" "$PKGROOT/usr/lib/paco/apps/web/node_modules"
mkdir -p "$PKGROOT/usr/lib/paco/apps/web/node_modules"
cp -a "$DEPLOY_DIR/node_modules/." "$PKGROOT/usr/lib/paco/apps/web/node_modules/"

# -----------------------------------------------------------------------------
# Bundled Node — architecture-specific, downloaded and verified, never taken
# from apt (see packaging/debian/control: Node is not a Depends).
echo "build-deb: fetching Node v$NODE_VERSION ($NODE_ARCH)"
NODE_TARBALL="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
curl -fsSL -o "$WORKDIR/$NODE_TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL"
curl -fsSL -o "$WORKDIR/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
( cd "$WORKDIR" && grep " $NODE_TARBALL\$" SHASUMS256.txt | shasum -a 256 -c - )

mkdir -p "$PKGROOT/usr/lib/paco/node"
tar -xJf "$WORKDIR/$NODE_TARBALL" -C "$PKGROOT/usr/lib/paco/node" --strip-components=1

# Verify the bundled Node actually runs before packaging it: a
# wrong-architecture tarball produces an exec-format error at first boot that
# reads like a corrupt install, not a packaging mistake — much cheaper to
# catch here.
echo "build-deb: verifying the bundled Node runs"
STAGED_VERSION=$("$PKGROOT/usr/lib/paco/node/bin/node" --version)
if [ "$STAGED_VERSION" != "v$NODE_VERSION" ]; then
  echo "build-deb: staged node reports '$STAGED_VERSION', expected 'v$NODE_VERSION'" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Bundled Claude Code CLI — the old Docker image ran `npm install -g
# @anthropic-ai/claude-code` at build time; a native install has to be just
# as self-contained (no network, no npm, on the target host) or there is no
# `claude` at all: every chat fails and `paco auth` has nothing to run. See
# GAP 1 in .superpowers/sdd/2026-08-05-native-installation/gaps-report.md.
#
# Installed with the just-downloaded Node's own bundled npm, into that same
# Node's prefix, so `claude` ends up self-contained under
# /usr/lib/paco/node next to the Node that (indirectly, see below) runs it —
# packaging/claude-wrapper.sh, installed as /usr/bin/claude, is what puts it
# on PATH without adding the rest of the bundled Node toolchain to it.
#
# `--os=linux --cpu=$NODE_ARCH` makes the platform selection explicit,
# matching this script's existing arch-must-match-target rule for Node
# itself (see the usage comment at the top of this file), rather than
# trusting it to be inferred correctly from the build machine.
#
# npm itself is invoked through the bundled Node's own binary rather than
# via `bin/npm`'s `#!/usr/bin/env node` shebang, but that alone is not
# enough: this package's postinstall — the step that actually copies the
# right platform's native `claude` binary out of optionalDependencies — runs
# as `sh -c '...node...'` and resolves *that* `node` from PATH independently
# of what ran npm. Verified by stripping the bundled Node's bin dir from
# PATH here: postinstall failed with "node: command not found" even though
# npm itself had run under the right interpreter. Prepending it to PATH for
# this one command is what actually pins the whole install, lifecycle
# scripts included, to the bundled Node — nothing else on this build
# machine's PATH is consulted.
NODE_BIN_DIR="$PKGROOT/usr/lib/paco/node/bin"
echo "build-deb: installing @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION ($NODE_ARCH)"
# `--allow-scripts` explicitly: recent npm warns (does not yet block, by
# default) before running a freshly-installed package's own lifecycle
# scripts — here, the postinstall that copies the real platform binary over
# the placeholder `bin/claude.exe`. Stated explicitly rather than relying on
# "warn but still run" being every build machine's npm default forever, and
# rather than the opposite risk — some machine's npm defaulting to
# `strict-allow-scripts` and silently shipping a package with the
# placeholder stub still in place instead of the real binary. Either way
# this build is meant to fail loudly (`set -e`) rather than package
# something broken; this line is what keeps the good path silent too.
PATH="$NODE_BIN_DIR:$PATH" "$NODE_BIN_DIR/node" "$NODE_BIN_DIR/npm" \
  install --global --prefix "$PKGROOT/usr/lib/paco/node" \
  --os=linux --cpu="$NODE_ARCH" --no-audit --no-fund \
  --allow-scripts="@anthropic-ai/claude-code" \
  "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"

# Verify the bundled CLI actually runs before packaging it, staged tree and
# all — same reasoning as the Node check above: broken here fails at the
# first chat with an error that reads like a Paco bug, not a packaging
# mistake. (As of this version, @anthropic-ai/claude-code's own `claude` is
# a native binary, copied into place by its postinstall above — not a Node
# script — so this proves the binary itself runs on this architecture; the
# PATH discipline above is what keeps *getting it there* self-contained.)
echo "build-deb: verifying the bundled Claude Code CLI runs"
STAGED_CLAUDE_VERSION=$("$NODE_BIN_DIR/claude" --version)
case "$STAGED_CLAUDE_VERSION" in
  "$CLAUDE_CODE_VERSION "*) ;;
  *)
    echo "build-deb: staged claude reports '$STAGED_CLAUDE_VERSION', expected to start with '$CLAUDE_CODE_VERSION'" >&2
    exit 1
    ;;
esac

# -----------------------------------------------------------------------------
# /usr/bin/paco — the operator CLI (scripts/paco: upgrade/logs/restart/
# status/auth/tls), what an operator actually types. NOT
# packaging/paco-entrypoint.sh: that is the systemd ExecStart target (applies
# migrations, then execs the server — see paco.service), a different program
# that happens to share this one's original name. The two cannot both live
# at /usr/bin/paco, so the entrypoint is staged under /usr/lib/paco instead,
# next to the rest of the app, and paco.service's ExecStart points there
# directly rather than through /usr/bin/paco.
install -m 0755 "$REPO_ROOT/scripts/paco" "$PKGROOT/usr/bin/paco"
install -m 0755 "$SCRIPT_DIR/paco-entrypoint.sh" "$PKGROOT/usr/lib/paco/paco-entrypoint.sh"
# The one privileged action the web app can take (obtain a certificate for the
# domain in Settings), reached through a no-argument sudoers rule the postinst
# installs. 0755 and root-owned: the paco user must not be able to edit the
# thing it is allowed to run as root.
install -m 0755 "$SCRIPT_DIR/paco-tls-hook" "$PKGROOT/usr/lib/paco/paco-tls-hook"
install -m 0755 "$SCRIPT_DIR/claude-wrapper.sh" "$PKGROOT/usr/bin/claude"
install -m 0644 "$SCRIPT_DIR/paco.service" "$PKGROOT/lib/systemd/system/paco.service"

sed -e "s/__VERSION__/$VERSION/" -e "s/__ARCH__/$ARCH/" \
  "$SCRIPT_DIR/debian/control" > "$PKGROOT/DEBIAN/control"

install -m 0755 "$SCRIPT_DIR/debian/postinst" "$PKGROOT/DEBIAN/postinst"
install -m 0755 "$SCRIPT_DIR/debian/prerm" "$PKGROOT/DEBIAN/prerm"
install -m 0755 "$SCRIPT_DIR/debian/postrm" "$PKGROOT/DEBIAN/postrm"

# -----------------------------------------------------------------------------
# Cleanliness. No .env: Next's standalone copy includes whatever .env file
# happened to be sitting in apps/web/ at build time (verified — a developer's
# local apps/web/.env, dev secrets included, ends up at
# .next/standalone/apps/web/.env unless removed here). postinst writes the
# real one at /etc/paco/paco.env; nothing generated at package-build time
# belongs in the package.
find "$PKGROOT/usr/lib/paco" \( -name ".env" -o -name ".env.local" -o -name ".env.*.local" \) \
  -exec rm -f {} +

# No build caches (Next's own dev cache, or pnpm's).
find "$PKGROOT/usr/lib/paco" -type d -name ".cache" -prune -exec rm -rf {} +
rm -rf "$PKGROOT/usr/lib/paco/apps/web/.next/cache"

# Nothing under $PKGROOT/root: nothing above ever writes there — $PKGROOT
# only gets usr/, lib/, and DEBIAN/ created in it — but assert it rather
# than assume it, since dpkg-deb packages whatever is under $PKGROOT
# byte-for-byte. (Checking for a literal "root" path *segment* elsewhere,
# e.g. `*/root/*`, is not this check: plenty of real packages — this one
# included, via @base-ui/react's Meter and Collapsible "root" subcomponents
# — legitimately have a directory named "root" that has nothing to do with
# /root.)
if [ -e "$PKGROOT/root" ]; then
  echo "build-deb: refusing to package — found $PKGROOT/root" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Assert the package can actually serve a *page*, not just a document.
#
# Three separate bugs in this pipeline had the same shape: something the server
# only reaches for at request time was missing from the packaged tree, and
# every check passed anyway — `systemctl is-active` green, `curl /` returning
# 200, API routes reaching the database. A missing `.next/static` is invisible
# to all of them, because the HTML document does not depend on the assets it
# links to; only a browser fetching those links sees the 404s. A missing
# runtime dependency is invisible until the one route that imports it is hit.
#
# So the things whose absence is silent get asserted here, where absence is
# loud. Each of these has actually been missing from a real build of this
# package at some point.
echo "build-deb: verifying the staged tree"
PKG_WEB="$PKGROOT/usr/lib/paco/apps/web"

for required in \
  "$PKGROOT/usr/lib/paco/apps/web/server.js" \
  "$PKGROOT/usr/lib/paco/paco-entrypoint.sh" \
  "$PKGROOT/usr/lib/paco/paco-tls-hook" \
  "$PKGROOT/usr/bin/paco" \
  "$PKGROOT/usr/lib/paco/node/bin/node" \
  "$PKG_WEB/lib/db/migrate.ts" \
  "$PKG_WEB/scripts/workflow-bootstrap.ts"
do
  if [ ! -e "$required" ]; then
    echo "build-deb: refusing to package — missing $required" >&2
    exit 1
  fi
done

# `.next/static` holds every stylesheet and client-JS chunk. Present but empty
# is as broken as absent, and counting is what distinguishes "copied" from
# "created the directory": an earlier version of this script created the
# directory and copied nothing into it.
staged_css=$(find "$PKG_WEB/.next/static" -name '*.css' 2>/dev/null | wc -l | tr -d ' ')
staged_js=$(find "$PKG_WEB/.next/static" -name '*.js' 2>/dev/null | wc -l | tr -d ' ')
source_css=$(find "$WEB_DIR/.next/static" -name '*.css' 2>/dev/null | wc -l | tr -d ' ')

if [ "$staged_css" -eq 0 ] || [ "$staged_js" -eq 0 ]; then
  echo "build-deb: refusing to package — .next/static has $staged_css css and $staged_js js files." >&2
  echo "Every page would load unstyled with no client JS: each /_next/static/... request 404s." >&2
  exit 1
fi

if [ "$staged_css" -ne "$source_css" ]; then
  echo "build-deb: refusing to package — staged .next/static has $staged_css css files but the build produced $source_css." >&2
  exit 1
fi

if [ ! -d "$PKG_WEB/public" ]; then
  echo "build-deb: refusing to package — missing $PKG_WEB/public" >&2
  exit 1
fi

# No prerendered page may be the "Paco needs configuring" screen.
#
# The root layout computes its configuration problems and, if there are any,
# returns that screen *before* it reaches `cookies()`. A build machine has no
# `/etc/paco/paco.env` and no `apps/web/.env`, so during `next build` there are
# always problems — the early return then means Next sees no dynamic API in the
# render, marks the route static, and writes the config-problem screen into a
# real `.html` file. Nine routes did this, `/settings/admin` among them, and the
# package served that frozen screen forever: every operator was told their
# correctly-configured host was unconfigured, and the whole Settings → Admin
# area was unreachable on every install.
#
# It is invisible in development by construction. The trigger is the *absence*
# of a developer's `.env`, which every developer has and no CI runner does — so
# a build on a developer machine cannot reproduce it, and one attempt to
# disprove it failed for exactly that reason.
#
# Keyed on the `data-paco-config-problem` attribute in
# `apps/web/app/config-problem-page.tsx`, not on the visible copy, so rewording
# the page does not silently disarm this.
config_pages=$(
  grep -rl 'data-paco-config-problem' "$PKG_WEB/.next/server/app" 2>/dev/null || true
)
if [ -n "$config_pages" ]; then
  echo "build-deb: refusing to package — the 'needs configuring' screen was prerendered into static HTML:" >&2
  printf '%s\n' "$config_pages" | sed "s|$PKG_WEB/|  |" >&2
  echo "Those files would be served to every operator regardless of how the host is configured." >&2
  echo "The root layout must reach a dynamic API (or set \`export const dynamic = \"force-dynamic\"\`)" >&2
  echo "before it can return that screen, so Next never prerenders it." >&2
  exit 1
fi

echo "build-deb: staged tree has $staged_css css and $staged_js js chunks, public/, and a bundled node"

DEB_NAME="paco_${VERSION}_${ARCH}.deb"
echo "build-deb: building $DEB_NAME"
dpkg-deb --build --root-owner-group "$PKGROOT" "$REPO_ROOT/$DEB_NAME"
echo "build-deb: done: $REPO_ROOT/$DEB_NAME"
