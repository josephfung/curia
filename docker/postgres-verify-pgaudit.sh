#!/bin/bash
# Verify pgAudit is correctly set up on every Postgres startup — not just first init.
# docker-entrypoint-initdb.d/ scripts only run on a fresh data directory, so existing
# volumes silently skip pgAudit setup. This script catches that.
#
# Runs as a wrapper around the standard Postgres Docker entrypoint.
set -e

# Start Postgres via the standard entrypoint (in the background for the check)
docker-entrypoint.sh "$@" &
PG_PID=$!

# This script is PID 1 in the container, so docker stop sends SIGTERM here,
# not to Postgres. Forward termination signals to ensure clean DB shutdown.
trap 'kill -TERM "$PG_PID"' TERM INT
trap 'kill -QUIT "$PG_PID"' QUIT

# Wait for the REAL server over TCP — never the temporary init server (curia#1350).
#
# On a fresh volume the standard entrypoint first runs a *temporary* server that
# is socket-only (listen_addresses='') to run initdb, CREATE DATABASE, and the
# initdb.d scripts, then stops it and starts the real server. Probing that temp
# server over the local socket (as this script used to) is broken two ways: it
# races CREATE DATABASE (connecting to a DB that does not exist yet), and its
# connections interfere with the temp server's shutdown so the real server never
# starts — leaving the container dead mid-init with `curia` never created.
#
# The real server listens on TCP; the socket-only temp server does not. So a TCP
# probe (-h 127.0.0.1) only succeeds once the real server is up — by which point
# initdb has finished and "$POSTGRES_DB" exists — and never touches the temp
# server. pg_isready only pings (no auth), so no password is needed here.
PGHOST=127.0.0.1
for i in $(seq 1 60); do
  if pg_isready -h "$PGHOST" -U "${POSTGRES_USER:-curia}" -q 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! pg_isready -h "$PGHOST" -U "${POSTGRES_USER:-curia}" -q 2>/dev/null; then
  echo "ERROR: Postgres did not become ready in 60s" >&2
  exit 1
fi

# Verify pgAudit setup. If anything is missing, create it (idempotent).
# This handles the existing-volume case where initdb.d scripts were skipped.
# Connect over the local socket (trust auth) — the real server is up on both the
# socket and TCP by now, and the socket path needs no password.
psql -U "${POSTGRES_USER:-curia}" -d "${POSTGRES_DB:-curia}" -v ON_ERROR_STOP=1 <<'SQL'
  -- Ensure extension exists (safe to run repeatedly)
  CREATE EXTENSION IF NOT EXISTS pgaudit;

  -- Ensure audit role exists
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgaudit_role') THEN
      CREATE ROLE pgaudit_role NOLOGIN;
      RAISE NOTICE 'pgaudit_role created (was missing — likely an existing volume)';
    END IF;
  END
  $$;

  -- Verify pgAudit is actually loaded (shared_preload_libraries included it)
  DO $$
  BEGIN
    IF current_setting('pgaudit.log', true) IS NULL THEN
      RAISE EXCEPTION 'AUDIT SAFETY CHECK FAILED: pgAudit is not loaded. '
        'Ensure shared_preload_libraries includes pgaudit in the compose command args.';
    END IF;
  END
  $$;
SQL

echo "pgAudit verification passed"

# Bring Postgres back to foreground
wait $PG_PID
