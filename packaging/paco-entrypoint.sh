#!/bin/sh
# Installed as /usr/lib/paco/paco-entrypoint.sh — deliberately NOT
# /usr/bin/paco, which is the operator CLI (scripts/paco: upgrade, logs,
# restart, status, auth, tls). This script is what paco.service's ExecStart
# runs directly, by that path (see packaging/paco.service).
#
# Applies pending database migrations, then execs the server in place, so
# systemd tracks and signals the actual Node process rather than this
# script. Migrations run here — at service start, every start — rather than
# from postinst: postinst runs once per install/upgrade, and a migration
# failure there would either be silently skipped (the old, worse behaviour)
# or abort an `apt upgrade` partway through. A failure here instead surfaces
# as a failed `systemctl start paco`, which `Restart=always` retries and
# `journalctl -u paco` explains.
set -e

PACO_HOME=/usr/lib/paco
NODE="$PACO_HOME/node/bin/node"
WEB="$PACO_HOME/apps/web"

if [ ! -x "$NODE" ]; then
  echo "paco: bundled Node not found or not executable at $NODE" >&2
  exit 1
fi

export NODE_ENV=production

echo "paco: applying migrations"
"$NODE" "$WEB/lib/db/migrate.ts"
"$NODE" "$WEB/scripts/workflow-bootstrap.ts"

# The public origin has to be known before the server starts: better-auth
# builds its set of trusted callback hosts once, at module load. An operator
# who saves a domain in Settings writes it to the database and restarts, and
# this is what turns that row back into configuration — without it, saving a
# domain does nothing and the restart the UI asks for accomplishes nothing.
#
# Runs after the migrations, because on a fresh install the table it reads
# does not exist until they have. An explicitly-set APP_URL always wins, so
# an operator who prefers to manage it as environment can, and this never
# overrides them.
if [ -z "$APP_URL" ]; then
  if APP_URL_FROM_DB="$(
    psql "$POSTGRES_URL" -tAc \
      "SELECT app_domain FROM instance_settings WHERE app_domain IS NOT NULL LIMIT 1" \
      2>/dev/null
  )"; then
    APP_URL_FROM_DB="$(printf '%s' "$APP_URL_FROM_DB" | tr -d '[:space:]')"
    # A value that reached the column by hand could still be unusable, and
    # lib/app-url.ts throws on one — which would render a config-problem page
    # on every route including the settings page needed to correct it.
    case "$APP_URL_FROM_DB" in
      http://* | https://*)
        export APP_URL="$APP_URL_FROM_DB"
        echo "paco: serving on $APP_URL (from Settings)"
        ;;
      "") : ;;
      *)
        echo "paco: ignoring the saved domain '$APP_URL_FROM_DB' — it needs a http:// or https:// scheme" >&2
        ;;
    esac
  else
    echo "paco: could not read the saved domain; serving on the default" >&2
  fi
fi

echo "paco: starting server"
exec "$NODE" "$WEB/server.js"
