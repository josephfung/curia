# Build stage: compile TypeScript and install dependencies
#
# Base image pinned by digest for a reproducible supply chain (clears the OpenSSF
# Scorecard Pinned-Dependencies Docker finding). The tag is kept inline (not just
# in a trailing comment) so Dependabot's docker ecosystem can read the semantic
# version and apply the "don't chase Current majors" ignore rule in
# .github/dependabot.yml — a bare `node@sha256:…` pin would otherwise track `latest`.
# Node 26 is the Active LTS (since 2026-10-28; node 24 is Maintenance). The node:26
# images are Debian 13 (trixie), so the system python3 below is 3.13 (bookworm: 3.11).
#
# Corepack is no longer bundled with Node (removed in Node 25), so it is installed
# from the npm registry tarball, hash-pinned with ADD --checksum. Not `npm install -g`:
# Scorecard's Pinned-Dependencies check flags any `npm install` in a Dockerfile, and
# the runtime stage deletes npm anyway. The tarball has no dependencies. Dependabot
# does not track it; bump both values together (sha256 of the .tgz, after checking it
# against `npm view corepack@<ver> dist.integrity`).
ARG COREPACK_VERSION=0.36.0
ARG COREPACK_SHA256=9128cfe26aee0c99f4fc68c15c6b8b12309a68be0de2c012cdfea2a463cb722f

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

WORKDIR /app

# Install corepack (see the ARGs above) and enable pnpm through it. Same layout the
# Node 24 image shipped: the package under /usr/local/lib/node_modules, shims in
# /usr/local/bin, so downstream images (curia-deploy's Dockerfile.curia) see no change.
ARG COREPACK_VERSION
ARG COREPACK_SHA256
ADD --checksum=sha256:${COREPACK_SHA256} https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz /tmp/corepack.tgz
RUN set -e; \
    mkdir -p /usr/local/lib/node_modules/corepack; \
    tar -xzf /tmp/corepack.tgz -C /usr/local/lib/node_modules/corepack --strip-components=1 --no-same-owner; \
    rm /tmp/corepack.tgz; \
    ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    corepack enable

# Install dependencies first (layer caching — deps change less often than src).
# Copy all workspace manifests so pnpm installs the full workspace in one shot.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json ./apps/console/
COPY apps/antfarm/package.json ./apps/antfarm/
COPY packages/shared-types/package.json ./packages/shared-types/
# Retry wrapper: a dropped registry connection can abort the Node process outright
# (unhandled stream error), which pnpm's own fetchRetries cannot catch. See
# docker/pnpm-retry.sh for the incident and why both layers are needed (#1699).
COPY docker/pnpm-retry.sh /usr/local/bin/pnpm-retry
RUN pnpm-retry pnpm install --frozen-lockfile

# Bundled embedding model (#2023): all-MiniLM-L6-v2 weights + tokenizer, downloaded HERE at
# build time and never at runtime. `pnpm fetch:embedder` pulls the Hugging Face revision
# pinned in models/embedding/manifest.json and checks each file's size and sha256 against
# it; a mismatch exits non-zero and fails the build. Only the three files the fetch needs
# are copied, so this layer (and the download) is cached until the pin or the fetcher
# changes. .dockerignore keeps locally fetched weights out of the build context, so the
# image always carries what this step verified, never a developer's copy.
# pnpm-retry re-runs a dropped download; a checksum mismatch fails every attempt.
COPY models/embedding/manifest.json ./models/embedding/
COPY src/memory/embedder-manifest.ts ./src/memory/
COPY scripts/fetch-embedder.ts ./scripts/
RUN pnpm-retry pnpm fetch:embedder

# Build backend
COPY src/ ./src/
COPY tsconfig.json ./
COPY packages/ ./packages/
# Skip --dts: type declarations are for library consumers, not the runtime image.
# tsup's DTS build also trips a TS 6.0 deprecation error on any tsconfig with baseUrl.
RUN pnpm exec tsup src/index.ts --format esm --no-dts

# Build console frontend — output lands in apps/console/dist/
COPY apps/console/ ./apps/console/
RUN pnpm --filter @curia/console run build

# Build Ant Farm frontend — output lands in apps/antfarm/dist/
COPY apps/antfarm/ ./apps/antfarm/
RUN pnpm --filter @curia/antfarm run build
# The licensed art normally ships in-repo (apps/antfarm/assets-licensed/limezu/),
# but it is optional: ensure the directory exists so the runtime COPY below never
# fails on a checkout that stripped the art. An empty dir → the assets route 404s
# → the Phaser scene falls back to procedural placeholders (graceful degradation).
RUN mkdir -p /app/apps/antfarm/assets-licensed

# Production stage: minimal runtime image.
# Same node:26-slim digest pin as the build stage above (see that comment for the
# Scorecard / Dependabot rationale). Both stages must stay on the same digest.
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

# curl is needed for the HEALTHCHECK command
# Copy uv/uvx binaries from the official signed image (Astral's recommended
# Docker pattern — no curl|sh, cryptographically signed, version-pinned).
# uv installs workspace-mcp at build time (below); the server then runs without it.
COPY --from=ghcr.io/astral-sh/uv:0.6.3 /uv /uvx /usr/local/bin/

# apt-get upgrade pulls the latest Debian 13 security patches for packages baked
# into the node:26-slim base layer (e.g. libgnutls30, libgcrypt20). Without it the
# image ships whatever versions were frozen when the base image was built, which
# Trivy flags as known CVEs even though Debian has already published fixes.
# Run upgrade before installing curl so curl is installed from the patched lists.
# pulseaudio-utils provides parec/pacat, which SignalAudioTransport spawns to
# move call PCM through the Pulse socket shared from the signal-cli container
# (#1672). Client tools only — no PulseAudio daemon runs in this image.
# python3 runs workspace-mcp, installed below (#2010). node:26-slim ships no Python,
# so without it uv downloads its own CPython; the Debian one gets security fixes from
# the `upgrade` on every rebuild. curia-deploy's image also installs into this Python.
# Acquire::Retries covers a transient Debian mirror hiccup, the apt-side equivalent of
# the npm registry drop that motivated #1699. Without it a single failed fetch fails the
# whole publish — and for the curia-postgres image this apt call is the ONLY network step,
# so it gets no benefit from the pnpm retry wrapper.
# ca-certificates is the system CA bundle. node:26-slim does not ship it, and
# --no-install-recommends stops curl from pulling it in, so it must be named. Node's own
# HTTPS never needed it (Node bundles its roots), but native code reads the OS trust
# store: the LiveKit client (@livekit/rtc-node FFI, 0.13+) found no roots, so every
# console and PWA call failed to join its room ("no native root CA certificates found").
# The `test -s` fails the build, not a production call, if the bundle ever goes missing.
# tests/unit/dockerfile-ca-certificates.test.ts keeps both lines in place.
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 upgrade -y \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates curl pulseaudio-utils python3 \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt

# Create a non-root system user/group for the runtime process.
# UIDs/GIDs are pinned (not dynamic) so docker-compose tmpfs uid= options
# and any external tooling can reference a stable, known value.
# --no-create-home: HOME=/tmp is set below; no home dir on disk is needed.
RUN groupadd --system --gid 1001 curia \
 && useradd --system --uid 1001 --gid 1001 --no-create-home curia

WORKDIR /app

# Same corepack install as the build stage (see the ARGs at the top of the file).
ARG COREPACK_VERSION
ARG COREPACK_SHA256
ADD --checksum=sha256:${COREPACK_SHA256} https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz /tmp/corepack.tgz
RUN set -e; \
    mkdir -p /usr/local/lib/node_modules/corepack; \
    tar -xzf /tmp/corepack.tgz -C /usr/local/lib/node_modules/corepack --strip-components=1 --no-same-owner; \
    rm /tmp/corepack.tgz; \
    ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    corepack enable

# Remove the base image's global npm/npx. They are unused at runtime (installs
# go through corepack→pnpm; CMD invokes tsx) and their bundled deps keep
# accumulating Trivy HIGH/MEDIUM findings that no npm 11.x/12.x pin clears:
#   - CVE-2026-14257 / GHSA-mh99-v99m-4gvg: brace-expansion < 5.0.8 (unbounded
#     expansion length OOM DoS) — code-scanning alert #233
#   - GHSA-r292-9mhp-454m: tar < 7.5.21 — code-scanning alert #235
# node:24-slim shipped npm@11.16.0 (brace-expansion@5.0.6, tar@7.5.15). The prior
# bump to npm@11.18.0 cleared an earlier brace-expansion/tar batch but still
# left 5.0.7 / 7.5.19. npm@12.0.1 (latest) bundles the same 5.0.7 / 7.5.19 —
# verified 2026-07-27 — so the "bump npm to clear bundled CVEs" pattern is
# exhausted. Stripping npm removes the recurring scan surface entirely;
# corepack is installed on its own (above) and does not depend on the global npm package.
# Fail closed: assert the global npm/npx are present before removal and
# unreachable afterward. `rm -rf` alone exits 0 even when its targets are
# already gone, so a future Node base image that relocates npm would leave the
# vulnerable bundled deps (brace-expansion, tar) in place while the build stayed
# green. These assertions turn that silent regression into a hard build failure.
# `hash -r` after the rm is load-bearing, not cosmetic: the `command -v npm/npx`
# pre-checks populate the shell's command-location hash table, and dash (this
# image's /bin/sh) answers a later `command -v` from that cache without re-stat'ing
# the filesystem. Without the flush, the post-removal checks report the now-deleted
# npm/npx as "still resolvable" and fail the build on every run (a false positive).
RUN set -e; \
    test -e /usr/local/lib/node_modules/npm; \
    command -v npm >/dev/null; \
    command -v npx >/dev/null; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx; \
    hash -r; \
    if command -v npm >/dev/null 2>&1; then echo 'npm still resolvable after removal' >&2; exit 1; fi; \
    if command -v npx >/dev/null 2>&1; then echo 'npx still resolvable after removal' >&2; exit 1; fi

# Same transient-network guard as the build stage (#1699). Copied here, ahead of the
# workspace-mcp install, which pulls a whole dependency tree from PyPI.
COPY docker/pnpm-retry.sh /usr/local/bin/pnpm-retry

# Install the Google Workspace MCP server (workspace-mcp) at build time, so the
# google-workspace server starts with no PyPI access at container start (#2010).
# `uvx workspace-mcp` used to fetch the package and its dependency tree on every boot
# (uv's cache lives under $HOME, which is not a volume), and one network error there
# lost every Workspace tool until the next restart (curia-deploy#181).
#
# The whole dependency tree, workspace-mcp included, comes from the hash-pinned lockfile
# scripts/workspace-mcp/requirements.txt (#2657), the one place core defines it.
# scripts/workspace-mcp.sh, which config/skills.yaml launches, runs this install whenever
# it is present.
#
# `uv pip sync --require-hashes` into a plain venv, not `uv tool install`: uv 0.6.3's
# tool install ignores the hashes in a constraints file, while sync checks every one and
# installs exactly the lockfile (minus the packages whose markers exclude Linux), with no
# unlisted dependency resolved on the side. --no-build: a source-only release would pull
# its build backend unpinned and unhashed, so a lock entry without a wheel fails the build
# instead. --no-config: no stray uv.toml can change the index.
#
# Fixed paths, not $HOME: the build runs as root and the server as curia, so the venv
# goes under /opt/uv/tools and the shim under /opt/uv/bin, root-owned and
# world-readable (the layout `uv tool install` used, which curia-deploy's image and its
# alerts refer to). The entry point execs the venv's python by absolute path, so it needs
# neither uv nor the network. UV_PYTHON_DOWNLOADS=never fails the build rather than
# quietly fetching a CPython if the Debian python3 above ever goes missing.
#
# Then fail the build, not the boot: probe.py asks the installed server for its tool
# list, over MCP, once per service in config/skills.yaml's `--tools` allowlist. A
# service whose dependencies break is skipped by workspace-mcp at startup, which still
# completes the handshake, so the zero-tool alert (#1500) would never fire.
# Only the install is wrapped in pnpm-retry: retrying an assertion defeats it.
COPY scripts/workspace-mcp/requirements.txt scripts/workspace-mcp/probe.py /tmp/workspace-mcp/
RUN set -eu; \
    export UV_PYTHON_DOWNLOADS=never; \
    uv venv --python /usr/bin/python3 /opt/uv/tools/workspace-mcp; \
    pnpm-retry uv pip sync --python /opt/uv/tools/workspace-mcp/bin/python \
      --require-hashes --no-build --no-config --compile-bytecode /tmp/workspace-mcp/requirements.txt; \
    mkdir -p /opt/uv/bin; \
    ln -s /opt/uv/tools/workspace-mcp/bin/workspace-mcp /opt/uv/bin/workspace-mcp; \
    /usr/bin/python3 -I /tmp/workspace-mcp/probe.py /opt/uv/bin/workspace-mcp drive docs sheets; \
    rm -rf /tmp/workspace-mcp /root/.cache/uv

# Copy manifest and lockfile, then install production deps only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Copy the @curia/shared-types workspace package (source-only: package.json +
# index.ts) so the workspace graph is internally consistent. The root package.json
# declares `@curia/shared-types: "workspace:*"` as a prod dependency and
# pnpm-workspace.yaml declares `packages: [apps/*, packages/*]`; the `pnpm add tsx`
# below re-resolves the FULL workspace and aborts with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND
# if the member isn't on disk. (--frozen-lockfile tolerates a dangling link; `pnpm add`
# does a strict re-resolution.) shared-types is imported type-only (erased at build), so
# it isn't required at runtime, but shipping the member keeps the manifest honest.
COPY --from=build /app/packages/shared-types ./packages/shared-types

# tsx is needed at runtime: skill handlers are .ts files loaded via dynamic
# import(), and they use ESM .js extension mapping (e.g., import from './foo.js'
# resolving to foo.ts). Node's --experimental-strip-types doesn't handle this;
# tsx does, and it's already used for dev (pnpm dev).
#
# The same RUN prunes onnxruntime-node (the bundled embedder's runtime, #2023) down to
# this image's own platform. The package ships native binaries for every platform it
# supports, ~286 MB in all (darwin/arm64, win32/x64, win32/arm64, linux/x64,
# linux/arm64), and the image needs one: bin/napi-v*/linux/<arch>, 44 MB on x64 and
# 24 MB on arm64. Docker's TARGETARCH says amd64 where onnxruntime-node says x64.
#
# Why here, and why from the store too (maintainer's decision, design §4):
#   - The pnpm store is KEPT in this image for curia-deploy (#1758, see the long comment
#     below), and it holds its own copy of every file, so pruning node_modules alone
#     leaves the binaries in the image.
#   - The store copy is found by CONTENT, not by inode. Most node_modules entries are
#     hardlinks into the store, but pnpm COPIES a package that has a build script, and
#     onnxruntime-node has a postinstall (left disabled by allowBuilds), so its files have
#     separate store copies that `find -samefile` cannot see (verified: link count 1).
#     The store is content-addressed: a file lives at <storeDir>/files/<first 2 hex of
#     its sha512>/<the rest>, with an `-exec` suffix when executable. So each pruned
#     file's sha512 names its store copy, hardlinked or not. storeDir is read from
#     node_modules/.modules.yaml, which records the store this install used.
#   - A layer can only shrink what it created. Pruning in a later RUN would leave the
#     binaries in this layer and add whiteouts on top, so the prune lives in the install
#     RUN itself.
#   - Accepted cost: curia-deploy's downstream `pnpm add` may find onnxruntime-node's
#     store entry incomplete and re-download that one package. A failed downstream build
#     is NOT accepted. Verified with pnpm 11.7.0: Dockerfile.curia builds on this image,
#     its `pnpm add` downloaded nothing, and onnxruntime-node still loads there (#2023).
#
# Fail closed, in the #1758 style below: a glob that matches nothing, a missing
# linux/<arch> dir, an unexpected storeDir, a pruned file whose store copy is not where
# its hash says (the store layout changed, so the prune would leave it in the image),
# or any platform dir left behind fails the build, and
# `require('onnxruntime-node')`, which loads the native binding eagerly, must still work.
# The temp lists are files rather than pipes because dash has no pipefail: a failing
# `find` at the head of a pipe would otherwise go unnoticed.
#
# Two refinements, both keyed on the KEPT linux/<arch> files' own hashes:
#   - A pruned file whose content matches a kept file is removed from node_modules but
#     its store copy stays: deleting it would delete the kept file's store copy too.
#   - Each kept node_modules file is then replaced by a hardlink to its store copy. pnpm
#     wrote them as two separate files (it copied the package, above), so without this
#     the binary sits in this layer twice. As hardlinks in one layer, the layer tar stores
#     it once: 24 MB saved on arm64, 44 MB on amd64. The store stays complete for the
#     kept files, so curia-deploy's `pnpm add` sees the same store as before.
#
# Image size (design §4, "Image size"), `docker image inspect -f '{{.Size}}'` against the
# image before #2023: arm64 +103.7 MB before the hardlinks, +78.2 MB after; amd64
# +119.5 MB (emulated local build; CI's curia-image job prints the native figure on every
# build). The weights are
# 23.7 MB and the new JS dependencies a few MB; the rest is the kept binary (24 MB arm64,
# 44 MB amd64), which still ships twice: once here, and once more in the
# `chown -R curia:curia /app` layer below, whose copy-up rewrites every file under /app
# into its own layer (breaking the hardlink there).
# TODO(#2631): that chown layer duplicates ALL of node_modules (~611 MB on
# arm64 before this change), not just this binary. It is the real root cause of the
# image's size and is out of scope here; `COPY --chown`/`--chmod` or installing as the
# curia user would remove it, but either touches #1758's store-for-curia-deploy contract.
ARG TARGETARCH
RUN set -e; \
    pnpm-retry pnpm install --frozen-lockfile --prod; \
    case "$TARGETARCH" in \
      amd64) ort_arch=x64 ;; \
      arm64) ort_arch=arm64 ;; \
      *) echo "onnxruntime-node prune: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    storedir=$(sed -n 's/^ *"storeDir": "\(.*\)",\{0,1\}$/\1/p' node_modules/.modules.yaml); \
    case "$storedir" in /root/.local/share/pnpm/*) ;; \
      *) echo "onnxruntime-node prune: unexpected pnpm storeDir '$storedir' in node_modules/.modules.yaml" >&2; exit 1 ;; \
    esac; \
    test -d "$storedir/files"; \
    ort_bins=$(echo node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*); \
    for d in $ort_bins; do test -d "$d/linux/$ort_arch"; done; \
    find $ort_bins -type f -path "*/linux/$ort_arch/*" -exec sha512sum {} + > /tmp/ort-keep.sums; \
    test -s /tmp/ort-keep.sums; \
    cut -d' ' -f1 /tmp/ort-keep.sums | sort -u > /tmp/ort-keep.hashes; \
    find $ort_bins -type f ! -path "*/linux/$ort_arch/*" -exec sha512sum {} + > /tmp/ort-prune.sums; \
    test -s /tmp/ort-prune.sums; \
    cut -d' ' -f1 /tmp/ort-prune.sums | sort -u > /tmp/ort-prune.all; \
    comm -23 /tmp/ort-prune.all /tmp/ort-keep.hashes > /tmp/ort-prune.hashes; \
    while read -r h; do \
      p="$storedir/files/$(printf %.2s "$h")/${h#??}"; \
      hits=0; \
      for c in "$p" "$p-exec"; do \
        if [ -e "$c" ]; then rm -f "$c"; hits=$((hits + 1)); fi; \
      done; \
      if [ "$hits" -eq 0 ]; then \
        echo "onnxruntime-node prune: no pnpm store copy at $p (sha512 of a pruned file); pruning node_modules alone would leave the store copy in the image" >&2; \
        exit 1; \
      fi; \
    done < /tmp/ort-prune.hashes; \
    echo "onnxruntime-node prune: removed $(wc -l < /tmp/ort-prune.sums) node_modules files, $(wc -l < /tmp/ort-prune.hashes) store files ($(($(wc -l < /tmp/ort-prune.all) - $(wc -l < /tmp/ort-prune.hashes))) shared with a kept file, left in the store); keeping linux/$ort_arch"; \
    for d in $ort_bins; do \
      for p in "$d"/*/*; do \
        if [ "$p" != "$d/linux/$ort_arch" ]; then rm -rf "$p"; fi; \
      done; \
      find "$d" -mindepth 1 -type d -empty -delete; \
    done; \
    find $ort_bins -mindepth 1 -maxdepth 2 -type d ! -name linux ! -path "*/linux/$ort_arch" > /tmp/ort-left; \
    if [ -s /tmp/ort-left ]; then \
      echo "onnxruntime-node prune: platform dirs left behind:" >&2; cat /tmp/ort-left >&2; exit 1; \
    fi; \
    while read -r h f; do \
      p="$storedir/files/$(printf %.2s "$h")/${h#??}"; \
      if [ -x "$f" ]; then first="$p-exec"; second="$p"; else first="$p"; second="$p-exec"; fi; \
      if [ -e "$first" ]; then c="$first"; \
      elif [ -e "$second" ]; then c="$second"; \
      else echo "onnxruntime-node prune: no pnpm store copy at $p for kept $f; cannot hardlink it" >&2; exit 1; fi; \
      ln -f "$c" "$f"; \
      if [ ! "$f" -ef "$c" ]; then echo "onnxruntime-node prune: $f is not a hardlink to $c after ln" >&2; exit 1; fi; \
    done < /tmp/ort-keep.sums; \
    echo "onnxruntime-node prune: hardlinked $(wc -l < /tmp/ort-keep.sums) kept files to their store copies"; \
    node -e "require('onnxruntime-node')"; \
    echo "onnxruntime-node prune: OK, require('onnxruntime-node') loads on linux/$ort_arch"; \
    rm -f /tmp/ort-keep.sums /tmp/ort-keep.hashes /tmp/ort-prune.sums /tmp/ort-prune.all /tmp/ort-prune.hashes /tmp/ort-left

# Three flags are load-bearing (verified against pnpm 11.7.0, the pinned pkg mgr).
# Since packages/shared-types made this a real workspace, this dir is now a workspace
# ROOT and a bare `pnpm add tsx` fails a chain of guards:
#   -w: without it, a `pnpm add` at a workspace root is rejected with
#     ERR_PNPM_ADDING_TO_ROOT. tsx is a genuine root-level runtime dep, so the root is
#     the correct target (the shared-types member copied above lets it re-resolve).
#   --prod: the frozen install above ran with --prod, so node_modules/.modules.yaml
#     records a prod-only include set; a bare `pnpm add` also wants devDependencies,
#     which pnpm 11 rejects with ERR_PNPM_INCLUDED_DEPS_CONFLICT. --prod keeps the add
#     prod-only so the include sets match.
#   --save-prod: tsx is declared as a *devDependency* in package.json, so --prod alone
#     would leave it there and never install it — no ./node_modules/.bin/tsx, which the
#     CMD below invokes. --save-prod promotes tsx into `dependencies` so it installs.
RUN pnpm-retry pnpm add -w --save-prod --prod tsx

# Remove build-only artifacts that are unreachable at runtime (CMD invokes
# ./node_modules/.bin/tsx directly; no install ever runs inside the container):
#   - /root/.cache/node/corepack and /root/.cache/corepack — corepack's cached pnpm
#     tarballs. Node 24's bundled corepack pre-cached pnpm@11.0.8 during `corepack
#     enable` even though this project pins pnpm@11.7.0, and 11.0.8 bundles tar@7.5.13
#     (CVE-2026-53655, PAX size override / parser interpretation differential). Nothing
#     reads the cache at runtime, so it goes whatever version it holds. Both paths are
#     removed: current corepack writes the first (confirmed by the original Trivy alert
#     path), the second is the older corepack layout, kept so this stays correct across
#     corepack bumps.
#
# -- Three things are deliberately KEPT. Do not "clean them up". (#1758) --
#
# curia-deploy's thin downstream image (deploy/compose/Dockerfile.curia) builds FROM
# this one, switches to root, and runs `pnpm add` to layer in its own extensions. That
# `pnpm add` forces a strict re-resolution of the ENTIRE workspace — devDependencies
# included — and then verifies all ~1300 lockfile entries against pnpm's supply-chain
# policies. All three are what let it do that from disk instead of from the network,
# and survive the network it still needs:
#
#   - /root/.cache/pnpm — the registry METADATA cache. Without it the downstream build
#     fetches a packument per lockfile entry. drizzle-orm's alone is 64 MB (a promptfoo
#     dev transitive), which on a saturated link exceeds fetchTimeout; trustPolicy
#     verification is fail-closed, so "could not be checked" becomes
#     ERR_PNPM_TRUST_DOWNGRADE and the deploy dies on a package that has nothing wrong
#     with it. Verification measured 15m 44s on the VPS versus ~18s in CI.
#   - /root/.local/share/pnpm — the content-addressable store. node_modules entries are
#     hardlinks into it; without it the downstream re-downloads tarballs it already has.
#   - /usr/local/bin/pnpm-retry — the retry wrapper the two installs above used. #1699
#     deleted it here as build-only tooling, on the reasoning that this stage was its
#     last use. That is no longer true. The downstream `pnpm add` goes to the registry
#     too, and it is the step that died in curia-deploy#220 on an UND_ERR_SOCKET abort —
#     the unhandled-stream failure that no `fetchRetries` value can catch, because Node
#     kills the process before pnpm classifies anything (see docker/pnpm-retry.sh).
#     Keeping it lets the downstream image wrap that command instead of vendoring a
#     second copy that would drift from the one tests/docker/test-pnpm-retry.sh covers.
#     The cost is ~4KB of POSIX sh that nothing at runtime invokes; the removal was
#     image hygiene, never a security control.
#
# The metadata cache is why code-scanning #271-#282 exist: its v11/metadata-full/*.jsonl
# files embed each package's README, and Trivy's secret scanner reads @octokit/auth-
# token's `createTokenAuth("ghp_…")` documentation snippet as a leaked credential. Those
# are false positives over public README text sitting in a build cache, so the scanner
# is scoped past this path in .github/workflows/trivy.yml rather than the cache being
# deleted out from under the deploy. Deleting it is only safe once Dockerfile.curia
# stops re-resolving the whole workspace (curia-deploy#220).
#
# Fail closed, in both directions. `rm -rf` exits 0 whether or not it removed anything,
# so a future pnpm or base-image change that relocated any of these paths would silently
# turn this into a no-op while the build stayed green. Executing tsx afterwards proves
# the runtime entry point still resolves — the one property this cleanup must not break
# — and mirrors the assertions around the npm/npx removal above.
#
# The `test -x` on pnpm-retry is the mirror image, and is the only thing holding the
# downstream contract: without it, re-adding the wrapper to that `rm -rf` (an easy and
# plausible cleanup, since it is build tooling by every local signal) still builds green
# here and surfaces as `pnpm-retry: not found`, exit 127, in curia-deploy's image build
# — a different repo, hours later. Fail it here instead, where the cause is on screen.
RUN set -e; \
    rm -rf /root/.cache/node/corepack /root/.cache/corepack; \
    test -x /usr/local/bin/pnpm-retry; \
    ./node_modules/.bin/tsx --version

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Copy console static bundle — served by Fastify at runtime
COPY --from=build /app/apps/console/dist ./apps/console/dist

# Copy Ant Farm static bundle — served under /antfarm/
COPY --from=build /app/apps/antfarm/dist ./apps/antfarm/dist

# Copy licensed LimeZu art — served ONLY behind auth by /api/antfarm/assets/*
# (never under /antfarm/; the dir sits outside the Vite public/ web root). LimeZu
# granted redistribution, so the art now lives in-repo (apps/antfarm/assets-licensed/)
# and ships in the open-core image. Without this the route 404s and the Phaser
# scene falls back to procedural placeholders.
COPY --from=build /app/apps/antfarm/assets-licensed ./apps/antfarm/assets-licensed

# Copy runtime data files loaded at startup
# Full src/ is needed because skill handlers import from src/ (e.g., bus/events.ts)
# and tsx resolves these at runtime
COPY agents/ ./agents/
COPY skills/ ./skills/
COPY config/ ./config/
# JSON Schemas consumed by src/startup/validator.ts at boot. tsup bundles every
# source file into a single dist/index.js, so the file-relative path that used
# to compute schemasDir from `import.meta.dirname` would land at /schemas in
# the container. The validator now takes schemasDir as an explicit parameter
# computed from src/index.ts (../schemas), which resolves to /app/schemas here.
COPY schemas/ ./schemas/
COPY src/ ./src/
# Maintenance scripts (e.g. dedup-contacts, backfill-*) are run as one-off commands
# in the running container via `tsx scripts/<name>.ts`. They import from src/ (copied
# above) and rely on tsx + prod node_modules, both present at runtime. Without this
# COPY the scripts simply aren't in the image, so the commands fail with "file not
# found" — copy the whole dir so new maintenance scripts are available without a
# Dockerfile edit each time. (The handful of *.test.ts files here are inert: vitest
# isn't installed in the prod image, so they can't run; they just ride along.)
COPY scripts/ ./scripts/

# node_modules were installed as root above, so we chown the entire /app tree
# to the non-root user before dropping privileges. /usr/local/bin/uv,
# /usr/local/bin/uvx, and /usr/bin/curl are world-executable (no chown needed).
RUN chown -R curia:curia /app

# The bundled embedding model (#2023), fetched and sha256-verified in the build stage:
# manifest.json plus all-MiniLM-L6-v2/, at /app/models/embedding/all-MiniLM-L6-v2, the
# directory boot resolves by default (EMBEDDING_MODEL_DIR overrides it). Copied AFTER the
# chown above on purpose: the chown rewrites every file it touches into its own layer, so
# copying first would ship the ~23 MB of weights twice. They stay root-owned and
# world-readable; nothing at runtime writes them, and the curia user should not be able to.
COPY --from=build /app/models/embedding ./models/embedding

# Build-time load check (#2023): load the model once, exactly as the bundled backend does
# at boot (weights hashed into the profile, then EmbeddingService.createBundled), and embed
# one string. Runs here, in the runtime stage, after the prune and the `pnpm add` above,
# so it tests what actually ships: the weights, the tokenizer and this platform's
# onnxruntime-node binding. The prune's own `require()` check proves the binding loads;
# this proves it runs the model. A failure here fails the build instead of turning the
# knowledge graph off at a customer's first boot.
# It also re-asserts the prune: no onnxruntime-node platform dir but linux/<arch> may
# exist after the `pnpm add`, which could in principle have re-imported the package.
# Native builds only (BUILDPLATFORM == TARGETPLATFORM). docker-publish builds the arm64
# image on an amd64 runner under QEMU, where running onnxruntime inference is slow and
# itself unverified; a cross-arch build prints a skip line and passes. Each arch is still
# proven natively elsewhere: amd64 by CI's curia-image job (this check, then
# tests/docker/test-bundled-embedder-egress.sh), arm64 by running that egress test on an
# arm64 host. The prune RUN's `require('onnxruntime-node')` still runs on every build.
# The load leaves root-owned files in /tmp, which would otherwise ship: tsx's transpile
# cache (/tmp/tsx-0), and onnxruntime's session marker (/tmp/.ses) and debug log
# (/tmp/mat-debug-<pid>.log). Removed so the curia user never meets a root-owned copy.
ARG BUILDPLATFORM
ARG TARGETPLATFORM
RUN set -e; \
    case "$TARGETARCH" in \
      amd64) ort_arch=x64 ;; \
      arm64) ort_arch=arm64 ;; \
      *) echo "bundled embedder load check: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    if [ -z "$BUILDPLATFORM" ] || [ -z "$TARGETPLATFORM" ]; then \
      echo "bundled embedder load check: BUILDPLATFORM/TARGETPLATFORM unset (BuildKit required)" >&2; exit 1; \
    fi; \
    find node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v* \
      -mindepth 1 -maxdepth 2 -type d ! -name linux ! -path "*/linux/$ort_arch" > /tmp/ort-left; \
    if [ -s /tmp/ort-left ]; then \
      echo "onnxruntime-node platform dirs reappeared after the prune:" >&2; cat /tmp/ort-left >&2; exit 1; \
    fi; \
    rm -f /tmp/ort-left; \
    if [ "$BUILDPLATFORM" != "$TARGETPLATFORM" ]; then \
      echo "bundled embedder load check: SKIPPED, cross-arch build ($BUILDPLATFORM -> $TARGETPLATFORM); verified natively by the egress test"; \
    else \
    ./node_modules/.bin/tsx -e "(async () => { \
      const { default: pino } = await import('pino'); \
      const { EmbeddingService } = await import('./src/memory/embedding.js'); \
      const { ALL_MINILM_L6_V2 } = await import('./src/memory/embedding-profiles.js'); \
      const { hashBundledWeights } = await import('./src/memory/embedding-onnx.js'); \
      const dir = 'models/embedding/all-MiniLM-L6-v2'; \
      const logger = pino({ level: 'warn' }); \
      const profile = { ...ALL_MINILM_L6_V2, weightsSha256: await hashBundledWeights(dir, logger) }; \
      const service = await EmbeddingService.createBundled(dir, profile, logger); \
      try { \
        const v = await service.embed('build-time load check', 'document'); \
        if (v.length !== profile.dimensions) throw new Error('expected ' + profile.dimensions + ' dims, got ' + v.length); \
        process.stdout.write('bundled embedder load check: OK, ' + v.length + ' dims\n'); \
      } finally { \
        await service.close(); \
      } \
    })().catch((err) => { \
      process.stderr.write('bundled embedder load check failed: ' + (err && err.stack ? err.stack : err) + '\n'); \
      process.exit(1); \
    });"; \
    fi; \
    rm -rf /tmp/tsx-0 /tmp/.ses /tmp/mat-debug-*.log

# Pre-create the tmpfs mount point so Docker's runtime tmpfs mount inherits
# curia ownership. Without this, Docker mounts the tmpfs as root:root with
# mode=0700, making it inaccessible to the curia user at runtime.
RUN mkdir -p /run/curia-tempfiles \
 && chown curia:curia /run/curia-tempfiles \
 && chmod 0700 /run/curia-tempfiles

# Pre-create the OAuth token directory for workspace-mcp. Without this,
# Docker's copy-up creates the directory as root when the named volume is
# first mounted, making it unwritable by the curia user at runtime.
RUN mkdir -p /tmp/.google_workspace_mcp \
 && chown curia:curia /tmp/.google_workspace_mcp

EXPOSE 3000

# Health check matches the Fastify /api/health route.
# start_period bumped 15s → 60s to cover the realistic cold-boot cost:
# JIT, agent loading, KG migrations check, scheduler init can take 20-30s
# on small hosts. The previous 15s window flapped the container as "unhealthy"
# before it had finished starting up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Drop to non-root before starting the process.
# HOME=/tmp: --no-create-home leaves /etc/passwd pointing at /home/curia (which
# does not exist on disk). Tools like tsx and uv write cache files to $HOME; with
# a missing home they would get ENOENT. /tmp is world-writable and always exists.
# USER and LOGNAME are not set automatically by Docker when using exec-form CMD
# (no shell login), so we set them explicitly for MCP subprocess environments.
#
# NODE_ENV=production switches the pino logger to stdout JSON (default branch in
# src/logger.ts). Without it, pino-pretty writes to `curia.log` *inside* the
# container — invisible to `docker logs` and lost when the container exits.
# That made #805 bug 3 effectively undebuggable: every fatal startup error
# vanished before anyone could see it. File-based logging is an anti-pattern
# inside containers; production-mode logging is the only sane default for the
# Docker image.
#
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is defence-in-depth: the CMD below invokes
# tsx directly (no pnpm/corepack at runtime), but if anyone changes CMD back to
# go through pnpm, modern corepack would prompt non-interactively and exit 1
# silently. Keeping the env var means future corepack invocations don't block.
ENV HOME=/tmp \
    USER=curia \
    LOGNAME=curia \
    NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
USER curia

# Invoke tsx directly rather than going through `pnpm exec tsx ...`. The pnpm
# route triggers corepack at runtime, which in turn looks for a pnpm tarball
# in /tmp/.cache/node/corepack (HOME=/tmp for the curia user). That cache is
# empty at runtime because the build-stage pnpm install ran as root and
# populated /root/.cache/node/corepack (then cleaned up — see the rm step
# above), and corepack then prompts before downloading. In a non-TTY container
# the prompt sees EOF and the process exits 1 silently — exactly the failure
# mode that took two hours to debug in #805.
#
# tsx is needed because dist/index.js dynamically imports raw .ts skill handlers
# at runtime via ESM .js→.ts extension resolution. node alone cannot do that.
# The .bin shim is created by `pnpm add tsx` above and is the documented way
# to call tsx without a package manager wrapper.
CMD ["./node_modules/.bin/tsx", "dist/index.js"]
