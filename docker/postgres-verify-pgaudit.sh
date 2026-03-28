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

# Wait for Postgres to be ready (up to 30s)
for i in $(seq 1 30); do
  if pg_isready -U "${POSTGRES_USER:-curia}" -q 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! pg_isready -U "${POSTGRES_USER:-curia}" -q 2>/dev/null; then
  echo "ERROR: Postgres did not become ready in 30s" >&2
  exit 1
fi

# Verify pgAudit setup. If anything is missing, create it (idempotent).
# This handles the existing-volume case where initdb.d scripts were skipped.
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
