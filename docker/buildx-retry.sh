#!/usr/bin/env bash
# Retry a `docker buildx build` that failed for a transient registry/network
# reason (curia#1864).
#
# Why this is not pnpm-retry.sh:
#
# `sbom: true` makes BuildKit pull `docker/buildkit-syft-scanner:stable-1` from
# Docker Hub before any Dockerfile instruction runs. That resolve is outside the
# image, so the #1699 retries (pnpm fetch retries, pnpm-retry, apt Acquire::Retries)
# never see it. BuildKit does not retry it either. One TCP reset fails the leg:
#
#   #2 resolve image config for docker-image://docker.io/docker/buildkit-syft-scanner:stable-1
#   #2 ERROR: failed to authorize: failed to fetch oauth token:
#      Post "https://auth.docker.io/token": ... write: connection reset by peer
#
# The same step also pushes to GHCR and can still surface a Debian-mirror drop
# that apt's own retries did not absorb. One retry boundary covers all three.
#
# It does NOT retry every non-zero exit. pnpm exits 1 for an outdated lockfile
# and for a socket drop, so pnpm-retry cannot tell them apart and retries both.
# Here the build log can. A known transport/rate-limit signature is retried; anything
# else — lockfile, compiler, a missing COPY — fails on the first attempt, so a
# broken build does not spend the retry budget or blow the 60-minute job wall.
#
# A 401 from the token endpoint contains "failed to fetch oauth token" too, and
# is NOT retried: that string is not itself a signature. The incident is matched
# on "connection reset by peer".
#
# Runs on the GitHub-hosted runner (bash). Do not COPY this into an image.
#
# Usage:  docker/buildx-retry.sh docker buildx build ...
# Env:    BUILDX_RETRY_ATTEMPTS (default 3)  total attempts, not extra retries
#         BUILDX_RETRY_DELAY    (default 10) base seconds; backs off linearly
# Both exist so tests can run fast. The workflow uses the defaults.
set -euo pipefail

attempts="${BUILDX_RETRY_ATTEMPTS:-3}"
base_delay="${BUILDX_RETRY_DELAY:-10}"

if [ "$#" -eq 0 ]; then
  echo "buildx-retry: no command given" >&2
  exit 2
fi

# Same knob rules as pnpm-retry.sh: a non-numeric value must not fall into
# `set -e` arithmetic and replace the build's exit code, and a leading zero
# must not become octal (`08` aborts the shell, `010` silently means 8).
case "$attempts" in
  ''|*[!0-9]*) echo "buildx-retry: BUILDX_RETRY_ATTEMPTS must be a positive integer (got '$attempts')" >&2; exit 2 ;;
esac
[ "$attempts" -ge 1 ] || { echo "buildx-retry: BUILDX_RETRY_ATTEMPTS must be >= 1 (got '$attempts')" >&2; exit 2; }
case "$base_delay" in
  ''|*[!0-9]*) echo "buildx-retry: BUILDX_RETRY_DELAY must be a non-negative integer (got '$base_delay')" >&2; exit 2 ;;
esac
while :; do
  case "$base_delay" in
    0[0-9]*) base_delay="${base_delay#0}" ;;
    *) break ;;
  esac
done

# Fixed strings, not a regex, so a metacharacter in a future message cannot
# widen the match. Order is the order a match is reported; put the incident's
# own phrase first. A signature is sufficient on its own — do not add
# "failed to fetch oauth token" or "failed to authorize", both of which a
# permanent 401 uses too.
TRANSIENT_PATTERNS=(
  'connection reset by peer'
  'connection refused'
  'i/o timeout'
  'TLS handshake timeout'
  'Client.Timeout'
  'net/http: request canceled'
  'temporary failure in name resolution'
  'Temporary failure resolving'
  'toomanyrequests'
  'pull rate limit'
  '429 Too Many Requests'
  'unexpected HTTP status: 429'
  'unexpected HTTP status: 500'
  'unexpected HTTP status: 502'
  'unexpected HTTP status: 503'
  'unexpected HTTP status: 504'
  'use of closed network connection'
  'http2: client connection lost'
  'http2: server sent GOAWAY'
  'unexpected EOF'
  ': EOF'
  'E: Failed to fetch'
  'Could not resolve host'
  'Connection timed out'
  'network is unreachable'
  'no route to host'
  'dial tcp'
  'UND_ERR_SOCKET'
  'ECONNRESET'
  'ETIMEDOUT'
  'EAI_AGAIN'
  'socket hang up'
)

# Print the first matching signature, or nothing. Exit 0 either way — the
# caller treats empty stdout as "not transient".
match_transient() {
  local pat
  for pat in "${TRANSIENT_PATTERNS[@]}"; do
    if grep -F -q -e "$pat" "$1"; then
      printf '%s\n' "$pat"
      return 0
    fi
  done
  return 0
}

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  # `set -e` must not abort on a failed attempt. tee keeps the log streaming
  # into the step (a 15-minute build that only prints at the end is undebuggable)
  # and leaves a complete copy for classification. PIPESTATUS[0] is the build,
  # not tee. pipefail stays off so a tee failure cannot mask a successful build.
  set +e
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  signature="$(match_transient "$log")"

  if [ -z "$signature" ]; then
    echo "buildx-retry: attempt ${attempt} failed (exit ${status}) without a known transient registry/network signature; not retrying" >&2
    exit "$status"
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "buildx-retry: giving up after ${attempts} attempt(s) (exit ${status}); last transient signature: ${signature}" >&2
    exit "$status"
  fi

  delay=$((base_delay * attempt))
  echo "buildx-retry: attempt ${attempt}/${attempts} failed (exit ${status}) with a transient registry/network error (${signature}); retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
