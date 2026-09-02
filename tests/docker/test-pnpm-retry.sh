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
d="$tmpdir/t3"; mkdir -p "$d"; make_stub "$d/cmd" 99
PNPM_RETRY_DELAY=0 PNPM_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then ok "gives up after the attempt limit (non-zero exit)"; else bad "masked a persistent failure"; fi
check_eq "  ...having tried exactly the limit" "3" "$(cat "$d/count")"

# 4. Attempt count is configurable, so the Dockerfile can tune it per stage.
d="$tmpdir/t4"; mkdir -p "$d"; make_stub "$d/cmd" 99
PNPM_RETRY_DELAY=0 PNPM_RETRY_ATTEMPTS=2 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "honours PNPM_RETRY_ATTEMPTS" "2" "$(cat "$d/count")"

# 5. Arguments reach the wrapped command intact — the real call sites pass
#    flags like --frozen-lockfile --prod that must not be swallowed.
d="$tmpdir/t5"; mkdir -p "$d"
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$(dirname "$0")/args"
STUB
chmod +x "$d/cmd"
PNPM_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" install --frozen-lockfile --prod >/dev/null 2>&1
check_eq "passes arguments through unchanged" "install --frozen-lockfile --prod" "$(cat "$d/args")"

echo
echo "pnpm-retry: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
