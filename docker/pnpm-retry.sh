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
# transient, and nothing here claims one was not.
#
# In particular, do NOT read meaning into repeated *equal* exit statuses. pnpm exits 1
# for very nearly everything, and so does Node on an uncaught exception — the incident
# above (unhandled 'error' on a Readable) and an outdated lockfile both exit 1. A
# sustained registry outage therefore produces three identical exit 1s, which is the
# flagship case for retrying, not evidence against it. Equal statuses carry no signal;
# only *differing* ones do, and only in the narrow sense noted above.
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
# Strip leading zeros before the value ever reaches `$(( ))`. POSIX arithmetic follows
# C integer-constant rules, so a leading zero means OCTAL: `010` would silently become 8,
# and `08` is not a valid octal constant at all — it aborts the shell under `set -e`,
# replacing the wrapped command's exit code with the shell's. That is the same
# silent-substitution hazard the validation above exists to prevent, so normalize rather
# than reject: a leading zero is a sloppy spelling of a decimal, not a request for octal.
# `test -ge` (used for $attempts) parses decimal and needs no such treatment.
while :; do
  case "$base_delay" in
    0[0-9]*) base_delay="${base_delay#0}" ;;
    *) break ;;
  esac
done

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
      # Equal statuses are NOT evidence of a deterministic failure: pnpm and Node both
      # exit 1 for nearly everything, so a sustained outage looks exactly like a bad
      # lockfile here. Report the observation and refuse to guess at the cause.
      echo "pnpm-retry: every attempt exited ${status}; the wrapper cannot tell transient from deterministic (pnpm exits 1 for nearly everything) — read the pnpm error above." >&2
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
