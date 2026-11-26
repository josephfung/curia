#!/usr/bin/env bash
# Join per-platform images, pushed untagged by publish-image.sh (PUSH_BY_DIGEST),
# into one multi-arch image under its tags, and write the new index's digest for
# the cosign step.
#
# docker-publish builds each platform on a runner of that architecture (the arm64
# leg used to run under QEMU on amd64, most of the publish's 14 minutes). Each leg
# leaves its digest in DIGESTS_DIR as a file named after its architecture. This is
# the only step that writes a tag, so a tag never points at an image that is
# missing a platform: a leg that failed or was skipped leaves no file, and this
# refuses to publish rather than tag a single-arch image.
#
# `imagetools create` copies each leg's index (image plus its SBOM and provenance
# attestation manifests) into the new index, so the attestations carry over.
#
# Runs on the GitHub-hosted runner. Do not COPY this into an image.
#
# Env:
#   IMAGE         registry/owner/name, no tag (required)
#   TAGS          newline-separated full image refs to publish (required)
#   DIGESTS_DIR   directory holding one file per architecture, e.g. amd64,
#                 each containing that leg's sha256:... digest (required)
#   ARCHES        space-separated architectures that must all be present
#                 (default "amd64 arm64")
#   GITHUB_OUTPUT digest is appended here for the cosign step (required)
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
: "${TAGS:?TAGS is required}"
: "${DIGESTS_DIR:?DIGESTS_DIR is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
ARCHES="${ARCHES:-amd64 arm64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIGEST_RE='^sha256:[0-9a-f]{64}$'

# The linux architectures an index (read with `imagetools inspect --raw`) holds that
# are missing from the space-separated list in $1. Attestation manifests are
# platform unknown/unknown and are ignored.
missing_platforms() {
  python3 -c '
import json, sys
arches = sys.argv[1].split()
index = json.load(sys.stdin)
present = {
    m.get("platform", {}).get("architecture")
    for m in index.get("manifests", [])
    if m.get("platform", {}).get("os") == "linux"
}
sys.stdout.write(" ".join(a for a in arches if a not in present))
' "$1"
}

# A read of the registry, tried three times: after the tags have moved, a blip
# here would otherwise leave them on an unsigned index with a misleading alert.
read_registry() {
  local attempt out
  for attempt in 1 2 3; do
    if out="$("$@")"; then
      printf '%s' "$out"
      return 0
    fi
    [ "$attempt" -eq 3 ] || sleep "${ASSEMBLE_READ_DELAY:-5}"
  done
  return 1
}

sources=()
for arch in $ARCHES; do
  file="$DIGESTS_DIR/$arch"
  if [ ! -f "$file" ]; then
    echo "assemble-image: no ${arch} digest in ${DIGESTS_DIR}: its build leg failed or was skipped. Refusing to tag an image without it." >&2
    exit 1
  fi
  digest="$(tr -d '[:space:]' < "$file")"
  if ! printf '%s\n' "$digest" | grep -Eq "$DIGEST_RE"; then
    echo "assemble-image: ${arch} digest is not a sha256 digest (got '${digest}')" >&2
    exit 1
  fi
  # Before any tag moves: the leg's own index (immutable, by digest) must hold its
  # platform. A leg that pushed the wrong architecture fails here, not after tagging.
  if ! raw="$(read_registry docker buildx imagetools inspect --raw "${IMAGE}@${digest}")"; then
    echo "assemble-image: could not read the ${arch} leg ${IMAGE}@${digest}; nothing was tagged" >&2
    exit 1
  fi
  missing="$(printf '%s' "$raw" | missing_platforms "$arch")"
  if [ -n "$missing" ]; then
    echo "assemble-image: the ${arch} leg ${IMAGE}@${digest} holds no linux/${arch} image; nothing was tagged" >&2
    exit 1
  fi
  sources+=("${IMAGE}@${digest}")
done

args=(docker buildx imagetools create)
first_tag=""
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  [ -n "$first_tag" ] || first_tag="$tag"
  args+=(--tag "$tag")
done <<< "$TAGS"
if [ -z "$first_tag" ]; then
  echo "assemble-image: TAGS contained no tag" >&2
  exit 2
fi
args+=("${sources[@]}")

# Same retry rule as the build: only a classified registry/network failure. One
# create writes every tag, so a failure partway may leave some of them moved.
if ! "$SCRIPT_DIR/buildx-retry.sh" "${args[@]}"; then
  echo "assemble-image: the tag push failed; some tags may already point to the new index, which is NOT signed" >&2
  exit 1
fi

# Read back what the tags now name, once, and derive everything from that one read.
# The digest cosign signs is the sha256 of the index's exact bytes, confirmed by
# reading the index back BY that digest (immutable, unlike a tag), and the platform
# check runs on the same bytes. A second read of a mutable tag could return another
# run's index (a release and a re-publish of one tag run in separate concurrency
# groups) and sign something that was never checked. Bytes go through files, not
# $(...), which would drop a trailing newline and change the hash.
# From here on the tags have moved, so a failure says so: the alert must not read
# as "nothing was published".
moved="the tags were already moved to the new index, which is NOT signed"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
read_raw_to() { # file ref: inspect --raw into a file, tried three times
  local attempt
  for attempt in 1 2 3; do
    if docker buildx imagetools inspect --raw "$2" > "$1"; then
      return 0
    fi
    [ "$attempt" -eq 3 ] || sleep "${ASSEMBLE_READ_DELAY:-5}"
  done
  return 1
}
if ! read_raw_to "$work/index.json" "$first_tag"; then
  echo "assemble-image: could not read back ${first_tag}; ${moved}" >&2
  exit 1
fi
# The bytes as served; and without a trailing newline, in case the client added one.
candidates="$(python3 -c '
import hashlib, sys
raw = open(sys.argv[1], "rb").read()
seen = []
for body in (raw, raw.rstrip(b"\n")):
    d = "sha256:" + hashlib.sha256(body).hexdigest()
    if d not in seen:
        seen.append(d)
print(" ".join(seen))
' "$work/index.json")"
digest=""
for candidate in $candidates; do
  if read_raw_to "$work/by-digest.json" "${IMAGE}@${candidate}" \
      && python3 -c '
import json, sys
same = json.load(open(sys.argv[1])) == json.load(open(sys.argv[2]))
sys.exit(0 if same else 1)
' "$work/index.json" "$work/by-digest.json"; then
    digest="$candidate"
    break
  fi
done
if ! printf '%s\n' "$digest" | grep -Eq "$DIGEST_RE"; then
  echo "assemble-image: could not confirm the digest of ${first_tag}'s index by reading it back by digest; ${moved}" >&2
  exit 1
fi
missing="$(missing_platforms "$ARCHES" < "$work/index.json")"
if [ -n "$missing" ]; then
  echo "assemble-image: ${first_tag} is missing platform(s): ${missing}; ${moved}" >&2
  exit 1
fi

printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
echo "assemble-image: ${first_tag} -> ${digest} (${ARCHES})"
