#!/usr/bin/env bash
# install.sh — interactive, image-based Curia installer for operators.
#
# Usage:
#   # Download first, then review, then run:
#   curl -fsSL https://raw.githubusercontent.com/josephfung/curia/main/install.sh -o install.sh
#   bash install.sh
#
# Note: piping curl directly to bash (curl … | bash) does NOT work — this
# script uses interactive `read` prompts that require a real TTY, not piped
# stdin. Always download the script first, then run it.
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
#
# Re-running on an existing install:
#   The script detects a completed install (SETUP_COMPLETE marker in .env) and
#   takes a non-rotating upgrade path: no secrets are regenerated, migrations are
#   re-applied idempotently, and seed-vault runs in verify-only mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The Git ref (tag or branch) this installer was downloaded from. Bumped at
# release time so that installs fetch matching compose files.
CURIA_REF="${CURIA_REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/josephfung/curia/${CURIA_REF}"

# setup-common.sh may not be present when install.sh is fetched standalone.
# Fetch it from the same ref if missing, then source it to get the shared output
# helpers and wait_* functions.
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

# Returns 0 (true) if the install at env file $1 is considered complete.
# Detection: the SETUP_COMPLETE marker written at the end of a fresh install,
# OR a real (non-placeholder, non-empty) DB_PASSWORD value. This covers both
# the new-style marker and any pre-marker install where the operator re-runs
# the script against an already-working DB volume.
# Returns 1 (false) for a fresh/placeholder .env that hasn't been through setup.
install_is_complete() {
  local env="$1"
  # Fastest check: marker line added at the end of every successful fresh install.
  if grep -q "^# SETUP_COMPLETE" "$env" 2>/dev/null; then
    return 0
  fi
  # Fallback: a real DB_PASSWORD (non-empty, non-placeholder) means Postgres was
  # already initialised with these creds. Regenerating would break auth against
  # the existing volume.
  local db_pass
  db_pass="$(grep -E "^DB_PASSWORD=" "$env" 2>/dev/null | cut -d= -f2-)"
  if [[ -z "$db_pass" ]]; then
    return 1
  fi
  # Treat any value that starts with "replace-" as a placeholder — the template
  # ships with "replace-with-a-strong-password" style defaults.
  case "$db_pass" in
    replace-*|"")
      return 1
      ;;
    *)
      return 0
      ;;
  esac
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
# Fresh-install path: generate secrets, prompt for keys, seed vault, mark done.
# ---------------------------------------------------------------------------
fresh_install() {
  local env="$1"

  # Generate all secrets for this install. None of these are written to .env
  # in plaintext (DB creds are the exception — they must be in .env for the
  # postgres container and migration runner to consume them). api_token and
  # boot_secret are passed only as transient env vars to the seed-vault container.
  local db_pass api_token boot_secret
  db_pass="$(gen_secret_hex)"
  api_token="$(gen_secret_hex)"
  boot_secret="$(gen_secret_hex)"

  set_env_var "$env" DB_USER curia
  set_env_var "$env" DB_PASSWORD "$db_pass"
  # Note: the compose `curia` service overrides DATABASE_URL in its environment:
  # block (pointing at the internal postgres hostname). This .env value is used
  # by the migration runner (docker compose run --rm curia), not by the app container.
  set_env_var "$env" DATABASE_URL "postgres://curia:${db_pass}@postgres:5432/curia"

  # Only generate a new encryption key if the current value is the template
  # placeholder or entirely absent/empty. A key that already exists must be
  # preserved — regenerating it makes any existing encrypted vault rows unreadable.
  if grep -qE '^SECRET_ENCRYPTION_KEY=(replace-with|[[:space:]]*$)' "$env" 2>/dev/null \
      || ! grep -qE '^SECRET_ENCRYPTION_KEY=' "$env" 2>/dev/null; then
    local secret_key
    secret_key="$(gen_secret_b64)"
    set_env_var "$env" SECRET_ENCRYPTION_KEY "$secret_key"
  fi

  # Prompt for the Anthropic key (format-validated, 3 retries). Not written to
  # .env — passed as a transient env var to the vault-seed container only.
  local anthropic
  anthropic="$(prompt_anthropic_key)"

  # Prompt for topology only on a fresh install (no COMPOSE_FILE/DOMAIN yet).
  local topology
  topology="$(choose_topology)"
  case "$topology" in
    domain)
      read -rp "Domain (e.g. curia.example.com): " dom
      set_env_var "$env" DOMAIN "$dom"
      set_env_var "$env" COMPOSE_FILE "docker-compose.yml:docker-compose.tls.yml"
      # Expose DOMAIN as a shell variable so print_summary can build the HTTPS URL.
      DOMAIN="$dom"
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

  # Start Postgres and wait for it to be ready before running migrations.
  info "Starting Postgres..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d postgres; then
    error "Failed to start the Postgres container."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs postgres"
    exit 1
  fi
  wait_for_postgres  # from setup-common.sh; uses $REPO_ROOT

  # Run migrations inside the pulled image (tsx direct — no host pnpm needed).
  info "Applying database migrations (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" run --rm curia \
    ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
    --migrations-dir src/db/migrations --migration-file-language sql; then
    error "Database migration failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Seed the encrypted vault with the freshly generated secrets. Secrets are
  # passed as transient env vars so they never land on disk in plaintext.
  # SEED_VAULT_VERIFY=1 makes seed-vault confirm required rows exist and exit
  # non-zero if any are missing — so a partial seed fails loudly here rather
  # than booting a half-configured instance with auth disabled.
  info "Seeding secrets vault (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" run --rm \
    -e "ANTHROPIC_API_KEY=$anthropic" \
    -e "API_TOKEN=$api_token" \
    -e "WEB_APP_BOOTSTRAP_SECRET=$boot_secret" \
    -e SEED_VAULT_VERIFY=1 \
    curia ./node_modules/.bin/tsx scripts/seed-vault.ts; then
    error "Vault seeding failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Bring the full stack up and wait for the app to become healthy.
  info "Starting Curia..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d; then
    error "Failed to start the Curia stack."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs"
    exit 1
  fi
  if ! wait_for_curia; then
    error "Curia did not become healthy — refusing to print a success banner."
    hint "Check logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Mark setup as complete. On subsequent re-runs, install_is_complete() sees
  # this marker and takes the upgrade path instead of rotating secrets.
  printf '\n# SETUP_COMPLETE\n' >> "$env"

  print_summary "$boot_secret"
}

# ---------------------------------------------------------------------------
# Existing-install path: upgrade / restart without rotating any secret.
# ---------------------------------------------------------------------------
existing_install() {
  local env="$1"
  info "Existing install detected — running in upgrade/restart mode."
  info "No secrets will be regenerated."

  # Re-apply migrations idempotently. node-pg-migrate skips already-applied
  # migrations, so this is safe on every re-run.
  info "Applying database migrations (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d postgres; then
    error "Failed to start the Postgres container."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs postgres"
    exit 1
  fi
  wait_for_postgres

  if ! docker compose --project-directory "$INSTALL_DIR" run --rm curia \
    ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
    --migrations-dir src/db/migrations --migration-file-language sql; then
    error "Database migration failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Verify-only vault seed: pass NO secret env vars so seed-vault does not
  # rotate any existing row. SEED_VAULT_VERIFY=1 confirms the required rows
  # (anthropic_api_key, api_token, web_app_bootstrap_secret) are present and
  # decryptable. If any are missing the re-run fails loudly — the operator
  # should run a fresh install from a clean install dir in that case.
  info "Verifying secrets vault (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" run --rm \
    -e SEED_VAULT_VERIFY=1 \
    curia ./node_modules/.bin/tsx scripts/seed-vault.ts; then
    error "Vault verification failed — required secrets may be missing."
    hint "Re-run a fresh install from a clean directory if secrets were lost."
    exit 1
  fi

  info "Starting Curia..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d; then
    error "Failed to start the Curia stack."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs"
    exit 1
  fi
  if ! wait_for_curia; then
    error "Curia did not become healthy — refusing to print a success banner."
    hint "Check logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # If the existing install used the domain topology, load DOMAIN into the shell
  # so print_summary can show the correct HTTPS URL instead of localhost.
  if grep -qE '^DOMAIN=.+' "$env" 2>/dev/null; then
    DOMAIN="$(grep -E '^DOMAIN=' "$env" | cut -d= -f2-)"
  fi

  # Pass empty string: print_summary then shows the "secret is stored in the
  # vault — use the console to retrieve it" branch rather than printing a
  # fresh secret (which we don't have on the upgrade path).
  print_summary ""
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

  # Detect whether this is a re-run against an already-completed install.
  # If so, take the non-rotating upgrade path; otherwise run fresh install.
  if install_is_complete "$env"; then
    existing_install "$env"
  else
    fresh_install "$env"
  fi
}

# Guard: when sourced (e.g. by the test harness), only define functions above.
# When executed directly, run main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
