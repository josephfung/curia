#!/usr/bin/env bash
# Tests for docker/assemble-image.sh: joining docker-publish's per-platform digests
# under the image's tags.
#
# A stub `docker` on PATH records `buildx imagetools create` and answers
# `imagetools inspect` with an index whose platforms each case chooses, so the
# checks that stop a single-arch image from being tagged are exercised, not assumed.
#
# Run: bash tests/docker/test-assemble-image.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSEMBLE="$REPO_ROOT/docker/assemble-image.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
check_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
has_line() { grep -F -x -q -e "$2" "$1"; }

AMD="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ARM="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
INDEX="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

# stub dir platforms [amd64-leg-arch] [arm64-leg-arch] [raw-failures]:
# `inspect --raw <tag>` lists `platforms` (the assembled index); `inspect --raw
# <image>@<digest>` lists the arch that leg actually holds (default: its own).
# Every index also carries an attestation manifest (platform unknown/unknown), as
# buildx writes one. The first `raw-failures` raw reads fail, as a registry blip.
install_docker_stub() {
  mkdir -p "$1/bin"
  printf '%s\n' "$2" > "$1/platforms"
  printf '%s\n' "${3:-amd64}" > "$1/leg_$AMD"
  printf '%s\n' "${4:-arm64}" > "$1/leg_$ARM"
  printf '%s\n' "${5:-0}" > "$1/raw_failures"
  cat > "$1/bin/docker" <<STUB
#!/usr/bin/env bash
dir="$1"
printf '%s\n' "\$*" >> "\$dir/calls"
case "\$*" in
  "buildx imagetools create "*)
    if [ -f "\$dir/fail_create" ]; then echo "ERROR: failed to push: denied" >&2; exit 1; fi
    printf '%s\n' "\$@" > "\$dir/create_args"
    exit 0 ;;
  "buildx imagetools inspect --raw "*)
    n=\$(( \$(cat "\$dir/raw_count" 2>/dev/null || echo 0) + 1 ))
    echo "\$n" > "\$dir/raw_count"
    if [ "\$n" -le "\$(cat "\$dir/raw_failures")" ]; then echo "unexpected EOF" >&2; exit 1; fi
    ref="\$5"
    case "\$ref" in
      *@sha256:*) src="\$dir/leg_\${ref#*@}" ;;
      *) src="\$dir/platforms" ;;
    esac
    python3 -c '
import json, sys
arches = open(sys.argv[1]).read().split()
manifests = [{"platform": {"os": "linux", "architecture": a}} for a in arches]
manifests.append({"platform": {"os": "unknown", "architecture": "unknown"}})
print(json.dumps({"manifests": manifests}))
' "\$src"
    exit 0 ;;
  "buildx imagetools inspect "*"--format"*)
    printf '%s\n' '{"digest":"$INDEX"}'
    exit 0 ;;
esac
echo "unexpected docker call: \$*" >&2
exit 1
STUB
  chmod +x "$1/bin/docker"
}

digests() { # dir amd64-digest-or-empty arm64-digest-or-empty
  mkdir -p "$1/digests"
  [ -z "$2" ] || printf '%s\n' "$2" > "$1/digests/amd64"
  [ -z "$3" ] || printf '%s\n' "$3" > "$1/digests/arm64"
}

run() { # dir [extra env...]
  local d="$1"; shift
  env PATH="$d/bin:$PATH" IMAGE=ghcr.io/example/curia \
    TAGS=$'ghcr.io/example/curia:edge\nghcr.io/example/curia:v1.2.3' \
    DIGESTS_DIR="$d/digests" GITHUB_OUTPUT="$d/github_output" BUILDX_RETRY_DELAY=0 ASSEMBLE_READ_DELAY=0 \
    "$@" "$ASSEMBLE" >/dev/null 2>"$d/stderr"
}

echo "docker/assemble-image.sh"
[ -x "$ASSEMBLE" ] || bad "assemble script is not executable"

# 1. Both platforms in: one create with every tag and both digests, index digest written.
d="$tmpdir/a1"; install_docker_stub "$d" "amd64 arm64"; digests "$d" "$AMD" "$ARM"
run "$d"
check_eq "both platforms: exits 0" "0" "$?"
check_eq "  ...writes the index digest" "digest=$INDEX" "$(cat "$d/github_output")"
for needle in "--tag" "ghcr.io/example/curia:edge" "ghcr.io/example/curia:v1.2.3" \
  "ghcr.io/example/curia@$AMD" "ghcr.io/example/curia@$ARM"; do
  if has_line "$d/create_args" "$needle"; then ok "  create has $needle"; else bad "  create missing $needle"; fi
done

# 2. A missing leg: nothing is tagged.
d="$tmpdir/a2"; install_docker_stub "$d" "amd64 arm64"; digests "$d" "$AMD" ""
run "$d"
check_eq "missing arm64 digest: exits 1" "1" "$?"
if [ -f "$d/create_args" ]; then bad "  ...but it tagged"; else ok "  ...and nothing was tagged"; fi
if grep -q "arm64 digest" "$d/stderr"; then ok "  ...naming the missing platform"; else bad "  ...without naming it"; fi

# 3. A garbled digest file: nothing is tagged.
d="$tmpdir/a3"; install_docker_stub "$d" "amd64 arm64"; digests "$d" "$AMD" "sha256:nothex"
run "$d"
check_eq "garbled digest: exits 1" "1" "$?"
if [ -f "$d/create_args" ]; then bad "  ...but it tagged"; else ok "  ...and nothing was tagged"; fi

# 4. The assembled index lacks a platform: fail, write no digest (nothing is signed),
#    and say the tags already moved.
d="$tmpdir/a4"; install_docker_stub "$d" "amd64"; digests "$d" "$AMD" "$ARM"
run "$d"
check_eq "index missing arm64: exits 1" "1" "$?"
if [ -s "$d/github_output" ]; then bad "  ...but a digest was written"; else ok "  ...and no digest was written"; fi
if grep -q "already moved" "$d/stderr"; then ok "  ...saying the tags already moved"; else bad "  ...without saying the tags moved"; fi

# 4b. A leg that pushed the wrong architecture: caught before any tag moves.
d="$tmpdir/a4b"; install_docker_stub "$d" "amd64 arm64" amd64 amd64; digests "$d" "$AMD" "$ARM"
run "$d"
check_eq "arm64 leg holding amd64: exits 1" "1" "$?"
if [ -f "$d/create_args" ]; then bad "  ...but it tagged"; else ok "  ...and nothing was tagged"; fi

# 4c. A registry blip on a read is retried, and the publish still succeeds.
d="$tmpdir/a4c"; install_docker_stub "$d" "amd64 arm64" amd64 arm64 2; digests "$d" "$AMD" "$ARM"
run "$d"
check_eq "two failed reads, then success: exits 0" "0" "$?"
check_eq "  ...writes the index digest" "digest=$INDEX" "$(cat "$d/github_output")"

# 4d. The tag push itself fails (unclassified, so not retried): say tags may have moved.
d="$tmpdir/a4d"; install_docker_stub "$d" "amd64 arm64"; digests "$d" "$AMD" "$ARM"
printf '%s\n' 'create' > "$d/fail_create"
run "$d"
check_eq "failed tag push: exits 1" "1" "$?"
if grep -q "some tags may already point" "$d/stderr"; then ok "  ...saying tags may have moved"; else bad "  ...without saying tags may have moved"; fi
if [ -s "$d/github_output" ]; then bad "  ...but a digest was written"; else ok "  ...and no digest was written"; fi

# 5. Required inputs.
d="$tmpdir/a5"; install_docker_stub "$d" "amd64 arm64"; digests "$d" "$AMD" "$ARM"
run "$d" TAGS=
if [ "$?" -ne 0 ]; then ok "empty TAGS fails"; else bad "empty TAGS passed"; fi
if [ ! -f "$d/calls" ]; then ok "  ...before docker runs"; else bad "  ...but docker ran"; fi

echo
echo "assemble-image: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
