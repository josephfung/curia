#!/usr/bin/env sh
# Retry a pnpm command that failed for transient network reasons (curia#1699).
#
# Why this exists, and why pnpm's own fetchRetries is not sufficient on its own:
#
# The docker-publish build died mid-`pnpm install` on the emulated linux/arm64 leg
# (run 33556099876) when the npm registry dropped a TLS connection:
#
#   TypeError: terminated
#     at Fetch.onAborted (node:internal/deps/undici/undici:13842:53)
#     [cause]: SocketError: other side closed   code: 'UND_ERR_SOCKET'
#   Emitted 'error' event on Readable instance at:
#   node:events:505   throw er; // Unhandled 'error' event
#
# That is an UNHANDLED stream error, not a request pnpm classified as retryable.
# pnpm retries what it catches (e.g. ERR_SOCKET_TIMEOUT, which it logs as
# "Will retry in 10 seconds"), but here Node aborted the process before pnpm could
# act. Raising fetchRetries would not have saved this build. The only thing that
# survives a hard process abort is re-running the command, which is what this does.
#
# The two layers are complementary, not redundant:
#   - pnpm-workspace.yaml fetch* settings  -> retry individual requests pnpm catches
#   - this wrapper                         -> retry the whole command when it dies
#
# Retrying `pnpm install` is safe: the store is content-addressable and installs are
# idempotent, so a partially-completed attempt is resumed rather than corrupted.
#
# `pnpm add` is NOT idempotent in the same way — it mutates package.json and the
# lockfile. An attempt aborted mid-mutation (exactly the incident shape: the process
# dies, so no cleanup runs) can leave a half-written tree, and the retry may then fail
# with a *derived* error such as ERR_PNPM_INCLUDED_DEPS_CONFLICT rather than the
# original network fault. Retrying is still better than failing outright, but that is
# why the give-up message below reports the FIRST attempt's exit code as well as the
# last: when they differ, the retry itself changed the failure mode and the first one
# is the real cause.
#
# This wrapper does NOT classify failures — every non-zero exit is retried, including
# deterministic ones like ERR_PNPM_OUTDATED_LOCKFILE. Distinguishing them reliably
# would mean parsing pnpm's output, which is its own fragility. Instead the messages
# stay honest about what is and is not known: nothing here claims a failure was
# transient. If every attempt fails identically, it almost certainly was not.
#
# POSIX sh (not bash): this runs in `node:24-slim` Docker layers via /bin/sh.
#
# Usage:  docker/pnpm-retry.sh pnpm install --frozen-lockfile
# Env:    PNPM_RETRY_ATTEMPTS (default 3)   total attempts, not extra retries
#         PNPM_RETRY_DELAY    (default 10)  base seconds; backs off linearly
# Both are overridable mainly so the tests can run fast and deterministically; Docker
# RUN layers inherit no host environment, so image builds always use the defaults.
set -eu

attempts="${PNPM_RETRY_ATTEMPTS:-3}"
base_delay="${PNPM_RETRY_DELAY:-10}"

if [ "$#" -eq 0 ]; then
  echo "pnpm-retry: no command given" >&2
  exit 2
fi

# Validate the knobs up front. Without this a non-numeric value makes the `-ge`
# comparison below fail under `set -e`, so the script exits 2 and the wrapped
# command's real exit code is silently replaced.
case "$attempts" in
  ''|*[!0-9]*) echo "pnpm-retry: PNPM_RETRY_ATTEMPTS must be a positive integer (got '$attempts')" >&2; exit 2 ;;
esac
[ "$attempts" -ge 1 ] || { echo "pnpm-retry: PNPM_RETRY_ATTEMPTS must be >= 1 (got '$attempts')" >&2; exit 2; }
case "$base_delay" in
  ''|*[!0-9]*) echo "pnpm-retry: PNPM_RETRY_DELAY must be a non-negative integer (got '$base_delay')" >&2; exit 2 ;;
esac

attempt=1
first_status=""
while :; do
  # `set -e` must not abort on a failed attempt — that is the case being handled,
  # so `|| status=$?` both suppresses the abort and captures the real exit code.
  #
  # Do NOT restructure this as `if "$@"; then exit 0; fi` followed by `status=$?`:
  # POSIX says an `if` with no branch taken returns 0, so the status read after `fi`
  # is the *if statement's* 0, not the command's failure. That silently turns a
  # persistent failure into a successful build. Covered by test 3 in
  # tests/docker/test-pnpm-retry.sh.
  status=0
  "$@" || status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  [ -n "$first_status" ] || first_status="$status"

  if [ "$attempt" -ge "$attempts" ]; then
    # Give up loudly and preserve the wrapped command's exit status, so a genuine
    # (non-transient) failure still fails the build rather than being masked.
    echo "pnpm-retry: '$*' failed after ${attempts} attempt(s); giving up (exit ${status})" >&2
    if [ "$first_status" = "$status" ]; then
      # Same failure every time — a registry blip does not reproduce this reliably.
      # Say so, so nobody burns time looking for a network fault that isn't there.
      echo "pnpm-retry: every attempt failed identically (exit ${status}); this is very likely a real, deterministic failure (e.g. an outdated lockfile), NOT a transient network fault — read the pnpm error above rather than re-running." >&2
    else
      # The retry changed the failure mode: attempt 1 is the cause, the rest are derived.
      echo "pnpm-retry: first attempt exited ${first_status} but the last exited ${status} — the retry changed the failure mode, so the FIRST error above is the real cause." >&2
    fi
    exit "$status"
  fi

  delay=$((base_delay * attempt))
  echo "pnpm-retry: '$*' failed (attempt ${attempt}/${attempts}, exit ${status}); retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
