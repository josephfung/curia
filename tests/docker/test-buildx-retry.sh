#!/usr/bin/env bash
# Tests for docker/buildx-retry.sh and docker/publish-image.sh (curia#1864).
#
# The publish leg died two seconds in, while BuildKit resolved the SBOM scanner
# from Docker Hub, before any Dockerfile instruction ran (run 35654813898):
#
#   #2 resolve image config for docker-image://docker.io/docker/buildkit-syft-scanner:stable-1
#   #2 ERROR: failed to authorize: failed to fetch oauth token:
#      Post "https://auth.docker.io/token": write tcp ...->172.64.144.78:443:
#      write: connection reset by peer
#
# Nothing inside the image can retry that. These tests force the failure with a
# stub command (and a stub `docker`) so the second attempt is observed, not
# assumed from a workflow setting. A lockfile-shaped failure must stop on the
# first attempt.
#
# Run: bash tests/docker/test-buildx-retry.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$REPO_ROOT/docker/buildx-retry.sh"
PUBLISH="$REPO_ROOT/docker/publish-image.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

check_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# The incident, abbreviated only by the socket pair. Both phrases that matter
# are intact: the oauth-token fetch (which a 401 shares) and the reset (which
# it does not).
INCIDENT_LOG='#2 resolve image config for docker-image://docker.io/docker/buildkit-syft-scanner:stable-1
#2 ERROR: failed to authorize: failed to fetch oauth token: Post "https://auth.docker.io/token": write tcp 10.1.0.225:48216->172.64.144.78:443: write: connection reset by peer'

LOCKFILE_LOG='#12 4.321 ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date
#12 ERROR: process "/bin/sh -c pnpm-retry pnpm install --frozen-lockfile" did not complete successfully: exit code: 1'

AUTH_LOG='#2 ERROR: failed to authorize: failed to fetch oauth token: unexpected status: 401 Unauthorized'

echo "docker/buildx-retry.sh"

[ -f "$WRAPPER" ] || { echo "  FAIL wrapper not found at $WRAPPER"; exit 1; }
[ -x "$WRAPPER" ] || bad "wrapper is not executable"

# 1. Success is one attempt.
d="$tmpdir/t1"; mkdir -p "$d"
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
count_file="$(dirname "$0")/count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
exit 0
STUB
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "succeeds first try, runs once" "1" "$(cat "$d/count")"

# 2. The scanner-resolve reset is retried, and the second attempt is visible.
d="$tmpdir/t2"; mkdir -p "$d"
cat > "$d/cmd" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
if [ "\$n" -eq 1 ]; then
  printf '%s\n' '$INCIDENT_LOG' >&2
  exit 1
fi
echo "stub: success on attempt \$n"
exit 0
STUB
chmod +x "$d/cmd"
out=$(BUILDX_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" 2>&1)
rc=$?
check_eq "scanner reset is retried and then succeeds" "0" "$rc"
check_eq "  ...second attempt actually ran" "2" "$(cat "$d/count")"
case "$out" in
  *"retrying in 0s"*) ok "  ...and the log shows the retry, not a silent second run" ;;
  *) bad "  ...but the retry was not announced ($(printf '%s' "$out" | tr '\n' ' '))" ;;
esac
case "$out" in
  *"connection reset by peer"*) ok "  ...classified from the reset, not from oauth-token wording" ;;
  *) bad "  ...but did not name the connection-reset signature" ;;
esac
case "$out" in
  *"stub: success on attempt 2"*) ok "  ...and the successful attempt's output is kept" ;;
  *) bad "  ...but the successful attempt produced no output" ;;
esac

# 3. An outdated lockfile fails once. Burning the rest of the budget here is
#    the failure mode the issue forbids.
d="$tmpdir/t3"; mkdir -p "$d"
cat > "$d/cmd" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
printf '%s\n' '$LOCKFILE_LOG' >&2
exit 17
STUB
chmod +x "$d/cmd"
out=$(BUILDX_RETRY_DELAY=0 BUILDX_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" 2>&1)
check_eq "lockfile failure preserves the build exit code" "17" "$?"
check_eq "  ...and does not take a second attempt" "1" "$(cat "$d/count")"
case "$out" in
  *"not retrying"*) ok "  ...and says it is not retrying" ;;
  *) bad "  ...but did not refuse the retry" ;;
esac

# 4. A sustained transient failure spends the budget, then preserves the exit.
d="$tmpdir/t4"; mkdir -p "$d"
cat > "$d/cmd" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
echo "dial tcp 172.64.144.78:443: connection refused" >&2
exit 23
STUB
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 BUILDX_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "exhausted transient budget preserves the exit code" "23" "$?"
check_eq "  ...after exactly 3 attempts" "3" "$(cat "$d/count")"

# 5. A transient first attempt followed by a lockfile stops. The remaining
#    budget is not spent turning one deterministic failure into three builds.
d="$tmpdir/t5"; mkdir -p "$d"
cat > "$d/cmd" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
if [ "\$n" -eq 1 ]; then
  echo "write: connection reset by peer" >&2
  exit 1
fi
printf '%s\n' '$LOCKFILE_LOG' >&2
exit 19
STUB
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 BUILDX_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "lockfile after a reset stops on that attempt" "19" "$?"
check_eq "  ...without a third attempt" "2" "$(cat "$d/count")"

# 6. A 401 shares the oauth-token phrase with the incident and must not retry.
d="$tmpdir/t6"; mkdir -p "$d"
cat > "$d/cmd" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
printf '%s\n' '$AUTH_LOG' >&2
exit 1
STUB
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 BUILDX_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "permanent 401 is not retried" "1" "$(cat "$d/count")"

# 7. Rate limit and an apt mirror timeout are the other two transients the step
#    retry is supposed to cover. Each must take a second attempt. The apt line
#    still starts with "E: Failed to fetch" — that prefix is NOT the signature
#    (a 404 uses it too). "Connection timed out" is.
for label_pat in \
  "toomanyrequests: You have reached your pull rate limit" \
  "E: Failed to fetch http://deb.debian.org/debian/pool/main/ Connection timed out"
do
  d="$tmpdir/t7-$pass"; mkdir -p "$d"
  cat > "$d/cmd" <<STUB
#!/usr/bin/env bash
count_file="\$(dirname "\$0")/count"
n=\$(( \$(cat "\$count_file" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$count_file"
if [ "\$n" -eq 1 ]; then echo "$label_pat" >&2; exit 1; fi
exit 0
STUB
  chmod +x "$d/cmd"
  BUILDX_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
  check_eq "retries: $label_pat" "0" "$?"
  check_eq "  ...on a second attempt" "2" "$(cat "$d/count")"
done

# 7b. An apt 404 uses the same "E: Failed to fetch" prefix and must not retry.
d="$tmpdir/t7b"; mkdir -p "$d"
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
count_file="$(dirname "$0")/count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
echo 'E: Failed to fetch http://deb.debian.org/debian/pool/main/foo.deb  404  Not Found [IP: 151.101.1.132 80]' >&2
exit 100
STUB
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 BUILDX_RETRY_ATTEMPTS=3 "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "apt HTTP 404 fails on the first attempt" "100" "$?"
check_eq "  ...and is not retried" "1" "$(cat "$d/count")"

# 8. Arguments stay separate words, including ones with spaces.
d="$tmpdir/t8"; mkdir -p "$d"
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$(dirname "$0")/args"
STUB
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 "$WRAPPER" "$d/cmd" build --tag "ghcr.io/example/curia:edge" --label "org.opencontainers.image.title=Curia App" >/dev/null 2>&1
expected=$(printf '%s\n' build --tag "ghcr.io/example/curia:edge" --label "org.opencontainers.image.title=Curia App")
check_eq "passes arguments through as distinct words" "$expected" "$(cat "$d/args")"

# 9. Misuse and bad knobs fail before the command runs.
BUILDX_RETRY_DELAY=0 "$WRAPPER" >/dev/null 2>&1
check_eq "no command given exits 2" "2" "$?"

d="$tmpdir/t9"; mkdir -p "$d"
printf '#!/bin/sh\necho ran > "%s/count"\n' "$d" > "$d/cmd"
chmod +x "$d/cmd"
BUILDX_RETRY_DELAY=0 BUILDX_RETRY_ATTEMPTS=abc "$WRAPPER" "$d/cmd" >/dev/null 2>&1
check_eq "rejects a non-numeric BUILDX_RETRY_ATTEMPTS" "2" "$?"
if [ ! -f "$d/count" ]; then ok "  ...before running the command at all"; else bad "  ...ran the command anyway"; fi

# 10. A zero-prefixed delay is decimal. `sleep` is shadowed so the value the
#     wrapper computed is observable.
d="$tmpdir/t10"; mkdir -p "$d/bin"
printf '#!/bin/sh\nexit 42\n' > "$d/cmd"; chmod +x "$d/cmd"
printf '#!/bin/sh\necho "SLEPT:$1" >&2\n' > "$d/bin/sleep"; chmod +x "$d/bin/sleep"
# The command must look transient or the wrapper never sleeps.
cat > "$d/cmd" <<'STUB'
#!/usr/bin/env bash
echo "connection reset by peer" >&2
exit 42
STUB
chmod +x "$d/cmd"
out=$(PATH="$d/bin:$PATH" BUILDX_RETRY_DELAY=010 BUILDX_RETRY_ATTEMPTS=2 "$WRAPPER" "$d/cmd" 2>&1)
check_eq "zero-prefixed delay 010 preserves the wrapped exit code" "42" "$?"
case "$out" in
  *"SLEPT:10"*) ok "  ...and waits 10s (decimal), not 8s (octal)" ;;
  *) bad "  ...but waited the octal value ($(printf '%s' "$out" | tr '\n' ' '))" ;;
esac

echo
echo "docker/publish-image.sh"

[ -f "$PUBLISH" ] || { echo "  FAIL publish script not found at $PUBLISH"; exit 1; }
[ -x "$PUBLISH" ] || bad "publish script is not executable"

DIGEST="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# A docker stub on PATH. The first `fail_times` invocations print `fail_log`
# and exit 1. A later invocation writes the metadata digest and records every
# argv element, one per line. The log is a file, not an interpolated string:
# the incident text contains quotes.
install_docker_stub() { # dir fail_times fail_log
  mkdir -p "$1/bin"
  printf '%s\n' "$2" > "$1/fail_times"
  printf '%s\n' "$3" > "$1/fail_log"
  cat > "$1/bin/docker" <<STUB
#!/usr/bin/env bash
dir="$1"
n=\$(( \$(cat "\$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$dir/count"
printf '%s\n' "\$@" >> "\$dir/args"
meta=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "--metadata-file" ]; then meta="\$a"; fi
  prev="\$a"
done
if [ "\$n" -le "\$(cat "\$dir/fail_times")" ]; then
  cat "\$dir/fail_log" >&2
  exit 1
fi
if [ -n "\$meta" ]; then
  if [ -f "\$dir/success_meta" ]; then
    cp "\$dir/success_meta" "\$meta"
  else
    printf '%s\n' '{"containerimage.digest":"$DIGEST"}' > "\$meta"
  fi
fi
exit 0
STUB
  chmod +x "$1/bin/docker"
}

has_line() { # file needle
  grep -F -x -q -e "$2" "$1"
}

# 11. A clean build passes sbom + provenance + per-image cache and records the digest.
d="$tmpdir/p1"; install_docker_stub "$d" 0 ""
out_file="$d/github_output"
PATH="$d/bin:$PATH" \
  TAGS=$'ghcr.io/example/curia:edge\nghcr.io/example/curia:sha' \
  LABELS=$'org.opencontainers.image.revision=abc\norg.opencontainers.image.title=Curia App' \
  DOCKERFILE=Dockerfile \
  CACHE_SCOPE=curia \
  BUILDER_ID='https://github.com/example/curia/actions/runs/1/attempts/1' \
  GITHUB_OUTPUT="$out_file" \
  BUILDX_RETRY_DELAY=0 \
  "$PUBLISH" >/dev/null 2>&1
check_eq "clean build exits 0" "0" "$?"
check_eq "  ...one docker invocation" "1" "$(cat "$d/count")"
check_eq "  ...writes the digest output" "digest=$DIGEST" "$(cat "$out_file")"
for needle in \
  "--attest" \
  "type=sbom" \
  "type=provenance,mode=max,builder-id=https://github.com/example/curia/actions/runs/1/attempts/1" \
  "--push" \
  "--platform" \
  "linux/amd64,linux/arm64" \
  "--file" \
  "Dockerfile" \
  "--tag" \
  "ghcr.io/example/curia:edge" \
  "ghcr.io/example/curia:sha" \
  "--label" \
  "org.opencontainers.image.title=Curia App" \
  "--cache-from" \
  "type=gha,scope=curia" \
  "--cache-to" \
  "type=gha,mode=max,scope=curia,ignore-error=true" \
  "."
do
  if has_line "$d/args" "$needle"; then ok "  argv has $needle"; else bad "  argv missing $needle"; fi
done

# 12. The postgres leg is the same script with a different dockerfile and scope.
#     Both images get an SBOM attestation because both go through this argv.
d="$tmpdir/p2"; install_docker_stub "$d" 0 ""
out_file="$d/github_output"
PATH="$d/bin:$PATH" \
  TAGS='ghcr.io/example/curia-postgres:edge' \
  DOCKERFILE=docker/postgres.Dockerfile \
  CACHE_SCOPE=curia-postgres \
  GITHUB_OUTPUT="$out_file" \
  BUILDX_RETRY_DELAY=0 \
  "$PUBLISH" >/dev/null 2>&1
check_eq "postgres leg exits 0" "0" "$?"
if has_line "$d/args" "type=sbom" && has_line "$d/args" "docker/postgres.Dockerfile" && has_line "$d/args" "type=gha,scope=curia-postgres"; then
  ok "postgres leg keeps sbom and its own cache scope"
else
  bad "postgres leg argv drifted ($(tr '\n' ' ' < "$d/args"))"
fi
if has_line "$d/args" "type=provenance,mode=max"; then
  ok "provenance mode=max without a builder-id when unset"
else
  bad "provenance attest missing"
fi

# 13. Forced scanner failure, then success: the second attempt's digest is what
#     would be signed. This is the scratch run the issue asks to see.
d="$tmpdir/p3"; install_docker_stub "$d" 1 "$INCIDENT_LOG"
out_file="$d/github_output"
out=$(PATH="$d/bin:$PATH" \
  TAGS='ghcr.io/example/curia:edge' \
  DOCKERFILE=Dockerfile \
  CACHE_SCOPE=curia \
  GITHUB_OUTPUT="$out_file" \
  BUILDX_RETRY_DELAY=0 \
  "$PUBLISH" 2>&1)
check_eq "forced scanner failure still publishes" "0" "$?"
check_eq "  ...docker ran twice" "2" "$(cat "$d/count")"
check_eq "  ...digest comes from the successful attempt" "digest=$DIGEST" "$(cat "$out_file")"
case "$out" in
  *"retrying in 0s"*) ok "  ...retry announced on the publish path" ;;
  *) bad "  ...retry was not announced on the publish path" ;;
esac

# 14. A lockfile failure on the publish path does not retry and writes no digest,
#     even with budget left. The stub would fail nine times if asked.
d="$tmpdir/p4"; install_docker_stub "$d" 9 "$LOCKFILE_LOG"
out_file="$d/github_output"
PATH="$d/bin:$PATH" \
  TAGS='ghcr.io/example/curia:edge' \
  DOCKERFILE=Dockerfile \
  CACHE_SCOPE=curia \
  GITHUB_OUTPUT="$out_file" \
  BUILDX_RETRY_DELAY=0 \
  BUILDX_RETRY_ATTEMPTS=3 \
  "$PUBLISH" >/dev/null 2>&1
check_eq "publish path lockfile fails on the first attempt" "1" "$?"
check_eq "  ...docker ran once" "1" "$(cat "$d/count")"
if [ -s "$out_file" ]; then bad "  ...but a digest was written"; else ok "  ...and no digest was written"; fi

# 15. A successful build that forgets the digest must not hand cosign an empty one.
d="$tmpdir/p5"; install_docker_stub "$d" 0 ""
printf '%s\n' '{}' > "$d/success_meta"
out_file="$d/github_output"
PATH="$d/bin:$PATH" \
  TAGS='ghcr.io/example/curia:edge' \
  DOCKERFILE=Dockerfile \
  CACHE_SCOPE=curia \
  GITHUB_OUTPUT="$out_file" \
  BUILDX_RETRY_DELAY=0 \
  "$PUBLISH" >/dev/null 2>&1
check_eq "missing digest fails the publish" "1" "$?"
if [ -s "$out_file" ]; then bad "  ...but a digest was written"; else ok "  ...and no digest was written"; fi

# 16. Required inputs are rejected before docker runs.
d="$tmpdir/p6"; install_docker_stub "$d" 0 ""
out_file="$d/github_output"
PATH="$d/bin:$PATH" GITHUB_OUTPUT="$out_file" BUILDX_RETRY_DELAY=0 "$PUBLISH" >/dev/null 2>&1
check_eq "missing TAGS exits 2" "2" "$?"
if [ ! -f "$d/count" ]; then ok "  ...before docker runs"; else bad "  ...but docker ran"; fi

echo
echo "buildx-retry: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
