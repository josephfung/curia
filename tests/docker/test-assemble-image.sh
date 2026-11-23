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

# stub dir platforms: `inspect --raw` lists these linux architectures, plus an
# attestation manifest (platform unknown/unknown) as buildx writes one.
install_docker_stub() {
  mkdir -p "$1/bin"
  printf '%s\n' "$2" > "$1/platforms"
  cat > "$1/bin/docker" <<STUB
#!/usr/bin/env bash
dir="$1"
printf '%s\n' "\$*" >> "\$dir/calls"
case "\$*" in
  "buildx imagetools create "*)
    printf '%s\n' "\$@" > "\$dir/create_args"
    exit 0 ;;
  "buildx imagetools inspect --raw "*)
    python3 -c '
import json, sys
arches = open(sys.argv[1]).read().split()
manifests = [{"platform": {"os": "linux", "architecture": a}} for a in arches]
manifests.append({"platform": {"os": "unknown", "architecture": "unknown"}})
print(json.dumps({"manifests": manifests}))
' "\$dir/platforms"
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
    DIGESTS_DIR="$d/digests" GITHUB_OUTPUT="$d/github_output" BUILDX_RETRY_DELAY=0 \
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

# 4. The assembled index lacks a platform: fail, write no digest (nothing is signed).
d="$tmpdir/a4"; install_docker_stub "$d" "amd64"; digests "$d" "$AMD" "$ARM"
run "$d"
check_eq "index missing arm64: exits 1" "1" "$?"
if [ -s "$d/github_output" ]; then bad "  ...but a digest was written"; else ok "  ...and no digest was written"; fi

# 5. Required inputs.
d="$tmpdir/a5"; install_docker_stub "$d" "amd64 arm64"; digests "$d" "$AMD" "$ARM"
run "$d" TAGS=
if [ "$?" -ne 0 ]; then ok "empty TAGS fails"; else bad "empty TAGS passed"; fi
if [ ! -f "$d/calls" ]; then ok "  ...before docker runs"; else bad "  ...but docker ran"; fi

echo
echo "assemble-image: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
