#!/usr/bin/env bash
set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

# Load shared installer helpers (colors, output, secret generators, wait_*, print_summary).
# setup-common.sh must be sourced after REPO_ROOT is set — the wait_* helpers reference it.
source "$SCRIPT_DIR/setup-common.sh"

# Compose flags for the dev (build-from-source) path. The base docker-compose.yml
# defines the service topology; docker-compose.dev.yml overlays the build: context so
# the stack builds the local image rather than pulling a published one.
DEV_COMPOSE=(-f docker-compose.yml -f docker-compose.dev.yml)

# The wait_* helpers in setup-common.sh read COMPOSE_FLAGS (array) for extra compose
# file flags. Point them at the dev override so they query the correct project.
COMPOSE_FLAGS=("${DEV_COMPOSE[@]}")

# Global: set by handle_existing_env to control main() flow
SETUP_MODE="full"  # "full" | "resume"
# Global: set by handle_existing_env when the vault key should be preserved across
# a full reset (Postgres data is NOT wiped, so existing encrypted rows must stay readable)
PRESERVED_ENCRYPTION_KEY=""
# Global: set by main() from the prompted Anthropic key, consumed by run_infra to
# seed the vault (#911). Empty on the resume path (vault already seeded on first run).
SEED_ANTHROPIC_KEY=""

# Verifies docker, docker compose, node >= 24, and pnpm are available.
# Exits 1 with an install link on the first missing tool.
# (openssl check removed — secret generation now uses /dev/urandom via gen_secret_b64/hex)
check_prerequisites() {
    if ! docker info &>/dev/null; then
        error "docker not found or not running."
        hint "Install at: https://docs.docker.com/get-docker/"
        exit 1
    fi

    if ! docker compose version &>/dev/null 2>&1; then
        error "docker compose plugin not available."
        hint "Docker Compose ships with Docker Desktop: https://docs.docker.com/get-docker/"
        exit 1
    fi

    if ! command -v node &>/dev/null; then
        error "node not found (requires >= 24)."
        hint "Install at: https://nodejs.org/"
        exit 1
    fi
    local node_major
    node_major=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ -z "$node_major" ]] || [[ "$node_major" -lt 24 ]]; then
        error "Node $(node --version) found, but >= 24 is required."
        hint "Update at: https://nodejs.org/"
        exit 1
    fi

    if ! command -v pnpm &>/dev/null; then
        error "pnpm not found."
        hint "Install at: https://pnpm.io/installation"
        exit 1
    fi
}

# Populates global secret variables using /dev/urandom (no openssl dependency).
generate_secrets() {
    DB_USER="curia"
    DB_PASSWORD=$(gen_secret_hex)
    API_TOKEN=$(gen_secret_hex)
    WEB_APP_BOOTSTRAP_SECRET=$(gen_secret_hex)
    # Reuse a preserved key if one exists (full reset keeps Postgres data, so the
    # vault key must stay the same or existing encrypted rows become unreadable).
    if [[ -n "${PRESERVED_ENCRYPTION_KEY:-}" ]]; then
        SECRET_ENCRYPTION_KEY="$PRESERVED_ENCRYPTION_KEY"
    else
        SECRET_ENCRYPTION_KEY=$(gen_secret_b64)
    fi
    # DATABASE_URL is consumed by host-side `pnpm migrate` (against the postgres
    # container's published port), so the port here must match POSTGRES_PORT.
    # When unset, both default to 5432. Keep this in lockstep with the postgres
    # service's `ports:` line in docker-compose.yml.
    local pg_host_port="${POSTGRES_PORT:-5432}"
    DATABASE_URL="postgres://curia:${DB_PASSWORD}@localhost:${pg_host_port}/curia"
}

# Templates ENV_EXAMPLE into ENV_FILE, substituting the four bootstrap secrets.
# Optional vars remain commented.
write_env() {
    # ANTHROPIC_API_KEY / API_TOKEN / WEB_APP_BOOTSTRAP_SECRET are NOT written here —
    # they are seeded into the encrypted vault after migrations (#911). Only the four
    # values needed to reach and unlock the vault live in .env.
    sed \
        -e "s|^DB_USER=.*|DB_USER=${DB_USER}|" \
        -e "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" \
        -e "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" \
        -e "s|^SECRET_ENCRYPTION_KEY=.*|SECRET_ENCRYPTION_KEY=${SECRET_ENCRYPTION_KEY}|" \
        "$ENV_EXAMPLE" > "$ENV_FILE"
}

# Shown when .env already exists. Returns with SETUP_MODE set based on choice.
# Choice 1 exits the script entirely (user starts stack manually). Choices 2 & 3 return.
handle_existing_env() {
    local has_completed=""
    if grep -q "^# SETUP_COMPLETE" "$ENV_FILE" 2>/dev/null; then
        has_completed=1
    fi

    echo "" >&2
    echo "Your .env already exists. Looks like you've been here before." >&2
    echo "" >&2
    # Default to option 2 if setup never completed (safer than starting a stack without migrations).
    local default_choice="1"
    if [[ -z "$has_completed" ]]; then
        default_choice="2"
    fi

    if [[ "$default_choice" == "1" ]]; then
        echo "  1  Start the stack      → docker compose up -d            (default)" >&2
    else
        echo "  1  Start the stack      → docker compose up -d" >&2
    fi
    echo "  2  Resume setup         → re-run infra with existing .env" >&2
    if [[ -z "$has_completed" ]]; then
        echo -e "     ${YELLOW}↑ Setup didn't finish last time — this is probably what you want (default)${RESET}" >&2
    fi
    echo -e "  3  Full reset           → ${YELLOW}⚠${RESET}  regenerates secrets, invalidates active sessions" >&2
    echo "" >&2
    read -rp "Choice [$default_choice]: " choice
    choice="${choice:-$default_choice}"

    case "$choice" in
        1)
            # User chose to start stack manually — exit setup
            info "Starting the stack..."
            hint "You can also run this directly: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d"
            docker compose --project-directory "$REPO_ROOT" "${DEV_COMPOSE[@]}" up -d
            success "Stack is up."
            exit 0
            ;;
        2)
            # Resume mode: keep existing .env and re-run infra
            SETUP_MODE="resume"
            ;;
        3)
            # Full reset: delete .env and regenerate everything
            echo "" >&2
            warn "This will regenerate all secrets. Any active sessions will be invalidated."
            read -rp "Type 'yes' to confirm: " confirm
            if [[ "$confirm" != "yes" ]]; then
                echo "Aborted." >&2
                exit 0
            fi
            # Preserve the vault encryption key so existing rows remain readable.
            # A full reset does NOT wipe the Postgres volume — generating a new key
            # would make all previously stored vault secrets permanently unreadable.
            PRESERVED_ENCRYPTION_KEY=$(grep "^SECRET_ENCRYPTION_KEY=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
            rm "$ENV_FILE"
            SETUP_MODE="full"
            ;;
        *)
            error "Invalid choice '${choice}'. Run pnpm run setup again and enter 1, 2, or 3."
            exit 1
            ;;
    esac
}

# Starts Postgres, runs migrations, starts the full stack, writes SETUP_COMPLETE marker.
# Parses .env to get DATABASE_URL and HTTP_PORT for use at runtime. The bootstrap secret
# is no longer stored in .env (#911) — it lives in the vault; only the full-setup path
# holds it in-shell to display once (see print_summary's empty-secret branch on resume).
run_infra() {
    if [[ ! -f "$ENV_FILE" ]]; then
        error ".env not found. Cannot continue setup."
        hint "Run: pnpm run setup  (choose option 2 — Resume setup)"
        exit 1
    fi

    # Export .env vars into the shell environment safely — parse KEY=VALUE lines without
    # executing shell code. (source would run any shell expression in the .env file.)
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
        fi
    done < "$ENV_FILE"

    info "Starting Postgres..."
    docker compose --project-directory "$REPO_ROOT" "${DEV_COMPOSE[@]}" up -d postgres

    wait_for_postgres

    if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
        info "Installing dependencies..."
        pnpm --prefix "$REPO_ROOT" install --frozen-lockfile
    fi

    info "Running migrations..."
    if ! pnpm --prefix "$REPO_ROOT" run migrate; then
        error "Migrations failed. See the output above."
        hint "To retry: pnpm run setup  (choose option 2 — Resume setup)"
        exit 1
    fi
    success "Migrations applied"

    # Seed the encrypted vault with the prompted/generated secrets (#911). Must run
    # after migrations (the `secrets` table exists) and before the app boots, because
    # the app resolves these vault-only with no env fallback. SEED_VAULT_VERIFY=1 makes
    # seed-vault confirm the required rows (anthropic_api_key, api_token,
    # web_app_bootstrap_secret) actually landed in the vault and exit non-zero if not —
    # so a run that never persisted them fails loudly here rather than booting an instance
    # with HTTP auth disabled (#911).
    #
    # The bootstrap secrets are passed explicitly per setup mode rather than forwarding
    # the ambient shell environment:
    #   - Full install: the freshly generated/prompted values are NOT written to .env, so
    #     the seed-vault child can only receive them through these assignments.
    #   - Resume: the vault was already seeded on the first run, so pass NONE of them and
    #     let seed-vault re-verify the existing rows. Forwarding them on resume would
    #     either clobber an already-seeded ANTHROPIC_API_KEY to empty (failing
    #     verification) or silently re-seed API_TOKEN / WEB_APP_BOOTSTRAP_SECRET from
    #     whatever happens to be in the operator's shell — an unintended secret rotation.
    #     (A legacy pre-vault .env still migrates: run_infra exported its plaintext
    #     secrets above, and seed-vault reads them from the inherited process.env.)
    info "Seeding secrets vault..."
    seed_secret_env=()
    if [[ "$SETUP_MODE" == "full" ]]; then
        seed_secret_env=(
            "ANTHROPIC_API_KEY=$SEED_ANTHROPIC_KEY"
            "API_TOKEN=$API_TOKEN"
            "WEB_APP_BOOTSTRAP_SECRET=$WEB_APP_BOOTSTRAP_SECRET"
        )
    fi
    # ${arr[@]+"${arr[@]}"} expands safely to nothing when the array is empty, even under
    # `set -u` on bash 3.2 (macOS default), where a bare "${arr[@]}" is an unbound error.
    if ! env ${seed_secret_env[@]+"${seed_secret_env[@]}"} SEED_VAULT_VERIFY=1 \
         pnpm --prefix "$REPO_ROOT" run seed-vault; then
        error "Vault seeding failed or required secrets are missing. See the output above."
        hint "If this is a resume after a failed first run, re-run full setup (option 3) to regenerate and seed the bootstrap secrets."
        exit 1
    fi
    success "Secrets vault seeded"

    info "Starting Curia..."
    if ! docker compose --project-directory "$REPO_ROOT" "${DEV_COMPOSE[@]}" up -d; then
        error "Failed to start Curia stack."
        hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs"
        exit 1
    fi

    # `docker compose up -d` exits 0 once the container has *started*, not once
    # the app inside is healthy. The Curia process can crash-loop in the seconds
    # after start (corepack misconfig, missing schemas, bad config) and the
    # operator would still see "Curia is up" against a broken install. Poll the
    # healthcheck so the success banner reflects reality.
    if ! wait_for_curia; then
        error "Curia container is not healthy — refusing to print success banner."
        exit 1
    fi

    # Mark setup as complete so the idempotency menu can distinguish restart vs recovery.
    printf "\n# SETUP_COMPLETE\n" >> "$ENV_FILE"

    # On the resume path the bootstrap secret is not in-shell (not in .env anymore,
    # not regenerated), so pass it defensively — print_summary degrades gracefully.
    print_summary "${WEB_APP_BOOTSTRAP_SECRET:-}"
}

main() {
    check_prerequisites

    if [[ -f "$ENV_FILE" ]]; then
        handle_existing_env
        # handle_existing_env exits for option 1 (start only) and aborted option 3.
        # Returns with SETUP_MODE="resume" (option 2) or SETUP_MODE="full" (option 3 confirmed).
    fi

    if [[ "$SETUP_MODE" == "full" ]]; then
        generate_secrets
        local anthropic_key
        anthropic_key=$(prompt_anthropic_key)
        SEED_ANTHROPIC_KEY="$anthropic_key"
        write_env
        success ".env written"
    fi

    run_infra
}

# Guard: only run main when executed directly, not when sourced (enables testing).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
