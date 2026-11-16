#!/usr/bin/env bash
# Egress check for the bundled embedding model (#2023).
#
# The image carries the all-MiniLM-L6-v2 weights (fetched and verified at BUILD time) and
# runs them in-process with onnxruntime-node. The promise is that entity memory then works
# with no network at all: nothing is downloaded at boot or on first use. This proves it.
#
#   1. `docker network create --internal`: containers on it reach each other but have no
#      route out. A probe container first confirms that, so the test cannot pass on a
#      network that quietly allows egress.
#   2. The published curia-postgres image runs on that network, and the image's own
#      node-pg-migrate applies the migrations in-container, as install.sh does.
#   3. The image runs scripts/bundled-embedder-smoke.ts on the same network with
#      DATABASE_URL and nothing else: no embedding variables, no .env, no secrets. It
#      resolves the embedding source as boot does, stores a fact through EntityMemory and
#      reads it back. Any outbound call would fail, so exit 0 plus a printed source of
#      `bundled` means the bundled path made none.
#
# Requires Docker. Usage:
#   bash tests/docker/test-bundled-embedder-egress.sh [image]
# With no image argument it builds one from the repo (and removes it afterwards).
# CURIA_POSTGRES_TAG picks the curia-postgres tag (default pg16, as docker-compose.yml).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${1:-}"
BUILT_IMAGE=""
PG_IMAGE="ghcr.io/josephfung/curia-postgres:${CURIA_POSTGRES_TAG:-pg16}"
# Unique per run so an aborted earlier run, or a parallel one, never collides.
NET="curia-egress-test-$$"
PG="curia-egress-pg-$$"
# Throwaway credentials for a database that lives only on the internal network.
PG_PASSWORD="egress_test_$$"
DATABASE_URL="postgres://curia:${PG_PASSWORD}@${PG}:5432/curia"
# The exact pgAudit command docker-compose.yml passes, so the image starts as it does there.
PGAUDIT_CMD=(postgres
  -c shared_preload_libraries=pgaudit
  -c pgaudit.log=write,ddl
  -c pgaudit.log_parameter=on
  -c pgaudit.log_relation=on
  -c pgaudit.role=pgaudit_role)

pass() { echo "  PASS: $*"; }
fail() {
  echo "  FAIL: $*" >&2
  echo "  --- last 30 log lines ($PG) ---" >&2
  docker logs "$PG" 2>&1 | tail -30 >&2 || true
  exit 1
}

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ -n "$BUILT_IMAGE" ]; then docker rmi "$BUILT_IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
  BUILT_IMAGE="curia-egress-test:ci-$$"
  IMAGE="$BUILT_IMAGE"
  echo "==> Building $IMAGE from $REPO_ROOT"
  docker build -t "$IMAGE" "$REPO_ROOT"
fi

# Pull before any container runs: pulls go through the daemon, not the internal network,
# but doing it up front keeps a registry hiccup from reading as an egress failure.
echo "==> Pulling $PG_IMAGE"
docker pull --quiet "$PG_IMAGE" >/dev/null

echo "==> Creating internal network $NET (no route out)"
docker network create --internal "$NET" >/dev/null

# Positive control: the premise of the whole test is that this network has no egress.
# Probe with the image under test (Node's fetch, 10s cap): reaching the internet fails it.
# Only the probe's own fetch-failed code (3) counts as blocked. Any other non-zero status
# (the container failed to start, node missing, an OOM kill) proves nothing about egress.
echo "==> Confirming the network blocks egress"
set +e
docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e \
  "fetch('https://huggingface.co', { signal: AbortSignal.timeout(10000) }).then(() => process.exit(0), () => process.exit(3))"
probe_status=$?
set -e
case "$probe_status" in
  3) ;;
  0) fail "a container on $NET reached https://huggingface.co; the network is not egress-blocked, so this test would prove nothing" ;;
  *) fail "the egress probe exited $probe_status, not 3 (fetch failed), so it says nothing about the network" ;;
esac
pass "outbound HTTPS from $NET fails"

echo "==> Starting $PG_IMAGE on $NET"
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_DB=curia -e POSTGRES_USER=curia -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  "$PG_IMAGE" "${PGAUDIT_CMD[@]}" >/dev/null

# Probe over TCP, never the local socket: on a fresh volume the stock entrypoint first runs
# a socket-only temporary server, which must not be mistaken for the real one (#1350).
ready=0
for _ in $(seq 1 60); do
  if docker exec "$PG" psql -h 127.0.0.1 -U curia -d curia -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail "Postgres did not accept TCP connections within 60s"
pass "Postgres is up on $NET"

echo "==> Applying migrations in-container"
if ! docker run --rm --network "$NET" -e DATABASE_URL="$DATABASE_URL" "$IMAGE" \
  ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
  --migrations-dir src/db/migrations --migration-file-language sql >/dev/null; then
  fail "migrations failed"
fi
pass "migrations applied"

# DATABASE_URL is the only variable passed: no EMBEDDING_* settings, so resolution must
# land on the bundled model. stdout's last line is the script's JSON result; logs go to stderr.
echo "==> Running the bundled-embedder smoke on $NET"
set +e
out="$(docker run --rm --network "$NET" -e DATABASE_URL="$DATABASE_URL" -e LOG_LEVEL=warn "$IMAGE" \
  ./node_modules/.bin/tsx scripts/bundled-embedder-smoke.ts)"
status=$?
set -e
echo "  smoke output: $out"
[ "$status" = 0 ] || fail "smoke exited $status"
result="$(printf '%s\n' "$out" | tail -1)"
case "$result" in
  *'"source":"bundled"'*) ;;
  *) fail "smoke did not report source bundled: $result" ;;
esac
pass "entity memory stored and found a fact on the bundled model with no egress"

echo "All bundled-embedder egress checks passed."
