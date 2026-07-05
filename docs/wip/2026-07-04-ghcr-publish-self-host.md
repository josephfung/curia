# GHCR Image Publish + Image-Based Self-Host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish semver-tagged, signed, multi-arch Curia images (app + Postgres) to GHCR, ship an interactive image-based `install.sh` so a Docker-only machine can run a released Curia with no source checkout, and collapse `curia-deploy`'s duplicated core Dockerfile into a thin `FROM ghcr.io/josephfung/curia` layer.

**Architecture:** `curia/Dockerfile` becomes the single published source of truth (`ghcr.io/josephfung/curia`), and `docker/postgres.Dockerfile` publishes `ghcr.io/josephfung/curia-postgres`. The shared root `docker-compose.yml` switches from build-contexts to `image:` refs; developers restore local builds via a `docker-compose.dev.yml` override. A new interactive `install.sh` prompts for the Anthropic key, seeds the vault *inside the pulled image*, and brings the stack up. `curia-deploy` pulls the published core image and layers only private extensions on the VPS.

**Tech Stack:** GitHub Actions, docker buildx (QEMU multi-arch), cosign (keyless OIDC), anchore/sbom-action, Docker Compose v2, Bash, node-pg-migrate, tsx, pnpm.

**Spec:** `docs/wip/2026-07-04-ghcr-publish-self-host-design.md`

## Global Constraints

- **No `Co-Authored-By` / no Claude attribution** anywhere (commits, PRs, code, docs). Hard rule.
- **Conventional commits** (`feat:`/`fix:`/`chore:`/`docs:`); commit early and often, one logical change per commit.
- **Every PR updates `CHANGELOG.md`** under `## [Unreleased]` before opening; use **Added/Changed/Fixed/Removed/Security** sections, one bold-led bullet per change, reference `#1343`.
- **Every PR body includes `Closes #1343`** (Part A) — Part B references but does not close it.
- **No em dashes** in any prose authored for user-facing docs/README/curia-docs (repo docs allow them).
- **Image registry/name:** `ghcr.io/josephfung/curia` (app), `ghcr.io/josephfung/curia-postgres` (db). Both **public**.
- **Multi-arch:** `linux/amd64,linux/arm64` for both images.
- **Supply chain:** cosign keyless-sign each pushed image by digest + buildx SBOM/provenance attestations. Mirror `release.yml`'s OIDC identity posture.
- **Curia runtime avoids corepack** — invoke `tsx` directly (`./node_modules/.bin/tsx`), never `pnpm ...`, inside the published image.
- **Node ≥ 24**, pnpm `11.7.0`, ESM, `.js` import extensions (unchanged; only relevant if touching TS — this plan does not).
- **Two repos / two PRs:** Part A in worktree `worktrees/curia-ghcr-publish-1343` (branch `feat/ghcr-publish-1343`). Part B in a **new** `curia-deploy` worktree (create in Task B0).

---

## File Structure

**Part A — curia repo** (`worktrees/curia-ghcr-publish-1343`)

- Create: `.github/workflows/docker-publish.yml` — build+push+sign both images.
- Modify: `docker/postgres.Dockerfile` — bake the pgAudit init SQL into the image.
- Modify: `docker-compose.yml` — `build:` → `image:` for `curia` and `postgres`; drop the init-SQL volume mount.
- Create: `docker-compose.dev.yml` — build-context override for the developer path.
- Create: `docker-compose.tls.yml` — optional Caddy HTTPS overlay.
- Create: `deploy/Caddyfile` — Caddyfile for the TLS overlay.
- Modify: `.env.example` — add `CURIA_IMAGE_TAG`, `CURIA_POSTGRES_TAG`, `DOMAIN`, commented `COMPOSE_FILE`.
- Create: `scripts/setup-common.sh` — shared prompt/secret-gen/health-poll/summary helpers.
- Modify: `scripts/setup.sh` — source `setup-common.sh`; use `-f docker-compose.dev.yml` for local build.
- Create: `install.sh` (repo root) — interactive image-based operator installer.
- Modify: `tests/setup/test-setup-functions.sh` — cover `setup-common.sh` + `install.sh` pure helpers.
- Create: `package.json` script `test:shell` + Modify `.github/workflows/ci.yml` — run the shell tests in CI.
- Modify: `CHANGELOG.md`, `docs/dev/setup.md` (or equivalent), `README.md` — document the two install paths.

**Part B — curia-deploy repo** (new worktree)

- Modify: `deploy/compose/Dockerfile.curia` — `FROM ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG}` + private layers only.
- Modify: `deploy/compose/compose.production.yaml` — image-based base; build context `curia-deploy/`; postgres image ref.
- Modify: `scripts/deploy.sh` — drop core rsync; pull image tag; `CURIA_IMAGE_TAG` var.
- Modify: `.github/workflows/validate.yml` — keep Dockerfile/Caddyfile lint valid against the thin file.
- Modify: deploy runbook docs.

---

# PART A — curia repo

## Task A1: Bake the pgAudit init SQL into the Postgres image

**Files:**
- Modify: `docker/postgres.Dockerfile`
- Reference: `docker/postgres-init-pgaudit.sql` (baked), `docker-compose.yml:15` (current volume mount)

**Interfaces:**
- Produces: image build in which `/docker-entrypoint-initdb.d/10-pgaudit.sql` exists without a host mount. Consumed by A3 (compose drops the mount) and A2 (published).

- [ ] **Step 1: Add the COPY to the Dockerfile**

In `docker/postgres.Dockerfile`, after the `COPY docker/postgres-verify-pgaudit.sh ...` line and before `ENTRYPOINT`, add:

```dockerfile
# Bake the pgAudit init script into the image so a source-free self-host stack
# (no repo checkout to volume-mount) still runs it on first DB init. The compose
# volume mount is removed in lockstep (see docker-compose.yml).
COPY docker/postgres-init-pgaudit.sql /docker-entrypoint-initdb.d/10-pgaudit.sql
```

- [ ] **Step 2: Build the image to verify it succeeds and the file lands**

Run:
```bash
docker build -f docker/postgres.Dockerfile -t curia-postgres:verify .
docker run --rm --entrypoint ls curia-postgres:verify -1 /docker-entrypoint-initdb.d/
```
Expected: build succeeds; `ls` output includes `10-pgaudit.sql`.

- [ ] **Step 3: Commit**

```bash
git add docker/postgres.Dockerfile
git commit -m "feat: bake pgAudit init SQL into postgres image for source-free self-host (#1343)"
```

---

## Task A2: Publish workflow for both images (multi-arch, signed, SBOM)

**Files:**
- Create: `.github/workflows/docker-publish.yml`
- Reference: `.github/workflows/release.yml` (cosign identity + tag-validation pattern), `.github/workflows/trivy.yml` (existing `docker build` usage)

**Interfaces:**
- Produces: `ghcr.io/josephfung/curia:{vX.Y.Z,latest,edge}` and `ghcr.io/josephfung/curia-postgres:{pg16,latest,edge}`, each multi-arch + cosign-signed + SBOM-attested. Consumed by A3 (compose refs) and all of Part B.

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/docker-publish.yml`:

```yaml
name: docker-publish

# Build, push, sign, and SBOM-attest the Curia app + Postgres images to GHCR.
# - release published -> semver + latest (app), pg16 + latest (postgres)
# - push to main      -> edge (both), for dogfood / curia-deploy pulls
on:
  release:
    types: [published]
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      tag:
        description: "Release tag to (re)publish, e.g. v0.40.0"
        required: false

permissions:
  contents: read
  packages: write
  id-token: write   # keyless cosign via GitHub OIDC

env:
  REGISTRY: ghcr.io

jobs:
  # Validate a workflow_dispatch tag input against strict semver to avoid
  # injection (mirrors release.yml). No-op on release/push triggers.
  guard:
    runs-on: ubuntu-latest
    steps:
      - name: Validate dispatch tag
        if: github.event_name == 'workflow_dispatch' && inputs.tag != ''
        run: |
          echo "${{ inputs.tag }}" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$' \
            || { echo "Invalid tag format"; exit 1; }

  build:
    needs: guard
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: curia
            image: curia
            dockerfile: Dockerfile
            # App tags: semver+latest on release, edge on main.
            tags: |
              type=semver,pattern=v{{version}}
              type=semver,pattern=v{{major}}.{{minor}}
              type=raw,value=latest,enable=${{ github.event_name == 'release' }}
              type=raw,value=edge,enable=${{ github.ref == 'refs/heads/main' }}
          - name: curia-postgres
            image: curia-postgres
            dockerfile: docker/postgres.Dockerfile
            # DB is versioned by pg major, not app semver.
            tags: |
              type=raw,value=pg16
              type=raw,value=latest,enable=${{ github.event_name == 'release' }}
              type=raw,value=edge,enable=${{ github.ref == 'refs/heads/main' }}
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Derive tags & labels
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.image }}
          tags: ${{ matrix.tags }}

      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          provenance: mode=max
          sbom: true

      - name: Install cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign the pushed image by digest
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
          IMAGE: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.image }}
        run: cosign sign --yes "${IMAGE}@${DIGEST}"
```

- [ ] **Step 2: Lint the workflow syntax**

Run:
```bash
npx --yes @action-validator/cli .github/workflows/docker-publish.yml || \
  docker run --rm -v "$PWD":/repo rhysd/actionlint:latest -color /repo/.github/workflows/docker-publish.yml
```
Expected: no errors. (If neither linter is available, at minimum `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/docker-publish.yml'))"` must succeed.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "feat: publish signed multi-arch curia + curia-postgres images to GHCR (#1343)"
```

- [ ] **Step 4: Post-merge verification (record, do not run now)**

After this lands on main, the `push: [main]` trigger runs. Verify once available:
```bash
gh run list --workflow=docker-publish.yml --limit 1          # green
docker pull ghcr.io/josephfung/curia:edge
docker buildx imagetools inspect ghcr.io/josephfung/curia:edge | grep -E "linux/amd64|linux/arm64"
cosign verify ghcr.io/josephfung/curia:edge \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/josephfung/curia/.github/workflows/docker-publish.yml@'
```
Also set both GHCR packages to **public** in repo/org package settings (one-time).

---

## Task A3: Convert root compose to image-based + dev override + env

**Files:**
- Modify: `docker-compose.yml`
- Create: `docker-compose.dev.yml`
- Modify: `.env.example`

**Interfaces:**
- Consumes: images from A2, baked init from A1.
- Produces: `docker compose up -d` pulls published images; `-f docker-compose.dev.yml` restores local builds. `.env` keys `CURIA_IMAGE_TAG`, `CURIA_POSTGRES_TAG` consumed by compose. Consumed by A5 (setup.sh dev), A6 (install.sh).

- [ ] **Step 1: Switch `postgres` to an image + drop the init mount**

In `docker-compose.yml`, replace the `postgres` service's `build:` block (lines ~2-5) with an `image:` line, and remove the init-SQL volume mount (line ~15). Result:

```yaml
  postgres:
    image: ghcr.io/josephfung/curia-postgres:${CURIA_POSTGRES_TAG:-pg16}
    restart: unless-stopped
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: curia
      POSTGRES_USER: ${DB_USER:-your-db-user}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-your-db-password}
    command: >
      postgres
      -c shared_preload_libraries=pgaudit
      -c pgaudit.log=write,ddl
      -c pgaudit.log_parameter=on
      -c pgaudit.log_relation=on
      -c pgaudit.role=pgaudit_role
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-curia}"]
      interval: 5s
      timeout: 5s
      retries: 5
```

- [ ] **Step 2: Switch `curia` to an image**

Replace the `curia` service's `build:` block (lines ~39-41) with:

```yaml
  curia:
    image: ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG:-latest}
```
Leave the rest of the `curia` service (ports, `env_file`, `DATABASE_URL` override, `depends_on`, healthcheck, volumes, tmpfs) unchanged.

- [ ] **Step 3: Create the dev override**

Create `docker-compose.dev.yml`:

```yaml
# Developer/source override: restores local image builds instead of pulling
# published GHCR images. Used by `pnpm run setup` (scripts/setup.sh) and any
# contributor running from a source checkout:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
services:
  postgres:
    build:
      context: .
      dockerfile: docker/postgres.Dockerfile
  curia:
    build:
      context: .
      dockerfile: Dockerfile
```

When both `build:` and `image:` are present, Compose builds locally and tags the
result with the `image:` name from the base file — exactly what the dev path
wants (build from source, no pull). No `!reset` needed.

- [ ] **Step 4: Update `.env.example`**

In `.env.example`, add below the `HTTP_PORT` block:

```bash
# Published image tags (Docker Compose pulls these). Pin to a vX.Y.Z for a
# stable self-host; `latest` tracks the newest release, `edge` the newest main.
CURIA_IMAGE_TAG=latest
CURIA_POSTGRES_TAG=pg16

# Public domain for automatic HTTPS. Only used with the TLS overlay (below).
# DOMAIN=curia.example.com

# TLS overlay selection. `install.sh` sets this automatically when you choose
# the "public domain + HTTPS" option so every `docker compose` command applies
# the Caddy overlay without a manual -f flag. Uncomment to enable by hand:
# COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml
```

- [ ] **Step 5: Validate both compose configurations parse**

Run:
```bash
CURIA_IMAGE_TAG=latest CURIA_POSTGRES_TAG=pg16 DB_PASSWORD=x docker compose -f docker-compose.yml config >/dev/null && echo OK-base
DB_PASSWORD=x docker compose -f docker-compose.yml -f docker-compose.dev.yml config | grep -A2 "curia:" | grep -q "build:" && echo OK-dev-build
```
Expected: `OK-base` and `OK-dev-build`. The dev config must show a `build:` context restored; the base config must show `image: ghcr.io/josephfung/curia:latest`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.dev.yml .env.example
git commit -m "feat: image-based compose with dev build override (#1343)"
```

---

## Task A4: Optional Caddy TLS overlay

**Files:**
- Create: `docker-compose.tls.yml`
- Create: `deploy/Caddyfile`
- Reference: `curia-deploy/deploy/compose/compose.production.yaml` (existing Caddy pattern)

**Interfaces:**
- Consumes: `DOMAIN` env, the `curia` service from A3.
- Produces: an overlay that fronts `curia` with Caddy on 80/443. Selected via `COMPOSE_FILE` (A6 step wiring).

- [ ] **Step 1: Create the Caddyfile**

Create `deploy/Caddyfile`:

```
# Automatic HTTPS for Curia via Caddy + Let's Encrypt. DOMAIN is injected from
# the environment. Caddy terminates TLS and reverse-proxies to the curia service.
{$DOMAIN} {
	reverse_proxy curia:3000
}
```

- [ ] **Step 2: Create the overlay**

Create `docker-compose.tls.yml`:

```yaml
# Optional HTTPS overlay. Enable by adding this file to COMPOSE_FILE in .env
# (install.sh does this for you when you choose the public-domain option):
#   COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml
# Requires DOMAIN set and an A record pointing at this host (ports 80/443 open).
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      curia:
        condition: service_healthy

volumes:
  caddy-data:
  caddy-config:
```

- [ ] **Step 3: Validate the merged config parses**

Run:
```bash
DOMAIN=curia.example.com DB_PASSWORD=x \
  docker compose -f docker-compose.yml -f docker-compose.tls.yml config >/dev/null && echo OK-tls
```
Expected: `OK-tls`; the merged config includes a `caddy` service bound to 80/443.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.tls.yml deploy/Caddyfile
git commit -m "feat: optional Caddy HTTPS overlay for self-host (#1343)"
```

---

## Task A5: Extract `setup-common.sh` and rewire `setup.sh` for the dev override

**Files:**
- Create: `scripts/setup-common.sh`
- Modify: `scripts/setup.sh`
- Modify: `tests/setup/test-setup-functions.sh`
- Reference: `scripts/setup.sh` current functions (`validate_anthropic_key`, `prompt_anthropic_key`, `generate_secrets`, `wait_for_postgres`, `wait_for_curia`, `print_summary`)

**Interfaces:**
- Produces: `scripts/setup-common.sh` exporting the shared helpers (`validate_anthropic_key`, `prompt_anthropic_key`, `gen_secret_b64`, `gen_secret_hex`, `wait_for_postgres`, `wait_for_curia`, `print_summary`). Consumed by A6 (`install.sh` sources it).
- `setup.sh` keeps its own `main`/`run_infra`/`handle_existing_env` but sources the common helpers and adds `-f docker-compose.dev.yml` to its compose invocations.

- [ ] **Step 1: Write a failing test for the extracted secret generators**

In `tests/setup/test-setup-functions.sh`, after the existing `source` line add a source of the new file and a test. First, at the top near line 9, add:

```bash
source "$SCRIPT_DIR/../../scripts/setup-common.sh"
```

Then append these test invocations before the final PASS/FAIL summary:

```bash
echo "setup-common: secret generators"
key_b64="$(gen_secret_b64)"
# base64 of 32 bytes is 44 chars ending in '='
if [[ "${#key_b64}" -eq 44 ]]; then echo "  ✓ gen_secret_b64 length 44"; PASS=$((PASS+1)); else echo "  ✗ gen_secret_b64 length ${#key_b64}"; FAIL=$((FAIL+1)); fi
key_hex="$(gen_secret_hex)"
if [[ "${#key_hex}" -eq 64 ]]; then echo "  ✓ gen_secret_hex length 64"; PASS=$((PASS+1)); else echo "  ✗ gen_secret_hex length ${#key_hex}"; FAIL=$((FAIL+1)); fi
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash tests/setup/test-setup-functions.sh`
Expected: FAIL — `scripts/setup-common.sh` does not exist (source error) or functions undefined.

- [ ] **Step 3: Create `scripts/setup-common.sh` with the shared helpers**

Create `scripts/setup-common.sh`. Move `validate_anthropic_key`, `prompt_anthropic_key`, `wait_for_curia`, and `print_summary` here **verbatim** from `setup.sh`, and add two openssl-free generators (works on a Docker-only host):

```bash
#!/usr/bin/env bash
# Shared helpers for both installers:
#   - scripts/setup.sh  (developer / build-from-source)
#   - install.sh        (operator / pull-published-image)
# Sourced, never executed directly. Callers provide REPO_ROOT and any compose
# invocation flags they need.

# --- Colors / output helpers (copy from setup.sh: info/success/warn/error/hint) ---
# [MOVE the RED/GREEN/... color block and info()/success()/warn()/error()/hint()
#  helpers here verbatim from setup.sh, and have setup.sh rely on these.]

# 32 random bytes, base64 (vault master key format). No openssl dependency.
gen_secret_b64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# 32 random bytes, hex (api_token / bootstrap secret format).
gen_secret_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# validate_anthropic_key / prompt_anthropic_key — MOVED verbatim from setup.sh.
# wait_for_postgres / wait_for_curia / print_summary — MOVED verbatim from setup.sh.
# These call `docker compose --project-directory "$REPO_ROOT" ...`; callers set
# REPO_ROOT (setup.sh already does; install.sh sets REPO_ROOT="$INSTALL_DIR").
```

In `setup.sh`: remove the moved functions, and near the top (after the path vars) add `source "$SCRIPT_DIR/setup-common.sh"`. Replace `generate_secrets`' `openssl rand -base64 32` / `openssl rand -hex 32` calls with `gen_secret_b64` / `gen_secret_hex` (keeps setup.sh working if openssl is absent, and shares one implementation).

- [ ] **Step 4: Point setup.sh's compose calls at the dev override**

In `setup.sh`, every `docker compose --project-directory "$REPO_ROOT" <cmd>` becomes `docker compose --project-directory "$REPO_ROOT" -f docker-compose.yml -f docker-compose.dev.yml <cmd>` (so the dev path builds locally against the new image-based base). There are calls in `handle_existing_env` (option 1 up -d), `wait_for_postgres`, `wait_for_curia` (moved to common — pass a `COMPOSE_FLAGS` variable), and `run_infra` (up -d postgres, up -d). Introduce a `DEV_COMPOSE=(-f docker-compose.yml -f docker-compose.dev.yml)` array in setup.sh and pass `"${DEV_COMPOSE[@]}"`; for `wait_for_curia`/`wait_for_postgres` in common, read a caller-set `COMPOSE_FLAGS` array (default empty).

- [ ] **Step 5: Run the shell tests to verify they pass**

Run: `bash tests/setup/test-setup-functions.sh`
Expected: PASS — all existing assertions plus the two new generator assertions pass.

- [ ] **Step 6: Smoke-check setup.sh still parses**

Run: `bash -n scripts/setup.sh && bash -n scripts/setup-common.sh && echo OK`
Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add scripts/setup-common.sh scripts/setup.sh tests/setup/test-setup-functions.sh
git commit -m "refactor: extract setup-common.sh shared installer helpers (#1343)"
```

---

## Task A6: Interactive image-based `install.sh`

**Files:**
- Create: `install.sh` (repo root)
- Modify: `tests/setup/test-setup-functions.sh`
- Reference: `scripts/setup-common.sh` (A5), `docker-compose.yml`/`.env.example` (A3), `scripts/seed-vault.ts`, `package.json` migrate script

**Interfaces:**
- Consumes: `setup-common.sh` helpers; published images.
- Produces: a source-free operator install. Pure helpers `detect_source_checkout`, `resolve_env_file`, `choose_topology` are unit-tested.

- [ ] **Step 1: Write failing tests for the pure helpers**

Append to `tests/setup/test-setup-functions.sh`:

```bash
source "$SCRIPT_DIR/../../install.sh"   # guarded: defines funcs, does not run main

echo "install.sh: source-checkout detection"
tmp_src=$(mktemp -d); mkdir -p "$tmp_src/src" "$tmp_src/.git"; echo '{"name":"curia"}' > "$tmp_src/package.json"
if detect_source_checkout "$tmp_src"; then echo "  ✓ detects a curia source tree"; PASS=$((PASS+1)); else echo "  ✗ missed a curia source tree"; FAIL=$((FAIL+1)); fi
tmp_bare=$(mktemp -d)
if ! detect_source_checkout "$tmp_bare"; then echo "  ✓ bare dir is not a source tree"; PASS=$((PASS+1)); else echo "  ✗ false-positive on bare dir"; FAIL=$((FAIL+1)); fi
```

- [ ] **Step 2: Run to verify failure**

Run: `bash tests/setup/test-setup-functions.sh`
Expected: FAIL — `install.sh` missing / `detect_source_checkout` undefined.

- [ ] **Step 3: Write `install.sh`**

Create `install.sh` at the repo root. Structure (fill helper bodies as shown; reuse `setup-common.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pin to the release this installer shipped with. Bumped at release time.
CURIA_REF="${CURIA_REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/josephfung/curia/${CURIA_REF}"

# setup-common.sh may not be present when install.sh is fetched standalone; fetch
# it if missing, then source it.
if [[ ! -f "$SCRIPT_DIR/scripts/setup-common.sh" ]]; then
  mkdir -p "$SCRIPT_DIR/scripts"
  curl -fsSL "$RAW_BASE/scripts/setup-common.sh" -o "$SCRIPT_DIR/scripts/setup-common.sh"
fi
# shellcheck source=/dev/null
source "$SCRIPT_DIR/scripts/setup-common.sh"

INSTALL_DIR="$SCRIPT_DIR"
REPO_ROOT="$INSTALL_DIR"   # setup-common.sh's wait_for_postgres/wait_for_curia use this

# Returns 0 if $1 looks like a Curia source checkout (has .git + src + package.json name curia).
detect_source_checkout() {
  local d="$1"
  [[ -d "$d/.git" && -d "$d/src" ]] || return 1
  [[ -f "$d/package.json" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"curia"' "$d/package.json"
}

# Prereqs: Docker + compose + curl only.
check_prereqs() {
  docker info &>/dev/null || { error "Docker not found or not running."; hint "https://docs.docker.com/get-docker/"; exit 1; }
  docker compose version &>/dev/null || { error "docker compose plugin missing."; exit 1; }
  command -v curl &>/dev/null || { error "curl is required."; exit 1; }
}

# Fetch compose + env template + tls overlay next to install.sh if absent.
fetch_bundle() {
  local f
  for f in docker-compose.yml docker-compose.tls.yml .env.example deploy/Caddyfile; do
    if [[ ! -f "$INSTALL_DIR/$f" ]]; then
      mkdir -p "$INSTALL_DIR/$(dirname "$f")"
      curl -fsSL "$RAW_BASE/$f" -o "$INSTALL_DIR/$f"
    fi
  done
}

# Create .env from template if missing; return path. Never clobber an existing key.
resolve_env_file() {
  local env="$INSTALL_DIR/.env"
  [[ -f "$env" ]] || cp "$INSTALL_DIR/.env.example" "$env"
  printf '%s' "$env"
}

# Set KEY=VALUE in .env: replace an existing (commented or not) line, else append.
set_env_var() {
  local env="$1" key="$2" val="$3"
  if grep -qE "^#?[[:space:]]*${key}=" "$env"; then
    # portable in-place edit without sed -i portability issues
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" '
      $0 ~ "^#?[[:space:]]*"k"=" && !done { print k"="v; done=1; next } { print }
      END { if (!done) print k"="v }' "$env" > "$tmp"
    mv "$tmp" "$env"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$env"
  fi
}

# Ask topology; echo one of: local | domain | proxy. On domain, also sets DOMAIN.
choose_topology() {
  echo "" >&2
  echo "How will you reach Curia?" >&2
  echo "  1  Local / evaluation        (http://localhost:3000, no TLS)" >&2
  echo "  2  Public domain + HTTPS      (automatic Let's Encrypt via Caddy)" >&2
  echo "  3  Public IP / my own proxy   (http on :3000, terminate TLS upstream)" >&2
  read -rp "Choice [1]: " c; c="${c:-1}"
  case "$c" in
    2) echo "domain" ;;
    3) echo "proxy" ;;
    *) echo "local" ;;
  esac
}

main() {
  check_prereqs
  if detect_source_checkout "$INSTALL_DIR"; then
    echo "" >&2
    warn "This looks like the Curia source repo."
    read -rp "Pull & run the published image (i), or build from this source (s)? [i]: " m
    if [[ "${m:-i}" == "s" ]]; then
      info "Use the developer path instead:"; hint "  pnpm run setup"; exit 0
    fi
  fi
  fetch_bundle
  local env; env="$(resolve_env_file)"

  # DB creds + vault key: generate any that are still at their placeholder/missing.
  local db_pass secret_key api_token boot_secret
  db_pass="$(gen_secret_hex)"; secret_key="$(gen_secret_b64)"
  api_token="$(gen_secret_hex)"; boot_secret="$(gen_secret_hex)"
  set_env_var "$env" DB_USER curia
  set_env_var "$env" DB_PASSWORD "$db_pass"
  set_env_var "$env" DATABASE_URL "postgres://curia:${db_pass}@localhost:5432/curia"
  # Preserve an existing encryption key; only set if placeholder/empty.
  if grep -qE '^SECRET_ENCRYPTION_KEY=(replace-with|[[:space:]]*$)' "$env"; then
    set_env_var "$env" SECRET_ENCRYPTION_KEY "$secret_key"
  fi

  local anthropic; anthropic="$(prompt_anthropic_key)"

  case "$(choose_topology)" in
    domain)
      read -rp "Domain (e.g. curia.example.com): " dom
      set_env_var "$env" DOMAIN "$dom"
      set_env_var "$env" COMPOSE_FILE "docker-compose.yml:docker-compose.tls.yml"
      # Best-effort DNS warning (never blocks).
      getent hosts "$dom" >/dev/null 2>&1 || command -v host >/dev/null && host "$dom" >/dev/null 2>&1 || \
        warn "Could not resolve $dom yet — Let's Encrypt needs an A record pointing here + ports 80/443 open."
      ;;
    *) : ;;  # local / proxy: base compose, http :3000
  esac

  info "Starting Postgres..."
  docker compose --project-directory "$INSTALL_DIR" up -d postgres
  wait_for_postgres   # from setup-common.sh; uses $REPO_ROOT

  info "Applying migrations (in-container)..."
  docker compose --project-directory "$INSTALL_DIR" run --rm curia \
    ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
    --migrations-dir src/db/migrations --migration-file-language sql

  info "Seeding secrets vault (in-container)..."
  docker compose --project-directory "$INSTALL_DIR" run --rm \
    -e "ANTHROPIC_API_KEY=$anthropic" -e "API_TOKEN=$api_token" \
    -e "WEB_APP_BOOTSTRAP_SECRET=$boot_secret" -e SEED_VAULT_VERIFY=1 \
    curia ./node_modules/.bin/tsx scripts/seed-vault.ts

  info "Starting Curia..."
  docker compose --project-directory "$INSTALL_DIR" up -d
  wait_for_curia    # from setup-common.sh; uses REPO_ROOT-style project dir
  print_summary "$boot_secret"
}

# Guard: define-only when sourced (tests), run main when executed.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi
```

Note: `wait_for_curia`/`wait_for_postgres`/`print_summary` come from `setup-common.sh`; they reference the compose project dir via `$REPO_ROOT`. Set `REPO_ROOT="$INSTALL_DIR"` before calling, or adapt the common helpers to read a `PROJECT_DIR` variable (do this in A5 if cleaner). Keep the migrate/seed invocations exactly as shown (tsx direct, no pnpm).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash tests/setup/test-setup-functions.sh`
Expected: PASS — including `detect_source_checkout` cases.

- [ ] **Step 5: Lint parse**

Run: `bash -n install.sh && echo OK`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add install.sh tests/setup/test-setup-functions.sh
git commit -m "feat: interactive image-based install.sh for source-free self-host (#1343)"
```

---

## Task A7: Wire shell tests into CI

**Files:**
- Modify: `package.json` (add `test:shell` script)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI runs the setup/install shell tests so A5/A6 assertions actually gate.

- [ ] **Step 1: Add the npm script**

In `package.json` scripts, add:
```json
"test:shell": "bash tests/setup/test-setup-functions.sh"
```

- [ ] **Step 2: Make the harness exit non-zero on failure**

Confirm `tests/setup/test-setup-functions.sh` ends by exiting non-zero when `FAIL>0`. If it does not, append:
```bash
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
```

- [ ] **Step 3: Add a CI step**

In `.github/workflows/ci.yml`, in the main test job after the existing test step, add:
```yaml
      - name: Shell setup/install tests
        run: pnpm run test:shell
```

- [ ] **Step 4: Verify locally**

Run: `pnpm run test:shell; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "test: run setup/install shell tests in CI (#1343)"
```

---

## Task A8: Docs — two install paths + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/dev/setup.md` (or the closest existing setup guide)
- Modify: `README.md`

**Interfaces:** documentation only.

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` in `CHANGELOG.md`, add:
```markdown
### Added
- **GHCR image publishing** — releases now push signed, multi-arch `ghcr.io/josephfung/curia` and `ghcr.io/josephfung/curia-postgres` images; `main` pushes publish `:edge`. (#1343)
- **`install.sh`** — interactive, source-free operator installer that pulls the published image, seeds the vault in-container, and can wire up automatic HTTPS. (#1343)

### Changed
- **`docker-compose.yml`** — references published images by default; developers restore local builds with `docker-compose.dev.yml`. (#1343)
```

- [ ] **Step 2: Setup docs — two paths**

In the setup guide, document both quickstarts. Operator:
```bash
mkdir curia && cd curia
curl -fsSL https://raw.githubusercontent.com/josephfung/curia/<vX.Y.Z>/install.sh -o install.sh
# review it, then:
bash install.sh
```
Developer (unchanged): `git clone … && cd curia && pnpm run setup`. Note `docker compose pull && docker compose up -d` as the update path. No em dashes in user-facing copy.

- [ ] **Step 3: README quickstart**

Update the README quickstart to lead with the operator (image) path and link the developer path. Keep the version badge as-is (bumped at release, not here).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/dev/setup.md README.md
git commit -m "docs: document image install path + update changelog (#1343)"
```

- [ ] **Step 5: curia-docs (separate repo, note only)**

Record that `curia-docs` needs a "Self-hosting" quickstart page (epic #1281 item 5). Out of scope for this PR; flag it in the PR description as a follow-up.

---

## Part A — pre-PR review & open

- [ ] Run `pnpm run typecheck` (unchanged TS, must stay green), `pnpm test`, `pnpm run test:shell`, `pnpm run lint`.
- [ ] Run the auto-review subagents in parallel: `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` (shell error handling — the migrate/seed steps must fail loudly). Address high-priority findings.
- [ ] Open the PR with `Closes #1343`, CHANGELOG present, and the curia-docs follow-up noted. Confirm CI started (`gh run list --branch feat/ghcr-publish-1343 --limit 1`).

---

# PART B — curia-deploy repo

> Executed in a **separate worktree**. Depends on Part A being merged and `:edge` published (so `FROM ghcr.io/josephfung/curia:edge` resolves). Does **not** close #1343.

## Task B0: Create the curia-deploy worktree

- [ ] **Step 1: Pull main and branch**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy pull --ff-only origin main
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy worktree add \
  /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull -b feat/ghcr-pull-1343
```

- [ ] **Step 2: Symlink gitignored files the worktree needs**

```bash
MAIN=/Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy WORKTREE=/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull; for item in deploy/compose/.env; do if [ -e "$MAIN/$item" ]; then ln -sf "$MAIN/$item" "$WORKTREE/$item"; fi; done
```

---

## Task B1: Thin `Dockerfile.curia` (FROM the published core image)

**Files:**
- Modify: `deploy/compose/Dockerfile.curia`
- Reference: current `Dockerfile.curia` stage-2 custom blocks; core `curia/Dockerfile` (what is now inherited)

**Interfaces:**
- Produces: an image = published core + private layers. Consumed by B2/B3.

- [ ] **Step 1: Read the current file and identify the custom-only blocks**

Read `deploy/compose/Dockerfile.curia` and mark the blocks that are **NOT** in core: Chrome/patchright install, real Google Chrome install, `atproto-mcp` + `@atproto/api` pre-install, `COPY curia-deploy/custom/agents ./agents/`, `COPY curia-deploy/custom/skills ./skills/`, `COPY curia-deploy/custom/config/skills.yaml ./config/skills.yaml`, LimeZu art copy, and any instance-specific volume/dir setup. Everything else (build stage, tsup/vite builds, base deps, uv, tsx, non-root user, dist/src/scripts copies, HEALTHCHECK, CMD) is now inherited and must be deleted.

- [ ] **Step 2: Rewrite as a thin downstream image**

Replace the entire file with a single-stage image `FROM` the published core, keeping only the marked custom blocks:

```dockerfile
# Thin downstream image: pulls the published Curia core and layers only this
# instance's private extensions (browser, Bluesky MCP, licensed art, custom
# skills/agents). Core build logic now lives ONCE in curia/Dockerfile.
ARG CURIA_IMAGE_TAG=edge
FROM ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG}

# Runs as non-root `curia` (uid 1001) inherited from core. Switch to root only
# for system installs, then back.
USER root

# [KEEP verbatim from the old Dockerfile.curia: the RUN blocks that install
#  patchright/Playwright Chromium, real Google Chrome, and their apt deps.]

# [KEEP verbatim: the atproto-mcp + @atproto/api pre-install RUN block.]

# Layer in this instance's private agents/skills/config (override core files).
COPY curia-deploy/custom/agents/ ./agents/
COPY curia-deploy/custom/skills/ ./skills/
COPY curia-deploy/custom/config/skills.yaml ./config/skills.yaml

# [KEEP verbatim: the licensed LimeZu art COPY block and any chown/dir setup it needs.]

USER curia
# No CMD/HEALTHCHECK/EXPOSE — inherited from the core image.
```

Fill each `[KEEP ...]` by moving the exact lines from the current file. Do not reintroduce anything core already provides.

- [ ] **Step 3: Build against the published base to verify it resolves and layers apply**

```bash
docker build --build-arg CURIA_IMAGE_TAG=edge \
  -f deploy/compose/Dockerfile.curia -t curia-office:verify \
  /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/..
# (build context must contain curia-deploy/custom/*; adjust context per compose in B2)
docker run --rm --entrypoint ls curia-office:verify -1 ./agents ./skills | head
```
Expected: build pulls `ghcr.io/josephfung/curia:edge`, applies custom COPYs; `ls` shows custom agents/skills present.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull add deploy/compose/Dockerfile.curia
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull commit -m "refactor: thin Dockerfile.curia FROM published core image (#1343)"
```

---

## Task B2: Point compose at the published core base + shrink build context

**Files:**
- Modify: `deploy/compose/compose.production.yaml`

**Interfaces:**
- Consumes: thin Dockerfile (B1), published postgres image.
- Produces: prod stack that pulls core + builds only the thin layer. Consumed by B3.

- [ ] **Step 1: Update the `curia` service build**

In `compose.production.yaml`, change the `curia` service so its build context is `curia-deploy/` (not `/opt/curia/`) and pass `CURIA_IMAGE_TAG`:
```yaml
  curia:
    build:
      context: /opt/curia/curia-deploy/
      dockerfile: deploy/compose/Dockerfile.curia
      args:
        CURIA_IMAGE_TAG: ${CURIA_IMAGE_TAG:-edge}
```
(The `COPY curia-deploy/custom/...` paths in the Dockerfile must be adjusted to be relative to this context — i.e. `COPY custom/...`. Update B1's COPY lines to `custom/agents/` etc. to match the new context.)

- [ ] **Step 2: Point `postgres` at the published image**

If `compose.production.yaml` overlays the core `postgres` build, change it to `image: ghcr.io/josephfung/curia-postgres:${CURIA_POSTGRES_TAG:-pg16}` (matching Part A). If it inherits from the root compose only, ensure the deploy no longer relies on the core source `docker/postgres.Dockerfile` being on the VPS.

- [ ] **Step 3: Validate the merged production config parses**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull
DOMAIN=x DB_PASSWORD=x SECRET_ENCRYPTION_KEY=x DATABASE_URL=x \
  docker compose -f deploy/compose/compose.production.yaml config >/dev/null && echo OK
```
Expected: `OK` (adjust required env stubs to whatever the file references).

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull add deploy/compose/compose.production.yaml deploy/compose/Dockerfile.curia
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull commit -m "feat: production compose pulls published core, builds only thin layer (#1343)"
```

---

## Task B3: `deploy.sh` — pull the image, stop rsyncing core source

**Files:**
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Produces: a deploy that no longer needs the curia checkout on the VPS.

- [ ] **Step 1: Remove the core-source coupling**

In `scripts/deploy.sh`: delete the `CURIA_REPO`/`Dockerfile` presence checks (lines ~72-80) and the `rsync … "$CURIA_REPO/" "$SSH_HOST:$REMOTE_ROOT/curia/"` block (lines ~138-147). The `curia/` sibling on the VPS is no longer required for building.

- [ ] **Step 2: Add tag selection + explicit pull**

Near the top, add:
```bash
# Which published core image tag this deploy pulls. `edge` = newest main (dogfood);
# pin to a vX.Y.Z for a stable/rollback deploy.
CURIA_IMAGE_TAG="${CURIA_IMAGE_TAG:-edge}"
```
Before the `docker compose … build` step, add a pull so the base is fresh:
```bash
ssh "$SSH_HOST" "cd $REMOTE_ROOT && CURIA_IMAGE_TAG=$CURIA_IMAGE_TAG docker pull ghcr.io/josephfung/curia:$CURIA_IMAGE_TAG"
```
Ensure `CURIA_IMAGE_TAG` is exported into the remote compose build/up commands (it is consumed by the Dockerfile `ARG` and compose `args`).

- [ ] **Step 3: Lint**

Run: `bash -n scripts/deploy.sh && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull add scripts/deploy.sh
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull commit -m "feat: deploy pulls published core image instead of rsyncing source (#1343)"
```

---

## Task B4: validate.yml + deploy runbook

**Files:**
- Modify: `.github/workflows/validate.yml` (if it hardcodes Dockerfile expectations)
- Modify: the deploy runbook doc (update the "how deploy works" section)

- [ ] **Step 1: Confirm validate.yml still passes against the thin Dockerfile**

Run: `bash -n scripts/*.sh` and, if validate.yml lints the Dockerfile, ensure it doesn't assert on removed stages. Adjust any hardcoded expectations.

- [ ] **Step 2: Update the runbook**

Document the new model: deploy pulls `ghcr.io/josephfung/curia:$CURIA_IMAGE_TAG`, builds only the thin custom layer on the VPS, no core source on the box. Note pinning `CURIA_IMAGE_TAG=vX.Y.Z` for rollback.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull add .github/workflows/validate.yml docs/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-ghcr-pull commit -m "docs: update deploy runbook + validation for pull-based model (#1343)"
```

---

## Part B — pre-PR review, open, and end-to-end verification

- [ ] Run `pr-review-toolkit:code-reviewer` + `silent-failure-hunter` on the branch.
- [ ] Open the PR (references #1343, does not close it). Note the ordering dependency on Part A in the body.
- [ ] **End-to-end acceptance (after both merge + images publish):**
  - On a clean Docker-only VM: `curl` `install.sh`, run it, answer the Anthropic prompt, confirm `/api/health` → ok with **no source checkout**. (Acceptance 1)
  - `docker buildx imagetools inspect` shows amd64+arm64; `cosign verify` passes. (Acceptance 2)
  - `docker compose pull && docker compose up -d` across a version bump migrates unattended and is idempotent. (Acceptance 3)
  - A curia-deploy deploy pulls the image and builds only the thin layer; **no curia source rsynced**. (Acceptance 4)
  - `git clone && pnpm run setup` still builds from source. (Acceptance 5)
  - Re-running `install.sh` on an existing instance preserves the encryption key and does not rotate seeded secrets. (Acceptance 6)

---

## Self-review notes (author)

- **Spec coverage:** D1/D15 → A1,A2; D2/D3/D4/D5 → A2; D6/D7/D8/D9/D10 → A6; D11 → A5; D12/D13/D14 → B1,B2,B3; TLS (§4.2/4.3) → A4,A6; postgres image (§4.1/4.2) → A1,A2,A3.
- **Ordering:** Part B strictly after Part A (needs `:edge`). Within Part A, A1→A2 (A2 builds A1's image), A3 needs A1's baked init, A6 needs A5's helpers.
- **Openssl-free secrets:** A5 `gen_secret_b64/hex` use `/dev/urandom` so a Docker-only host needs no openssl.
- **Risk — seed/migrate must fail loudly:** flagged for `silent-failure-hunter` in both PRs; the in-container migrate/seed steps run without `|| true`.
