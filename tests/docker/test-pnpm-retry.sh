#!/usr/bin/env bash
# Tests for docker/pnpm-retry.sh (curia#1699).
#
# Why this wrapper exists: the docker-publish build died on a transient npm
# registry socket drop during the emulated arm64 `pnpm install` (run 33556099876).
# The failure shape matters — it was NOT a timeout that pnpm caught and retried:
#
#   TypeError: terminated
#     [cause]: SocketError: other side closed   UND_ERR_SOCKET
#   Emitted 'error' event on Readable instance
#   node:events:505  throw er; // Unhandled 'error' event
#
# Node aborted the process. pnpm's own fetchRetries never engaged, because the
# stream error was unhandled rather than surfaced as a retryable request failure.
# So config alone cannot fix it; the command has to be retried from outside.
#
# These tests use a stub command rather than a real pnpm so they are fast, offline,
# and deterministic. Run: bash tests/docker/test-pnpm-retry.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$REPO_ROOT/docker/pnpm-retry.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

check_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# A stub that fails the first N invocations then succeeds, counting attempts in a file.
make_stub() { # path fail_times
  cat > "$1" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
if [ "\$n" -le $2 ]; then echo "stub: simulated failure \$n" >&2; exit 1; fi
echo "stub: success on attempt \$n"
exit 0
STUB
  chmod +x "$1"
  rm -f "$(dirname "$1")/count"
}

echo "docker/pnpm-retry.sh"

[ -f "$WRAPPER" ] || { echo "  FAIL wrapper not found at $WRAPPER"; exit 1; }
[ -x "$WRAPPER" ] || bad "wrapper is not executable"

# 1. A command that succeeds first time runs exactly once (no wasted retries).
d="$tmpdir/t1"; mkdir -p "$d"; make_stub "$d/cmd" 0
PNPM_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "succeeds first try, runs once" "1" "$(cat "$d/count")"

# 2. A command that fails twice then succeeds is retried and ultimately succeeds.
#    This is the exact incident shape: transient failure, then a clean run.
d="$tmpdir/t2"; mkdir -p "$d"; make_stub "$d/cmd" 2
PNPM_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
rc=$?
check_eq "retries a transient failure, then succeeds" "0" "$rc"
check_eq "  ...after exactly 3 attempts" "3" "$(cat "$d/count")"

# 3. A persistently failing command eventually gives up and fails the build.
#    A retry wrapper that masked a real failure would be worse than none.
#    The stub exits 78 so this also pins the documented promise to "preserve the
#    wrapped command's exit status" — a regression to a hardcoded `exit 1` would
#    still be non-zero and would slip past a bare `-ne 0` assertion.
d="$tmpdir/t3"; mkdir -p "$d"
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
count_file="$(dirname "$0")/count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
exit 78
STUB
chmod +x "$d/cmd"; rm -f "$d/count"
PNPM_RETRY_DELAY=0 PNPM_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "gives up and preserves the wrapped exit code" "78" "$?"
check_eq "  ...having tried exactly the limit" "3" "$(cat "$d/count")"

# 4. Attempt count is configurable, so the Dockerfile can tune it per stage.
d="$tmpdir/t4"; mkdir -p "$d"; make_stub "$d/cmd" 99
PNPM_RETRY_DELAY=0 PNPM_RETRY_ATTEMPTS=2 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "honours PNPM_RETRY_ATTEMPTS" "2" "$(cat "$d/count")"

# 5. Arguments reach the wrapped command as SEPARATE words, preserving any that
#    contain spaces. Recording "$@" one-per-line (not "$*") is what makes this able
#    to fail: a wrapper that collapsed argv via `sh -c "$*"` would join everything
#    into one word and split "a b" into two, and a "$*" comparison could not tell.
d="$tmpdir/t5"; mkdir -p "$d"
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$(dirname "$0")/args"
STUB
chmod +x "$d/cmd"
PNPM_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" install --frozen-lockfile "spaced arg" >/dev/null 2>&1
expected=$(printf 'install\n--frozen-lockfile\nspaced arg')
check_eq "passes arguments through as distinct words" "$expected" "$(cat "$d/args")"

# 6. Misuse is rejected rather than silently treated as success.
PNPM_RETRY_DELAY=0 "$WRAPPER" >/dev/null 2>&1
check_eq "no command given exits 2" "2" "$?"

# 7. A non-numeric knob is rejected up front. Without the guard, the `-ge` comparison
#    fails under `set -e` and replaces the wrapped command's real exit code with 2.
d="$tmpdir/t7"; mkdir -p "$d"; make_stub "$d/cmd" 0
PNPM_RETRY_DELAY=0 PNPM_RETRY_ATTEMPTS=abc "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "rejects a non-numeric PNPM_RETRY_ATTEMPTS" "2" "$?"
if [ ! -f "$d/count" ]; then ok "  ...before running the command at all"; else bad "  ...ran the command anyway"; fi

# 8. When every attempt fails the same way, the operator is told it is NOT transient.
#    The whole risk of a retry wrapper is that it makes deterministic breakage (a stale
#    lockfile is the common one) read as flakiness.
d="$tmpdir/t8"; mkdir -p "$d"; make_stub "$d/cmd" 99
out=$(PNPM_RETRY_DELAY=0 PNPM_RETRY_ATTEMPTS=2 "$WRAPPER" "$d/cmd" 2>&1 || true)
case "$out" in
  *"failed identically"*) ok "warns that an identical repeat failure is not transient" ;;
  *) bad "no not-transient warning on identical repeat failures" ;;
esac

# 9. Re-run the load-bearing cases under the shells the Dockerfile ACTUALLY uses.
#    The wrapper's shebang is `#!/usr/bin/env sh`, and in node:24-slim /bin/sh is dash,
#    not bash. Testing only under bash hid a real bug: `[ 1 -ge abc ]` returns 2 in dash,
#    which an `if` reads as false, so a non-numeric attempts value looped forever instead
#    of giving up — an unbounded hang burning the CI job limit. These cases pin the
#    guard under each available shell rather than trusting bash to be representative.
for shell in sh dash bash; do
  command -v "$shell" >/dev/null 2>&1 || continue

  d="$tmpdir/shell-$shell"; mkdir -p "$d"
  printf '#!/bin/sh\nexit 42\n' > "$d/fail"; chmod +x "$d/fail"

  # Non-numeric attempts must exit 2 promptly, never spin.
  PNPM_RETRY_ATTEMPTS=abc PNPM_RETRY_DELAY=0 "$shell" "$WRAPPER" "$d/fail" >/dev/null 2>&1
  check_eq "[$shell] non-numeric attempts exits 2 (does not hang)" "2" "$?"

  # Zero/negative attempts would also skip the give-up branch.
  PNPM_RETRY_ATTEMPTS=0 PNPM_RETRY_DELAY=0 "$shell" "$WRAPPER" "$d/fail" >/dev/null 2>&1
  check_eq "[$shell] zero attempts exits 2" "2" "$?"

  # Exit-status preservation is the anti-masking property; verify per shell.
  PNPM_RETRY_ATTEMPTS=2 PNPM_RETRY_DELAY=0 "$shell" "$WRAPPER" "$d/fail" >/dev/null 2>&1
  check_eq "[$shell] preserves wrapped exit code on give-up" "42" "$?"

  PNPM_RETRY_DELAY=0 "$shell" "$WRAPPER" true >/dev/null 2>&1
  check_eq "[$shell] success exits 0" "0" "$?"
done

echo
echo "pnpm-retry: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
