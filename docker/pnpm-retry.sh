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
# Retrying a pnpm install is safe: the store is content-addressable and installs are
# idempotent, so a partially-completed attempt is resumed rather than corrupted.
#
# POSIX sh (not bash): this runs in `node:24-slim` Docker layers via /bin/sh.
#
# Usage:  docker/pnpm-retry.sh pnpm install --frozen-lockfile
# Env:    PNPM_RETRY_ATTEMPTS (default 3)   total attempts, not extra retries
#         PNPM_RETRY_DELAY    (default 10)  base seconds; backs off linearly
set -eu

attempts="${PNPM_RETRY_ATTEMPTS:-3}"
base_delay="${PNPM_RETRY_DELAY:-10}"

if [ "$#" -eq 0 ]; then
  echo "pnpm-retry: no command given" >&2
  exit 2
fi

attempt=1
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

  if [ "$attempt" -ge "$attempts" ]; then
    # Give up loudly and preserve the wrapped command's exit status, so a genuine
    # (non-transient) failure still fails the build rather than being masked.
    echo "pnpm-retry: '$*' failed after ${attempts} attempt(s); giving up (exit ${status})" >&2
    exit "$status"
  fi

  delay=$((base_delay * attempt))
  echo "pnpm-retry: '$*' failed (attempt ${attempt}/${attempts}, exit ${status}); retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
