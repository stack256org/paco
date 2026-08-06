#!/bin/sh
# install.sh — add Paco's APT repository and install the `paco` package.
#
# POSIX sh: this has to run on a host with nothing else guaranteed present,
# so no bashisms, no arrays, no `[[ ]]`. The one place this script reads from
# the terminal (the domain prompt, step 2 below) is guarded so a
# `curl ... | sudo sh` pipeline — which has no terminal at all — never blocks
# on a `read` that can never be answered.
set -eu

APT_REPO_URL="https://apt.stack256.org"
APT_SOURCE=/etc/apt/sources.list.d/paco.list
KEYRING_DIR=/etc/apt/keyrings
KEYRING_FILE="$KEYRING_DIR/stack256-paco.gpg"
# Stack256org/apt does not exist yet (see .github/workflows/release.yml), so
# this exact path is an assumption about what it will publish, not something
# verified against a live server — confirm it once that repository is real.
GPG_KEY_URL="$APT_REPO_URL/paco-archive-keyring.gpg"

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

[ "$(id -u)" = "0" ] || fail "this must be run as root (try: sudo sh install.sh)."

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
  echo "install.sh: domain: none - will be reachable on this host's address"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  echo "install.sh: --dry-run - the following would happen, but nothing below actually runs:"
  echo "  - install ca-certificates, gnupg, curl if missing"
  echo "  - add $APT_SOURCE (deb $APT_REPO_URL stable main), signed by $KEYRING_FILE"
  echo "  - apt-get update && apt-get install -y paco"
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

apt-get update
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
  echo "Paco is installed. Visit http://<this host's address>/ to finish setup."
fi
echo
echo "Next steps:"
echo "  - Open the URL above and complete first-run registration."
echo "  - Run 'paco auth' (as root) to sign the paco user into Claude Code -"
echo "    do this before starting your first chat."
echo "  - A domain can be set (or changed) later from Settings."
echo "  - For TLS: if this host has its own public IP, run"
echo "    'sudo paco tls <domain>' once the domain resolves here. If your"
echo "    platform terminates TLS for you (Krova Cloud, Cloudflare's proxy,"
echo "    or any load balancer), skip it - HTTPS already works, and"
echo "    requesting a certificate here would fail and cause a redirect loop."
echo "  - 'paco status' / 'paco logs' / 'paco upgrade' / 'paco restart' operate"
echo "    the installed service. There is no 'paco uninstall': use"
echo "    'apt remove paco' (keeps data) or 'apt purge paco' (does not)."
