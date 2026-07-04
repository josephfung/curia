# Publish semver-tagged images to GHCR + interactive image-based install

**Issue:** [#1343](https://github.com/josephfung/curia/issues/1343)
**Epic:** [#1281 — open-core self-hosting](https://github.com/josephfung/curia/issues/1281)
**Date:** 2026-07-04
**Status:** Design — awaiting review

---

## 1. Objective

Two concrete goals, in priority order:

1. **Publish each Curia release as a versioned container image** to a public registry (GHCR), so an operator can run a released Curia without a source checkout or a Node/pnpm toolchain.
2. **Eliminate the core-Dockerfile duplication in `curia-deploy`.** Today `curia-deploy/deploy/compose/Dockerfile.curia` is a ~330-line near-copy of `curia/Dockerfile`; the two drift and have hit the same bugs independently. Publishing lets `curia-deploy` consume the core image via a thin `FROM` layer.

Everyday install becomes: **download one `install.sh`, run it, answer one prompt (the Anthropic key), and a working Curia comes up from the published image.**

Non-goal restatement (from the epic): this is *not* npm/brew distribution of the product. A container registry is the right channel for a stateful, Postgres-backed server app.

## 2. Current state (baseline)

- **Two divergent Dockerfiles.** `curia/Dockerfile` (core) is built only for local `docker-compose up` and CI security scans — **never published**. `curia-deploy/deploy/compose/Dockerfile.curia` is a near-copy that additionally layers custom agents/skills, Chrome/patchright, atproto-mcp, and licensed LimeZu art.
- **Deploy is a source-build model.** `curia-deploy/scripts/deploy.sh` rsyncs the *local* `repos/curia` checkout to the VPS and runs `docker compose build` on the server. No registry, no pull.
- **Migrations already auto-run on container boot** — `src/index.ts` (~L291) runs node-pg-migrate programmatically under an advisory lock before service init. (#1344's runtime half is effectively already true.)
- **Secrets are vault-only.** `src/secrets/apply-vault-secrets.ts` resolves `anthropic_api_key`, `api_token`, `web_app_bootstrap_secret`, etc. from the encrypted `secrets` table with **no env fallback**. Boot **fatal-exits** without `api_token` (`src/index.ts:339`) or `anthropic_api_key` (`src/index.ts:418`). The vault is populated by `scripts/seed-vault.ts`, invoked by the interactive `scripts/setup.sh` **host-side** (needs source + Node + pnpm).
- **Interactive installer exists.** `scripts/setup.sh` already prompts for the Anthropic key, generates the other secrets, writes the vault-unlock `.env`, runs migrations + seed-vault host-side, brings up the stack, and prints a summary. It is built for the **source-checkout** model.
- **Version 0.39.0**, manual bump. `release.yml` fires on GitHub release `published` and produces a signed SBOM + source tarball — no image push.

## 3. Design decisions (with rationale)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Publish `curia/Dockerfile` to GHCR as the **single source of truth**. | Kills the two-Dockerfile drift. |
| D2 | Tags: **`vX.Y.Z` + `latest`** on release published; **`edge`** on every push to main. | `edge` preserves fast merge→deploy cadence without cutting a release; `vX.Y.Z`/`latest` are the stable self-host tags. |
| D3 | Multi-arch **`linux/amd64` + `linux/arm64`** via buildx. | Covers cloud VPS (amd64) and Apple Silicon / ARM self-hosters. |
| D4 | **cosign keyless-sign** the image + **SPDX SBOM attestation**. | Matches `release.yml`'s existing OIDC-identity posture; provenance for the self-host credibility goal. |
| D5 | GHCR package is **public** (anonymous pull). | The point of the epic. One-time package-visibility setting. |
| D6 | Everyday operator installs via an **interactive, image-based `install.sh`** (download one file, run it). | A detached `docker compose up -d` container cannot prompt (no TTY); an interactive installer can. Keeps the excellent setup.sh UX but retargets it to the pulled image. |
| D7 | `install.sh` runs **migrate + seed-vault *inside the pulled image*** (`docker compose run --rm curia …`), not host-side. | Operator has no source/Node/pnpm. The image already contains the migration runner, `scripts/seed-vault.ts`, and `node_modules`. Invoke `tsx` directly (the runtime image deliberately avoids corepack). |
| D8 | **No change to core secret-handling.** The vault is seeded by `install.sh` *before* boot, so the container always boots against a populated vault (as prod does today). | Smallest blast radius on core — no `bootstrapSecretsFromEnv` in `src/index.ts`. |
| D9 | `SECRET_ENCRYPTION_KEY` is **required in `.env`**, but `install.sh` **auto-generates it** (`head -c 32 /dev/urandom | base64`) if absent, and **preserves** an existing one. | At-rest: never written to the data volume (unlike auto-gen-to-volume); a DB dump stays pure ciphertext. Key custody: operator can back it up and restore on a fresh host. Generating in the installer keeps "set one key" UX while keeping the key off the data volume. |
| D10 | `.env` is an **optional input**: append/update if present, create from template if absent. | Operator convenience; don't clobber an existing key. |
| D11 | Developer path unchanged: `git clone && pnpm run setup` (source build). Shared logic extracted to `scripts/setup-common.sh`. | Contributor muscle-memory preserved; DRY across the two installers. |
| D12 | `curia-deploy/Dockerfile.curia` → `FROM ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG}` + private layers only. | Removes ~250 lines of duplicated core build. |
| D13 | The thin downstream (custom) image is **built on the VPS**, not pushed to any registry. | Private custom code + licensed LimeZu art never enter a registry. Minimal change from today (just drops the core-source rsync). |
| D14 | `deploy.sh` **stops rsyncing the curia source**; syncs only `curia-deploy`, pulls the base tag, rebuilds the fast thin layer, `up -d`. `CURIA_IMAGE_TAG` defaults to `edge` / pins `vX.Y.Z`. | The "curia checkout on the VPS" concept goes away. Dogfoods the published image. |

### Deferred / out of scope (recorded, not built)

- **Web onboarding** (boot degraded without an Anthropic key → enter it in a browser setup wizard). This is the true zero-secret-env path but belongs to #771: the app currently fatal-exits without a key and the setup wizard doesn't accept API keys. Captured as the follow-on.
- **Volume-mount custom layering** (epic #3's alternative). We use the downstream-image path, which our Chrome/atproto *system* deps require anyway. This resolves the epic's open question: downstream-image is the blessed path.
- **Extension-contract versioning** (#4), **docs page** (#5), migrate-idempotency hardening beyond what exists (#1344).

## 4. Components & changes

### 4.1 curia repo — publish workflow
**New:** `.github/workflows/docker-publish.yml`

- Triggers: `release: [published]` and `push: [main]` (and `workflow_dispatch` for manual/backfill).
- Auth: `GITHUB_TOKEN` with `packages: write`, `id-token: write` (OIDC for cosign), `contents: read`.
- Steps: `docker/setup-qemu-action` + `docker/setup-buildx-action` → `docker/login-action` (ghcr.io) → `docker/metadata-action` (derive tags: `vX.Y.Z`+`latest` from the release tag, or `edge` from main) → `docker/build-push-action` (`platforms: linux/amd64,linux/arm64`, `provenance: true`, `push: true`) → `cosign sign` (keyless) → `anchore/sbom-action` + `cosign attest` SBOM.
- Tag-name validation mirrors `release.yml`'s injection guard (strict semver regex on the release tag).

### 4.2 curia repo — self-host bundle (repo root)
- **New:** `docker-compose.yml` — image-based:
  - `curia`: `image: ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG:-latest}`, port `3000:3000`, `depends_on: postgres (healthy)`, healthcheck on `/api/health`, named volumes for runtime state, env from `.env`.
  - `postgres`: `pgvector/pgvector:pg16`, named volume `curia-pgdata`, healthcheck `pg_isready`.
  - No Caddy in the minimal file (TLS is a documented production add-on).
- **New:** `.env.example` — the vault-unlock set (`DB_USER`, `DB_PASSWORD`, `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`) + non-secret config (`DOMAIN`, `HTTP_PORT`, `TIMEZONE`, `LOG_LEVEL`, `CURIA_IMAGE_TAG`), with the encryption-key one-liner documented. This is the template `install.sh` renders and the standalone reference for hand-configurers.
- **New:** `docker-compose.dev.yml` — a build-context override so the developer/source path builds locally instead of pulling.

### 4.3 curia repo — installers
- **New:** `install.sh` (root) — the everyday operator entry (image-based, interactive). Responsibilities:
  1. Prereq check: **Docker + docker compose + curl** only.
  2. Fetch version-pinned `docker-compose.yml` (+ `.env.example`) if absent.
  3. Prompt for the Anthropic key (validated `sk-ant-…`).
  4. Resolve `.env`: create from template if absent, else append/update; preserve an existing `SECRET_ENCRYPTION_KEY`, generate one if missing.
  5. Generate `API_TOKEN`, `WEB_APP_BOOTSTRAP_SECRET`.
  6. `docker compose up -d postgres` → wait healthy.
  7. **One-shot migrate in-container:** `docker compose run --rm curia ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up --migrations-dir src/db/migrations --migration-file-language sql` (DATABASE_URL from compose env).
  8. **Seed vault in-container:** `docker compose run --rm -e ANTHROPIC_API_KEY -e API_TOKEN -e WEB_APP_BOOTSTRAP_SECRET -e SEED_VAULT_VERIFY=1 curia ./node_modules/.bin/tsx scripts/seed-vault.ts`.
  9. `docker compose up -d` → poll `/api/health` → print summary box (show the web login secret once).
- **Refactor:** `scripts/setup.sh` (dev/source) — keep behavior; its host-side migrate + seed logic stays for the source path. Extract shared prompt/gen/health-poll/summary into:
- **New:** `scripts/setup-common.sh` — sourced by both `setup.sh` and `install.sh`.

Note the chicken-and-egg the one-shot migrate solves: `seed-vault` needs the `secrets` table, but a full boot fatal-exits before healthy without `api_token`. Running migrate in a throwaway container first creates the schema without booting the app.

### 4.4 curia-deploy repo — thin downstream image + pull-based deploy
- **Rewrite:** `deploy/compose/Dockerfile.curia` → `FROM ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG}` then only: install Chrome/patchright, atproto-mcp + `@atproto/api`, `COPY custom/agents|skills|config`, LimeZu art copy, volume/dir setup unique to our instance. Drop everything the base image already provides (build stage, tsup/vite builds, base deps, uv, tsx, non-root user — inherited).
- **Edit:** `scripts/deploy.sh` — remove the `repos/curia` rsync and the `Dockerfile` presence check; add `CURIA_IMAGE_TAG` (default `edge`) and `docker pull ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG}` before build; keep the thin-layer build on the VPS. The `curia/` sibling directory on the VPS is no longer required.
- **Edit:** `deploy/compose/compose.production.yaml` — its `curia` service already sets `build.dockerfile: …/Dockerfile.curia` with context `/opt/curia/`; adjust so the build context is just `curia-deploy/` (custom + Dockerfile), no core source needed. Base image pinned via `CURIA_IMAGE_TAG`.
- `Dockerfile.signal-cli` untouched (no core duplication).

## 5. What belongs in core vs the downstream image

| Concern | Public core image | Downstream (curia-deploy) |
|---------|-------------------|---------------------------|
| Backend build (tsup), console + antfarm (vite) | ✅ | inherited |
| Base deps, uv/uvx (workspace-mcp), tsx, non-root user | ✅ | inherited |
| Migrations, seed-vault script, scripts/ | ✅ | inherited |
| Chrome / patchright (web-browser skill) | ❌ | ✅ |
| atproto-mcp, `@atproto/api` (Bluesky) | ❌ | ✅ |
| Licensed LimeZu art | ❌ (license) | ✅ (built on VPS only) |
| Custom agents / skills / `config/skills.yaml` | ❌ | ✅ |

A bare core self-hoster therefore gets a working Curia **without** the browser or Bluesky skills — acceptable for #1343 ("a working Curia"). Those are instance-specific extensions.

## 6. Revised acceptance criteria

1. A clean machine with **only Docker** installed can: download `install.sh`, run it, answer the Anthropic-key prompt, and reach a **healthy** Curia (`/api/health` → ok) from the **published GHCR image** — **no source checkout, no host Node/pnpm, no manual SQL**.
2. The published image is **multi-arch** (amd64+arm64), **cosign-signed**, and carries an **SBOM attestation**; the GHCR package is publicly pullable.
3. `docker compose pull && docker compose up -d` across a version bump brings up the new image and auto-applies migrations unattended.
4. `curia-deploy` deploys by **pulling** `ghcr.io/josephfung/curia:<tag>` and building only the thin custom layer on the VPS — **no curia source is rsynced**; the two Dockerfiles no longer duplicate core build logic.
5. The developer path (`git clone && pnpm run setup`) still builds and runs from source.
6. Seeding is **idempotent**: re-running `install.sh` against an existing instance does not clobber the encryption key or rotate already-seeded secrets.

## 7. Risks & mitigations

- **Bad migration ships in an image that auto-migrates on boot** (harder to hot-patch than an rsync'd tree; cf. migration 070 crash-loop). *Mitigation:* migrations are advisory-locked and idempotent; docs prescribe a DB backup before `docker compose pull` (folds into #1344); `edge` catches migration breakage before a release tag.
- **Losing the ability to deploy un-merged local HEAD to prod.** *Accepted:* `edge` (built on every main push) covers merged-but-unreleased code; truly un-merged WIP should go through a PR. (No `--local` escape hatch in this iteration.)
- **Multi-arch CI cost (~2× via QEMU).** *Accepted* for reach; revisit if build minutes bite.
- **Registry outage blocks deploy/pull.** *Mitigation:* pinning `CURIA_IMAGE_TAG` to a `vX.Y.Z` that's already local avoids re-pull; GHCR availability is acceptable for this stage.
- **`.env` secret at-rest.** `SECRET_ENCRYPTION_KEY` stays out of the DB/volume; operator is advised to back it up. Full-host-compromise is out of scope (equivalent for any .env-based app).

## 8. Open questions for review

- Should `docker-compose.yml` include an **optional Caddy TLS overlay** now (as a separate `docker-compose.tls.yml`), or leave TLS entirely to docs?
- Confirm the GHCR image name: `ghcr.io/josephfung/curia` (owner `josephfung`).
- `curia-deploy` currently builds the thin layer on the VPS. Is a `docker pull`-only future (private registry) worth a follow-up, or is on-VPS build the durable answer?
