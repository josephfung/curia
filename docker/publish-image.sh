#!/usr/bin/env bash
# Build and push one docker-publish matrix image (curia#1864).
#
# Replaces `docker/build-push-action` for this step. The action cannot be
# retried selectively: a `uses:` step does not expose its log to the next step,
# and an unconditional retry would rebuild an outdated lockfile until the job
# timeout. `buildx-retry.sh` reads the build log and retries only transient
# registry/network failures (the Docker Hub SBOM-scanner pull, a GHCR push
# reset, a Debian mirror drop apt did not absorb).
#
# Attestations match what that action emits for this workflow's inputs:
#   provenance: mode=max  ->  --attest type=provenance,mode=max[,builder-id=...]
#   sbom: true             ->  --attest type=sbom
# `type=sbom` still resolves docker/buildkit-syft-scanner:stable-1 from Docker
# Hub at the start of the build. That pull is the failure this retry exists for;
# the attestation itself stays on.
#
# Layer cache is GitHub Actions cache, scoped per image so the curia and
# curia-postgres legs cannot overwrite each other. `mode=max` keeps intermediate
# layers, which is what makes a retried push cheap. `ignore-error=true` means a
# cache-service blip cannot fail a build that already pushed.
#
# Runs on the GitHub-hosted runner. Do not COPY this into an image.
#
# Env:
#   TAGS         newline-separated image tags (required)
#   LABELS       newline-separated key=value labels (optional)
#   DOCKERFILE   path relative to the build context (required)
#   CACHE_SCOPE  GHA cache scope, [A-Za-z0-9_.-]+ (required; one per image)
#   BUILDER_ID   provenance builder-id (optional; the workflow passes the run URL)
#   PLATFORMS    default linux/amd64,linux/arm64
#   CONTEXT      default .
#   GITHUB_OUTPUT  digest is appended here for the cosign step (required)
set -euo pipefail

if [ -z "${TAGS:-}" ]; then
  echo "publish-image: TAGS is required" >&2
  exit 2
fi
if [ -z "${DOCKERFILE:-}" ]; then
  echo "publish-image: DOCKERFILE is required" >&2
  exit 2
fi
if [ -z "${CACHE_SCOPE:-}" ]; then
  echo "publish-image: CACHE_SCOPE is required" >&2
  exit 2
fi
if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "publish-image: GITHUB_OUTPUT is required" >&2
  exit 2
fi
case "$CACHE_SCOPE" in
  *[!A-Za-z0-9_.-]*)
    echo "publish-image: CACHE_SCOPE must be [A-Za-z0-9_.-]+ (got '$CACHE_SCOPE')" >&2
    exit 2
    ;;
esac

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
CONTEXT="${CONTEXT:-.}"
LABELS="${LABELS:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
metadata="$(mktemp)"
trap 'rm -f "$metadata"' EXIT

args=(
  docker buildx build
  --file "$DOCKERFILE"
  --platform "$PLATFORMS"
  --push
  --metadata-file "$metadata"
  --cache-from "type=gha,scope=${CACHE_SCOPE}"
  --cache-to "type=gha,mode=max,scope=${CACHE_SCOPE},ignore-error=true"
  --attest "type=sbom"
)
if [ -n "${BUILDER_ID:-}" ]; then
  args+=(--attest "type=provenance,mode=max,builder-id=${BUILDER_ID}")
else
  args+=(--attest "type=provenance,mode=max")
fi

# `<<<` supplies the trailing newline a last tag would otherwise lack, so every
# non-empty line becomes exactly one argv element. Tags and labels are not
# word-split: a label value may contain spaces.
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  args+=(--tag "$tag")
done <<< "$TAGS"

while IFS= read -r label; do
  [ -n "$label" ] || continue
  args+=(--label "$label")
done <<< "$LABELS"

tag_count=0
for arg in "${args[@]}"; do
  [ "$arg" = "--tag" ] && tag_count=$((tag_count + 1))
done
if [ "$tag_count" -eq 0 ]; then
  echo "publish-image: TAGS contained no tag" >&2
  exit 2
fi

args+=("$CONTEXT")

"$SCRIPT_DIR/buildx-retry.sh" "${args[@]}"

# buildx writes containerimage.digest as the manifest-list digest when pushing
# multiple platforms. That is the digest cosign must sign.
digest="$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    meta = json.load(fh)
value = meta.get("containerimage.digest")
sys.stdout.write(value if isinstance(value, str) else "")
' "$metadata")"

if ! printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "publish-image: build succeeded but metadata has no sha256 digest (got '${digest}')" >&2
  exit 1
fi
printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
