#!/bin/sh
# Installed as /usr/bin/claude by the .deb (packaging/build-deb.sh) — a
# thin, explicit-path wrapper around the Claude Code CLI bundled at build
# time into /usr/lib/paco/node. See GAP 1 in
# .superpowers/sdd/2026-08-05-native-installation/gaps-report.md for why
# this exists: the old Docker image ran `npm install -g
# @anthropic-ai/claude-code` at build time; a native install has to be just
# as self-contained, with no network or npm needed on the target host.
#
# Exists so `claude` is simply on PATH, rather than requiring
# /usr/lib/paco/node itself to be added to PATH (which would also expose
# the bundled npm/node/npx as `node`/`npm`/`npx`, shadowing — or
# conflicting with — whatever the host already has). Two callers rely on
# this:
#   - packages/claude-code/run.ts spawns "claude" resolved through PATH,
#     for every chat turn paco.service runs.
#   - scripts/paco's `auth` and `status` subcommands check for it via
#     `command -v claude` as the paco user.
set -eu

CLAUDE_BIN=/usr/lib/paco/node/bin/claude

if [ ! -x "$CLAUDE_BIN" ]; then
  echo "claude: bundled CLI not found or not executable at $CLAUDE_BIN — this indicates a broken paco install. Try: sudo apt-get install --reinstall paco" >&2
  exit 1
fi

exec "$CLAUDE_BIN" "$@"
