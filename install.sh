#!/usr/bin/env bash
# install.sh — interactive, image-based Curia installer for operators.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/josephfung/curia/main/install.sh | bash
#   -- or --
#   bash install.sh
#
# Requirements: Docker (with the compose plugin) + curl only.
# No Node, pnpm, or openssl is required on the host — everything runs inside
# the published container image.
#
# What this script does:
#   1. Checks for Docker + compose + curl.
#   2. Fetches docker-compose.yml, the TLS overlay, .env.example, and the
#      Caddyfile next to install.sh (if not already present).
#   3. Creates .env from the example, generating secrets for any placeholder values.
#   4. Prompts for an Anthropic API key (format-validated, 3 retries).
#   5. Asks about deployment topology (local / public HTTPS / behind-proxy).
#   6. Starts Postgres, runs migrations and vault-seed *inside* the pulled image
#      (tsx direct — no corepack/pnpm on the host), then brings the full stack up.
#   7. Prints a summary box with the bootstrap secret the operator needs to sign in.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The Git ref (tag or branch) this installer was downloaded from. Bumped at
# release time so that curl-piped installs fetch matching compose files.
CURIA_REF="${CURIA_REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/josephfung/curia/${CURIA_REF}"

# setup-common.sh may not be present when install.sh is fetched standalone (the
# operator ran `curl … | bash`). Fetch it from the same ref if missing, then
# source it to get the shared output helpers and wait_* functions.
if [[ ! -f "$SCRIPT_DIR/scripts/setup-common.sh" ]]; then
  mkdir -p "$SCRIPT_DIR/scripts"
  curl -fsSL "$RAW_BASE/scripts/setup-common.sh" -o "$SCRIPT_DIR/scripts/setup-common.sh"
fi
# shellcheck source=/dev/null
source "$SCRIPT_DIR/scripts/setup-common.sh"

# setup-common.sh's wait_for_postgres / wait_for_curia look up the compose
# project via $REPO_ROOT. For the image-based install, the install dir IS the
# project root (docker-compose.yml lives alongside install.sh).
INSTALL_DIR="$SCRIPT_DIR"
REPO_ROOT="$INSTALL_DIR"

# No extra compose file flags for the operator path (the dev overlay is not
# used here). COMPOSE_FLAGS is read by wait_for_postgres/wait_for_curia.
COMPOSE_FLAGS=()

# ---------------------------------------------------------------------------
# Pure helpers (unit-tested via tests/setup/test-setup-functions.sh)
# ---------------------------------------------------------------------------

# Returns 0 if $1 looks like a Curia source checkout:
#   - has a .git directory (it's a git repo)
#   - has a src/ directory (Curia's TypeScript sources live here)
#   - has a package.json whose "name" field is "curia"
# Returns 1 otherwise. Used to warn operators who accidentally ran install.sh
# inside a developer clone and offer them the right path.
detect_source_checkout() {
  local d="$1"
  [[ -d "$d/.git" && -d "$d/src" ]] || return 1
  [[ -f "$d/package.json" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"curia"' "$d/package.json"
}

# Set KEY=VALUE in the .env file at path $1.
#   - If the key already exists (commented or uncommented), replace that line.
#   - If the key is absent, append it.
# Uses awk for a portable in-place edit that avoids sed -i portability issues
# between GNU and BSD sed.
set_env_var() {
  local env="$1" key="$2" val="$3"
  if grep -qE "^#?[[:space:]]*${key}=" "$env"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" '
      $0 ~ "^#?[[:space:]]*"k"=" && !done { print k"="v; done=1; next }
      { print }
      END { if (!done) print k"="v }' "$env" > "$tmp"
    mv "$tmp" "$env"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$env"
  fi
}

# ---------------------------------------------------------------------------
# Non-interactive helpers (not unit-tested; rely on Docker or filesystem state)
# ---------------------------------------------------------------------------

# Validate prereqs: Docker daemon up, compose plugin present, curl available.
# The operator path deliberately does NOT require Node, pnpm, or openssl.
check_prereqs() {
  docker info &>/dev/null || {
    error "Docker not found or not running."
    hint "Install Docker Desktop: https://docs.docker.com/get-docker/"
    exit 1
  }
  docker compose version &>/dev/null || {
    error "docker compose plugin is missing."
    hint "Make sure you have Docker 20.10+ with the Compose plugin."
    exit 1
  }
  command -v curl &>/dev/null || {
    error "curl is required but not found."
    exit 1
  }
}

# Fetch the compose bundle (base compose file, TLS overlay, env template,
# Caddyfile) into the install dir, skipping files that are already present.
# This lets an operator re-run install.sh safely without clobbering hand-edits.
fetch_bundle() {
  local f
  for f in docker-compose.yml docker-compose.tls.yml .env.example deploy/Caddyfile; do
    if [[ ! -f "$INSTALL_DIR/$f" ]]; then
      mkdir -p "$INSTALL_DIR/$(dirname "$f")"
      info "Fetching $f ..."
      curl -fsSL "$RAW_BASE/$f" -o "$INSTALL_DIR/$f"
    fi
  done
}

# Create .env from the template if it does not exist yet, then return its path.
# Never overwrites an existing .env — idempotent.
resolve_env_file() {
  local env="$INSTALL_DIR/.env"
  if [[ ! -f "$env" ]]; then
    cp "$INSTALL_DIR/.env.example" "$env"
  fi
  printf '%s' "$env"
}

# Prompt for deployment topology. Echoes one of: local | domain | proxy.
# Runs interactively; not unit-tested (requires a TTY and user input).
choose_topology() {
  echo "" >&2
  echo "How will you reach Curia?" >&2
  echo "  1  Local / evaluation        (http://localhost:3000, no TLS)" >&2
  echo "  2  Public domain + HTTPS      (automatic Let's Encrypt via Caddy)" >&2
  echo "  3  Public IP / my own proxy   (http on :3000, terminate TLS upstream)" >&2
  read -rp "Choice [1]: " c
  c="${c:-1}"
  case "$c" in
    2) echo "domain" ;;
    3) echo "proxy" ;;
    *) echo "local" ;;
  esac
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  check_prereqs

  # If we're running from inside the Curia source tree, warn the operator and
  # offer to proceed with the image path or redirect to the developer setup.
  if detect_source_checkout "$INSTALL_DIR"; then
    echo "" >&2
    warn "This looks like the Curia source repository."
    echo "  The image-based installer works here, but most developers prefer" >&2
    echo "  the source build path which hot-reloads changes." >&2
    read -rp "Pull & run the published image (i), or use source build (s)? [i]: " m
    if [[ "${m:-i}" == "s" ]]; then
      info "Use the developer setup instead:"
      hint "  pnpm run setup"
      exit 0
    fi
  fi

  fetch_bundle

  local env
  env="$(resolve_env_file)"

  # ----- Generate secrets -----
  # Always generate fresh values. set_env_var will replace placeholder lines in
  # the template, or append if the key was somehow removed.
  local db_pass api_token boot_secret
  db_pass="$(gen_secret_hex)"
  api_token="$(gen_secret_hex)"
  boot_secret="$(gen_secret_hex)"

  set_env_var "$env" DB_USER curia
  set_env_var "$env" DB_PASSWORD "$db_pass"
  # "postgres" here is the Docker Compose service name, not localhost — migrate/seed
  # run inside the container on the compose network where that hostname resolves.
  set_env_var "$env" DATABASE_URL "postgres://curia:${db_pass}@postgres:5432/curia"

  # Preserve a previously-generated encryption key so that existing encrypted
  # vault rows remain readable on re-runs. Only generate a new key if the
  # current value is the template placeholder or entirely absent/empty.
  if grep -qE '^SECRET_ENCRYPTION_KEY=(replace-with|[[:space:]]*$)' "$env" 2>/dev/null \
      || ! grep -qE '^SECRET_ENCRYPTION_KEY=' "$env" 2>/dev/null; then
    local secret_key
    secret_key="$(gen_secret_b64)"
    set_env_var "$env" SECRET_ENCRYPTION_KEY "$secret_key"
  fi

  # ----- Anthropic key -----
  local anthropic
  anthropic="$(prompt_anthropic_key)"

  # ----- Topology -----
  local topology
  topology="$(choose_topology)"
  case "$topology" in
    domain)
      read -rp "Domain (e.g. curia.example.com): " dom
      set_env_var "$env" DOMAIN "$dom"
      set_env_var "$env" COMPOSE_FILE "docker-compose.yml:docker-compose.tls.yml"
      # Best-effort DNS warning; never blocks the install.
      if ! getent hosts "$dom" >/dev/null 2>&1; then
        if command -v host >/dev/null 2>&1; then
          host "$dom" >/dev/null 2>&1 || \
            warn "Could not resolve $dom. Let's Encrypt requires a DNS A record pointing here + ports 80/443 open."
        else
          warn "Could not verify DNS for $dom. Make sure an A record points here and ports 80/443 are open."
        fi
      fi
      ;;
    *) : ;;  # local / proxy: base compose only, HTTP on :3000
  esac

  # ----- Start Postgres and wait -----
  info "Starting Postgres..."
  docker compose --project-directory "$INSTALL_DIR" up -d postgres
  wait_for_postgres  # from setup-common.sh; uses $REPO_ROOT

  # ----- Migrations (inside the pulled image, tsx direct — no host pnpm) -----
  info "Applying database migrations (in-container)..."
  docker compose --project-directory "$INSTALL_DIR" run --rm curia \
    ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
    --migrations-dir src/db/migrations --migration-file-language sql

  # ----- Vault seed (inside the pulled image) -----
  # Pass secrets as environment variables so they never touch the filesystem in
  # plaintext. SEED_VAULT_VERIFY=1 causes seed-vault.ts to read back every
  # secret and fail loudly if any is missing or corrupt.
  info "Seeding secrets vault (in-container)..."
  docker compose --project-directory "$INSTALL_DIR" run --rm \
    -e "ANTHROPIC_API_KEY=$anthropic" \
    -e "API_TOKEN=$api_token" \
    -e "WEB_APP_BOOTSTRAP_SECRET=$boot_secret" \
    -e SEED_VAULT_VERIFY=1 \
    curia ./node_modules/.bin/tsx scripts/seed-vault.ts

  # ----- Bring the full stack up -----
  info "Starting Curia..."
  docker compose --project-directory "$INSTALL_DIR" up -d
  wait_for_curia  # from setup-common.sh; uses $REPO_ROOT

  print_summary "$boot_secret"
}

# Guard: when sourced (e.g. by the test harness), only define functions above.
# When executed directly, run main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
