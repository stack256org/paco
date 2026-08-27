#!/bin/sh
# install.sh — add Paco's APT repository and install the `paco` package.
#
# POSIX sh: this has to run on a host with nothing else guaranteed present,
# so no bashisms, no arrays, no `[[ ]]`. The one place this script reads from
# the terminal (the domain prompt, step 2 below) is guarded so a
# `curl ... | sudo sh` pipeline — which has no terminal at all — never blocks
# on a `read` that can never be answered.
#
# Root is needed to INSTALL — apt sources, packages, a system account, systemd
# units. Paco does not RUN as root: postinst creates the unprivileged `paco`
# account and packaging/paco.service runs the service as `User=paco`/
# `Group=paco`. The one privilege that account is given afterwards is
# membership of the `docker` group (postinst step 6b), which is what lets it
# start the containers chats run in.
set -eu

APT_REPO_URL="https://apt.stack256.org"
# Both of these are named after the ORGANISATION, not this product, and that is
# load-bearing rather than cosmetic.
#
# apt.stack256.org is one repository serving every Stack256 package, signed by
# one key. If each product's installer wrote its own source file, a host running
# two of them would carry two `.list` entries for the identical `deb
# https://apt.stack256.org stable main` line — which apt reports on every update
# as "Target Packages ... is configured multiple times", and which means
# removing one product silently breaks the other's updates. One repository gets
# one source file, whichever product's installer happens to write it first.
#
# The same argument applies to the keyring: one key signs the whole index, so a
# Paco-named key would read as Paco's own and become wrong the moment Paco is
# not the only thing installed.
#
# These paths are verified against the live server, not assumed — see the
# `stack256-archive-keyring.gpg` and `dists/stable/InRelease` entries published
# by Stack256org/apt's reindex workflow.
APT_SOURCE=/etc/apt/sources.list.d/stack256.list
KEYRING_DIR=/etc/apt/keyrings
KEYRING_FILE="$KEYRING_DIR/stack256-archive-keyring.gpg"
GPG_KEY_URL="$APT_REPO_URL/stack256-archive-keyring.gpg"

# What v0.1.0's installer wrote. Removed rather than left in place — see the
# migration step further down for why leaving them is not harmless.
LEGACY_APT_SOURCE=/etc/apt/sources.list.d/paco.list
LEGACY_KEYRING_FILE="$KEYRING_DIR/stack256-paco.gpg"

PACO_ETC=/etc/paco
PACO_ENV="$PACO_ETC/paco.env"

DOMAIN=""
DRY_RUN=0

fail() {
  echo "install.sh: $1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--domain HOST] [--dry-run]

  --domain HOST  The address this instance will be reached at (a DNS name or
                 a bare IP). Optional — Paco runs fine on a bare IP with no
                 domain at all; set one later from Settings if you skip it
                 here. Also read from PACO_DOMAIN. Passing this (even
                 --domain "") skips the interactive prompt.
  --dry-run      Do everything except actually install packages or write
                 files — prints what would happen.

Non-interactive use (curl ... | sudo sh, CI, PACO_DOMAIN=... sh install.sh)
never prompts: the domain prompt only ever appears when stdin is a real
terminal and neither --domain nor PACO_DOMAIN was given.
EOF
}

domain_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      [ $# -ge 2 ] || fail "--domain needs a value"
      DOMAIN="$2"
      domain_given=1
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unrecognised argument: $1"
      ;;
  esac
done

# --- 1. Require root and a systemd host, and refuse clearly otherwise. -----

# Name both invocation shapes, rather than guessing which one is in use. The
# advertised install is the piped one, and someone who runs that without sudo
# has no install.sh on disk for "try: sudo sh install.sh" to refer to.
[ "$(id -u)" = "0" ] || fail "this must be run as root. Piped: 'curl -fsSL https://apt.stack256.org/paco/install.sh | sudo sh'. From a downloaded copy: 'sudo sh install.sh'."

if [ ! -d /run/systemd/system ]; then
  fail "no systemd found on this host. The paco package's service, and this installer, both assume one — there is no other supported native install path."
fi

# --- 2. The domain prompt. This is the step most likely to be got wrong: ---
# a piped `curl | sudo sh` has no terminal, so blocking on `read` here would
# hang the advertised install command forever. `[ -t 0 ]` is true only when
# stdin is an actual terminal, never when it's a pipe — that is what makes
# skipping safe rather than a guess.
if [ "$domain_given" -eq 0 ] && [ "${PACO_DOMAIN+is_set}" = "is_set" ]; then
  DOMAIN="$PACO_DOMAIN"
  domain_given=1
fi

# Best-effort discovery of this machine's public address, used only as the
# prompt's default and as the fallback when nothing else was given. Two
# short-timeout lookups, then the local hostname — never blocks the install
# on a slow or unreachable metadata service.
public_address() {
  addr="$(curl -fsS --max-time 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
  if [ -z "$addr" ]; then
    addr="$(curl -fsS --max-time 2 https://ifconfig.me 2>/dev/null || true)"
  fi
  if [ -z "$addr" ]; then
    addr="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo localhost)"
  fi
  echo "$addr"
}

if [ "$domain_given" -eq 0 ]; then
  if [ -t 0 ]; then
    default_domain="$(public_address)"
    printf 'Domain for this Paco instance (used for magic-link emails and pull-request links).\n'
    printf 'Leave blank to use this machine'"'"'s address instead [%s]: ' "$default_domain"
    # A failed `read` (e.g. stdin closed mid-prompt) falls back to the
    # default rather than propagating under `set -e`.
    domain_input=""
    read -r domain_input || true
    if [ -n "$domain_input" ]; then
      DOMAIN="$domain_input"
    else
      DOMAIN="$default_domain"
    fi
  else
    # No terminal, no --domain, no PACO_DOMAIN: proceed with none rather
    # than block. A domain is optional by design — it can be set from
    # Settings, or via --domain/PACO_DOMAIN, at any later point.
    DOMAIN=""
  fi
fi

if [ -n "$DOMAIN" ]; then
  echo "install.sh: domain: $DOMAIN"
else
  echo "install.sh: domain: none - Paco will answer on any address that reaches this host (its IP, or a domain you point here later). Nothing else to do; the address is printed at the end."
fi
if [ "$DRY_RUN" -eq 1 ]; then
  echo "install.sh: --dry-run - the following would happen, but nothing below actually runs:"
  echo "  - install ca-certificates, gnupg, curl if missing"
  echo "  - add $APT_SOURCE (deb $APT_REPO_URL stable main), signed by $KEYRING_FILE"
  echo "  - install and start docker.io if no rootful Docker is present (a"
  echo "    rootless Docker is reported and left alone, never installed over)"
  echo "  - apt-get update && apt-get install -y paco"
  echo "    (which also brings PostgreSQL, nginx and the gh CLI, and puts the"
  echo "     paco user in the docker group so chats can run)"
  if [ -n "$DOMAIN" ]; then
    echo "  - set APP_URL=http://$DOMAIN in $PACO_ENV and restart the paco service"
  fi
  exit 0
fi

# --- 3. Prerequisites, the signing key, the APT source, the package. -------

missing_packages=""
for pkg in ca-certificates gnupg curl; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing_packages="$missing_packages $pkg"
done
if [ -n "$missing_packages" ]; then
  echo "install.sh: installing missing prerequisites:$missing_packages"
  apt-get update
  # shellcheck disable=SC2086 # word-splitting is exactly what's wanted here.
  DEBIAN_FRONTEND=noninteractive apt-get install -y $missing_packages
fi

mkdir -p "$KEYRING_DIR"
curl -fsSL "$GPG_KEY_URL" -o "$KEYRING_FILE" \
  || fail "could not download the signing key from $GPG_KEY_URL."
chmod 0644 "$KEYRING_FILE"

cat > "$APT_SOURCE" <<EOF
deb [signed-by=$KEYRING_FILE] $APT_REPO_URL stable main
EOF

# Migrate a host installed by v0.1.0's installer, which wrote product-named
# paths. This runs AFTER the new source file exists and BEFORE `apt-get update`,
# so there is never a moment with no source at all, and the update below never
# sees both.
#
# Not cosmetic tidying: the old and new files name the identical repository, so
# leaving both makes every `apt update` on that host warn that the target is
# configured multiple times. Removed only when it is the file this installer
# itself wrote — an operator's own source pointing somewhere else is not ours to
# delete, and `paco.list` is a plausible name for one.
if [ -f "$LEGACY_APT_SOURCE" ] \
  && grep -q "$APT_REPO_URL" "$LEGACY_APT_SOURCE" 2>/dev/null; then
  echo "install.sh: removing $LEGACY_APT_SOURCE, superseded by $APT_SOURCE"
  rm -f "$LEGACY_APT_SOURCE"
fi
# Safe to remove unconditionally once no source file references it: the key is
# re-downloadable, and nothing else on a host is called this.
if [ -f "$LEGACY_KEYRING_FILE" ] \
  && ! grep -rqs "$LEGACY_KEYRING_FILE" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
  rm -f "$LEGACY_KEYRING_FILE"
fi

apt-get update

# Docker, installed here rather than left to whoever ran this.
#
# Every chat runs inside a container. A host without Docker installs cleanly,
# serves its UI, and then fails the first chat — which is the least useful
# possible outcome of a one-command install, because everything looks fine
# until the moment someone tries to use it.
#
# It stays `Recommends` rather than `Depends` in the package: Paco is still
# worth installing on a host that will never run chats, and a hard dependency
# would drag a container runtime onto machines that do not want one. The
# installer's job is different from the package's — it is meant to produce a
# host that works — so it installs Docker explicitly.
#
# Explicitly, and BEFORE paco, for a second reason: apt gives no ordering
# guarantee for a recommended package, and paco's postinst can only add the
# service account to the `docker` group if that group already exists. Doing it
# here is what makes that branch reliable instead of a coin toss.
#
# A failure here warns rather than aborting. Stopping would leave the operator
# with nothing at all over something recoverable — a transient mirror problem,
# or a derivative whose runtime is packaged under another name. Paco itself
# still installs and runs; only chats are affected, and the closing message
# says so instead of claiming everything is ready.
# Which Docker, if any, is on this host — three states, not two, because they
# need three different answers:
#
#   absent    install docker.io, below.
#   rootful   nothing to do; this is the daemon Paco needs.
#   rootless  Docker is here and working, and Paco still cannot use it.
#
# The check this replaced was `command -v docker`, which is true for all three:
# a rootless install has a perfectly good docker(1) on PATH, so the installer
# skipped installing the rootful daemon, said "Docker is already installed",
# and the operator found out at the first chat.
#
# Rootless is not a supported configuration and cannot be made into one. Paco's
# sandbox bind-mounts the paco user's workspace into the container and runs the
# container process as that user's own uid, so the files it writes are readable
# from both sides. Rootless Docker maps container uids through a user
# namespace, so uid 106 inside lands on the host as uid 100106 (/etc/subuid),
# and the paco user cannot read its own workspace. There is no package to fix
# that with either: docker.io ships no rootless tooling at all — no
# dockerd-rootless-setuptool.sh, no rootlesskit — and docker-ce-rootless-extras
# is not in Ubuntu's repositories. So the job here is to detect it and say so
# precisely, not to work around it.
#
# `docker info --format '{{println .SecurityOptions}}'` printing `name=rootless`
# is the authoritative signal, but it only answers for a daemon docker(1) can
# actually reach — and this script runs as root, whose docker(1) talks to
# /var/run/docker.sock, which a rootless install never creates. Hence the two
# fallbacks below: DOCKER_HOST pointing under /run/user/, and the per-user
# runtime sockets themselves, which root can both see and connect to.
#
# Set by docker_is_rootless() to the endpoint the rootless daemon was found on,
# so the message can name it instead of asserting it in the abstract.
DOCKER_ROOTLESS_AT=""

# Ask a daemon whether it is rootless. $1 is a DOCKER_HOST to probe with, or ""
# to use whatever is already in the environment; the assignment is confined to
# a subshell so probing one socket cannot change where the next call looks.
# `timeout` is used when present because `docker info` against a wedged daemon
# can block, and this runs before anything is installed.
# shellcheck disable=SC2030 # confining the assignment to this subshell is the point.
docker_reports_rootless() {
  (
    if [ -n "${1:-}" ]; then
      DOCKER_HOST="$1"
      export DOCKER_HOST
    fi
    if command -v timeout >/dev/null 2>&1; then
      timeout 5 docker info --format '{{println .SecurityOptions}}' 2>/dev/null
    else
      docker info --format '{{println .SecurityOptions}}' 2>/dev/null
    fi
  ) | grep -q 'name=rootless'
}

# shellcheck disable=SC2031 # DOCKER_HOST is only ever set inside the subshell above, never here.
docker_is_rootless() {
  DOCKER_ROOTLESS_AT=""

  # (a) The daemon docker(1) is already pointed at, whatever that is.
  if command -v docker >/dev/null 2>&1 && docker_reports_rootless ""; then
    DOCKER_ROOTLESS_AT="${DOCKER_HOST:-unix:///var/run/docker.sock}"
    return 0
  fi

  # (b) DOCKER_HOST under /run/user/ — the per-user runtime directory, where
  # only a rootless daemon ever listens.
  case "${DOCKER_HOST:-}" in
    */run/user/*)
      DOCKER_ROOTLESS_AT="$DOCKER_HOST"
      return 0
      ;;
  esac

  # (c) Root with no DOCKER_HOST set, which is the normal case here and in the
  # postinst: look for the sockets directly. Confirm with `docker info` when
  # there is a docker(1) to confirm with; a socket at this path with nothing
  # answering is still rootless Docker (rootful never lives under /run/user/),
  # so it counts as evidence rather than being discarded.
  for _sock in /run/user/*/docker.sock; do
    [ -S "$_sock" ] || continue
    if command -v docker >/dev/null 2>&1 && docker_reports_rootless "unix://$_sock"; then
      DOCKER_ROOTLESS_AT="unix://$_sock"
      return 0
    fi
    [ -n "$DOCKER_ROOTLESS_AT" ] || DOCKER_ROOTLESS_AT="unix://$_sock"
  done
  [ -n "$DOCKER_ROOTLESS_AT" ]
}

DOCKER_READY=1
DOCKER_ROOTLESS=0
if docker_is_rootless; then
  # Deliberately does NOT install docker.io over the top. Adding a second,
  # root-owned daemon to a host someone chose to run rootless on is the
  # operator's call, not this script's — so it is explained and left to them.
  DOCKER_ROOTLESS=1
  DOCKER_READY=0
elif command -v docker >/dev/null 2>&1; then
  echo "install.sh: Docker is already installed, and it is the rootful daemon Paco needs."
else
  echo "install.sh: installing Docker, which every chat runs inside."
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io || DOCKER_READY=0
fi

# A runtime that is installed but not running fails exactly like one that is
# absent, and a fresh container install is not always started. `--now` covers
# both enable and start; the service is `docker.service` on Debian and Ubuntu,
# with the bare name kept as a fallback for derivatives that name it otherwise.
if [ "$DOCKER_READY" -eq 1 ]; then
  systemctl enable --now docker.service >/dev/null 2>&1 \
    || systemctl enable --now docker >/dev/null 2>&1 \
    || DOCKER_READY=0
fi

if [ "$DOCKER_ROOTLESS" -eq 1 ]; then
  echo "install.sh: WARNING - Docker is installed on this host, but it is running rootless," >&2
  echo "install.sh:           and Paco cannot use a rootless daemon. Chats will not run." >&2
  echo "install.sh:           Found at: $DOCKER_ROOTLESS_AT" >&2
  echo "install.sh:           Why: every chat runs in a container that bind-mounts the paco" >&2
  echo "install.sh:           user's workspace and runs as that user's own uid. Rootless" >&2
  echo "install.sh:           Docker maps container uids through a user namespace, so a" >&2
  echo "install.sh:           container writing as uid 106 produces files owned by uid 100106" >&2
  echo "install.sh:           on the host (see /etc/subuid), and paco cannot read its own" >&2
  echo "install.sh:           workspace. No setting changes that." >&2
  echo "install.sh:           Paco needs the rootful daemon, which is a separate installation" >&2
  echo "install.sh:           rather than a setting on the one you have. Nothing was installed" >&2
  echo "install.sh:           for it just now, because that is your call: it adds a root-owned" >&2
  echo "install.sh:           daemon on /var/run/docker.sock with its own images, containers" >&2
  echo "install.sh:           and volumes. Your rootless daemon keeps running alongside it," >&2
  echo "install.sh:           untouched, and keeps its own." >&2
  echo "install.sh:           If that is what you want, chats work after:" >&2
  echo "install.sh:             apt-get install -y docker.io" >&2
  echo "install.sh:             systemctl enable --now docker.service" >&2
  echo "install.sh:             usermod -aG docker paco && systemctl restart paco" >&2
  echo "install.sh:           Everything else is installed normally; only chats are affected." >&2
elif [ "$DOCKER_READY" -eq 0 ]; then
  echo "install.sh: WARNING - Docker is not available, so chats will not run." >&2
  echo "install.sh:           Everything else is installed normally. To fix it:" >&2
  echo "install.sh:             apt-get install -y docker.io" >&2
  echo "install.sh:             usermod -aG docker paco && systemctl restart paco" >&2
fi

DEBIAN_FRONTEND=noninteractive apt-get install -y paco

# --- 4. Wire the domain in, if one was given, and print what's next. -------

# postinst has already run by this point (it's what `apt-get install`
# triggers): /etc/paco/paco.env exists with a freshly generated APP_SECRET,
# and the paco service is already enabled and started. Setting APP_URL here
# - rather than in postinst, which must never touch this file once it
# exists - is what makes the domain given at install time actually take
# effect, instead of only ever being cosmetic. No certificate is issued by
# this installer, so the scheme is http; put TLS in front yourself (e.g.
# certbot against nginx) once DNS for the domain resolves here.
if [ -n "$DOMAIN" ] && [ -f "$PACO_ENV" ]; then
  tmp_env="$PACO_ENV.tmp.$$"
  awk -v v="http://$DOMAIN" '
    $0 ~ /^APP_URL=/ { print "APP_URL=" v; found = 1; next }
    { print }
    END { if (!found) print "APP_URL=" v }
  ' "$PACO_ENV" > "$tmp_env"
  chown --reference="$PACO_ENV" "$tmp_env" 2>/dev/null || true
  chmod --reference="$PACO_ENV" "$tmp_env" 2>/dev/null || chmod 640 "$tmp_env"
  mv "$tmp_env" "$PACO_ENV"
  systemctl restart paco.service
fi

echo
if [ -n "$DOMAIN" ]; then
  echo "Paco is installed: http://$DOMAIN/"
  echo "Point DNS for $DOMAIN at this host if you haven't already."
else
  # Print the address rather than a placeholder. "Visit http://<this host's
  # address>/" is not an instruction — it is a puzzle, and on a fresh VM the
  # person running this often does not know which of several addresses is the
  # reachable one.
  #
  # The route to a public resolver names the interface that carries traffic off
  # this box, which is the address a browser elsewhere will use. `hostname -I`
  # is the fallback and prints every address, first one first. Neither reaches
  # the network — `ip route get` only consults the routing table.
  host_addr=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
  [ -n "$host_addr" ] || host_addr=$(hostname -I 2>/dev/null | awk '{print $1}')

  if [ -n "$host_addr" ]; then
    echo "Paco is installed. Open it at:"
    echo
    echo "    http://$host_addr/"
    echo
    echo "Any address that reaches this host works — that one, a private IP, or"
    echo "a domain you point here. No domain is required, and nothing needs"
    echo "configuring first: set one later in Settings if you want it."
  else
    echo "Paco is installed. Open http://<this host's address>/ to finish setup."
  fi
fi
echo
if [ "$DOCKER_READY" -eq 1 ]; then
  echo "Everything is installed and running: the app, its database, nginx, and"
  echo "Docker for the sandboxes chats run in. One thing is left, and it cannot"
  echo "be automated because it needs your Claude account:"
elif [ "$DOCKER_ROOTLESS" -eq 1 ]; then
  echo "The app, its database and nginx are installed and running. The Docker on"
  echo "this host is rootless, which Paco cannot use, so chats will fail until a"
  echo "rootful daemon is installed (see the warning above for what that means"
  echo "and the three commands it takes). Once it is sorted, this still needs"
  echo "doing, because it needs your Claude account:"
else
  echo "The app, its database and nginx are installed and running. Docker is NOT,"
  echo "so chats will fail until you fix that (see the warning above). Once it is"
  echo "sorted, this still needs doing, because it needs your Claude account:"
fi
echo
echo "  sudo paco auth"
echo
echo "Then open the URL above and create your account. Also worth knowing:"
echo "  - A domain can be set (or changed) later from Settings."
echo "  - For TLS: if this host has its own public IP, run"
echo "    'sudo paco tls <domain>' once the domain resolves here. If your"
echo "    platform terminates TLS for you (Krova Cloud, Cloudflare's proxy,"
echo "    or any load balancer), skip it - HTTPS already works, and"
echo "    requesting a certificate here would fail and cause a redirect loop."
echo "  - 'paco status' / 'paco logs' / 'paco upgrade' / 'paco restart' operate"
echo "    the installed service. There is no 'paco uninstall': use"
echo "    'apt remove paco' (keeps data) or 'apt purge paco' (does not)."
