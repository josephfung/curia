#!/usr/bin/env bash
# Regression test for curia#1350.
#
# The curia-postgres image must initialize a FRESH data volume cleanly: create
# the `curia` database, load pgAudit, and stay up. The prior bug lived in the
# verify-pgaudit.sh entrypoint: it backgrounded the stock Postgres entrypoint and
# polled `pg_isready`/`psql` over the local socket. On first init the stock
# entrypoint runs a *temporary, socket-only* server to create the DB and run
# initdb scripts, then stops it and starts the real server. The wrapper's socket
# probes latched onto (and interfered with) that temp server — hanging its
# shutdown so the real server never started, or racing `CREATE DATABASE curia`
# — leaving the container dead and the `curia` DB never created. Existing
# (already-initialized) volumes were unaffected, which is why it shipped.
#
# The failure is a timing race, so this test runs the fresh-init path several
# times: the fix (probe the real server over TCP, never the socket-only temp
# server) is deterministic, while the buggy wrapper fails a fraction of the time.
# Looping makes a regression reliably visible.
#
# Requires Docker. Run: bash tests/docker/test-postgres-init.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="curia-postgres-test:ci-$$"
# Number of fresh-init attempts. Each is deterministic under the fix; a reverted
# fix loses the race in at least one attempt with high probability.
FRESH_ITERS="${FRESH_ITERS:-5}"
# The exact pgAudit command the compose files pass. Must match them: the heavier
# audit settings (log_relation/log_parameter) shape init timing, and reproducing
# the bug depends on using the real command, not a reduced one.
PGAUDIT_CMD=(postgres
  -c shared_preload_libraries=pgaudit
  -c pgaudit.log=write,ddl
  -c pgaudit.log_parameter=on
  -c pgaudit.log_relation=on
  -c pgaudit.role=pgaudit_role)

# Track resources for cleanup.
CONTAINERS=()
VOLUMES=()

pass() { echo "  PASS: $*"; }
fail() {
  local container="$1"; shift
  echo "  FAIL: $*" >&2
  echo "  --- last 30 log lines ($container) ---" >&2
  docker logs "$container" 2>&1 | tail -30 >&2 || true
  exit 1
}

cleanup() {
  local c v
  for c in "${CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done
  for v in "${VOLUMES[@]:-}"; do [ -n "$v" ] && docker volume rm "$v" >/dev/null 2>&1 || true; done
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

status_of() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo missing; }
verified_count() { docker logs "$1" 2>&1 | grep -c 'pgAudit verification passed' || true; }

# wait_for_verified <container> <want_count> <timeout>: poll until the wrapper has
# reported "pgAudit verification passed" at least <want_count> times (once per
# boot). Fails fast if the container exits or crash-loops (the #1350 signature).
# The wrapper only reaches that line after the REAL server is up and the pgAudit
# verification query succeeds, so it is the authoritative "healthy boot" signal.
wait_for_verified() {
  local container="$1" want="$2" timeout="$3" i status
  for ((i = 1; i <= timeout; i++)); do
    status="$(status_of "$container")"
    if [[ "$status" == "exited" || "$status" == "restarting" ]]; then
      fail "$container" "container entered '$status' during init (curia#1350 regression)"
    fi
    if [ "$(verified_count "$container")" -ge "$want" ]; then return 0; fi
    sleep 1
  done
  fail "$container" "wrapper did not report 'pgAudit verification passed' x$want within ${timeout}s (curia#1350)"
}

# assert_pgaudit <container>: curia reachable, pgAudit loaded, audit role present.
assert_pgaudit() {
  local container="$1"
  if ! docker exec "$container" psql -U curia -d curia -tAc 'select 1' >/dev/null 2>&1; then
    fail "$container" "curia database not reachable"
  fi
  if ! docker exec "$container" psql -U curia -d curia -tAc "select current_setting('pgaudit.log', true)" | grep -q .; then
    fail "$container" "pgAudit not loaded (pgaudit.log GUC absent)"
  fi
  if ! docker exec "$container" psql -U curia -d curia -tAc "select 1 from pg_roles where rolname='pgaudit_role'" | grep -q 1; then
    fail "$container" "pgaudit_role missing"
  fi
}

echo "==> Building curia-postgres image (context: repo root)..."
docker build -f "$REPO_ROOT/docker/postgres.Dockerfile" -t "$IMAGE" "$REPO_ROOT" >/dev/null

echo "==> [fresh volume] booting $FRESH_ITERS times (init is a timing race in the buggy build)..."
for ((n = 1; n <= FRESH_ITERS; n++)); do
  container="curia-pg-inittest-$$-$n"
  volume="curia-pg-inittest-vol-$$-$n"
  CONTAINERS+=("$container"); VOLUMES+=("$volume")
  docker run -d --name "$container" -v "$volume:/var/lib/postgresql/data" \
    -e POSTGRES_DB=curia -e POSTGRES_USER=curia -e POSTGRES_PASSWORD=inittest \
    "$IMAGE" "${PGAUDIT_CMD[@]}" >/dev/null
  wait_for_verified "$container" 1 60
  assert_pgaudit "$container"
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  pass "fresh init #$n: curia created, pgAudit loaded, verification passed"
done

echo "==> [existing volume] restart must re-run verification and stay healthy..."
container="curia-pg-existing-$$"
volume="curia-pg-existing-vol-$$"
CONTAINERS+=("$container"); VOLUMES+=("$volume")
docker run -d --name "$container" -v "$volume:/var/lib/postgresql/data" \
  -e POSTGRES_DB=curia -e POSTGRES_USER=curia -e POSTGRES_PASSWORD=inittest \
  "$IMAGE" "${PGAUDIT_CMD[@]}" >/dev/null
wait_for_verified "$container" 1 60
assert_pgaudit "$container"
docker restart "$container" >/dev/null            # boot onto the now-initialized volume (init skipped)
wait_for_verified "$container" 2 45               # verification must run again after restart
assert_pgaudit "$container"
pass "existing volume: healthy after restart, pgAudit re-verified"

echo "ALL POSTGRES IMAGE TESTS PASSED"
