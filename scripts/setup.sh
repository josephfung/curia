#!/usr/bin/env bash
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
GREY='\033[0;37m'
RESET='\033[0m'

# --- Output helpers ---
info()    { echo -e "${BOLD}==> $*${RESET}"; }
success() { echo -e "${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*" >&2; }
error()   { echo -e "${RED}✗${RESET}  $*" >&2; }
hint()    { echo -e "${GREY}   $*${RESET}" >&2; }

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

# Global: set by handle_existing_env to control main() flow
SETUP_MODE="full"  # "full" | "resume"

# Verifies docker, docker compose, node >= 22, pnpm, and openssl are available.
# Exits 1 with an install link on the first missing tool.
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
        error "node not found (requires >= 22)."
        hint "Install at: https://nodejs.org/"
        exit 1
    fi
    local node_major
    node_major=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ -z "$node_major" ]] || [[ "$node_major" -lt 22 ]]; then
        error "Node $(node --version) found, but >= 22 is required."
        hint "Update at: https://nodejs.org/"
        exit 1
    fi

    if ! command -v pnpm &>/dev/null; then
        error "pnpm not found."
        hint "Install at: https://pnpm.io/installation"
        exit 1
    fi

    if ! command -v openssl &>/dev/null; then
        error "openssl not found (required for secret generation)."
        hint "Install via your system package manager (e.g. brew install openssl)"
        exit 1
    fi
}

# Returns 0 if key matches sk-ant-... format, 1 otherwise.
validate_anthropic_key() {
    local key="$1"
    [[ "$key" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]]
}

# Prompts for an Anthropic API key, validates format, retries up to 3 times.
# Prints the key to stdout on success. Exits 1 after 3 failed attempts.
prompt_anthropic_key() {
    local key=""
    local attempts=0
    local max_attempts=3

    echo "" >&2
    echo "Curia needs an Anthropic API key to run its agents." >&2
    hint "Get one at: https://console.anthropic.com"
    echo "" >&2

    while [[ $attempts -lt $max_attempts ]]; do
        read -rsp "Paste your key: " key || true
        echo "" >&2
        if validate_anthropic_key "$key"; then
            echo "$key"
            return 0
        fi
        attempts=$((attempts + 1))
        local remaining=$((max_attempts - attempts))
        if [[ $remaining -gt 0 ]]; then
            error "Key must start with 'sk-ant-' followed by letters, numbers, hyphens, or underscores. Try again ($remaining attempt(s) remaining):"
        else
            error "Key must start with 'sk-ant-' followed by letters, numbers, hyphens, or underscores."
        fi
    done

    error "Failed to get a valid Anthropic API key after $max_attempts attempts."
    hint "Get your key at: https://console.anthropic.com"
    exit 1
}

# Populates global secret variables using openssl CSPRNG.
generate_secrets() {
    DB_USER="curia"
    DB_PASSWORD=$(openssl rand -hex 32)
    API_TOKEN=$(openssl rand -hex 32)
    WEB_APP_BOOTSTRAP_SECRET=$(openssl rand -hex 32)
    SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
    # DATABASE_URL is consumed by host-side `pnpm migrate` (against the postgres
    # container's published port), so the port here must match POSTGRES_PORT.
    # When unset, both default to 5432. Keep this in lockstep with the postgres
    # service's `ports:` line in docker-compose.yml.
    local pg_host_port="${POSTGRES_PORT:-5432}"
    DATABASE_URL="postgres://curia:${DB_PASSWORD}@localhost:${pg_host_port}/curia"
}

# Templates ENV_EXAMPLE into ENV_FILE, substituting generated secrets.
# Takes the Anthropic API key as $1. Optional vars remain commented.
write_env() {
    local anthropic_key="$1"
    sed \
        -e "s|^DB_USER=.*|DB_USER=${DB_USER}|" \
        -e "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" \
        -e "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" \
        -e "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${anthropic_key}|" \
        -e "s|^API_TOKEN=.*|API_TOKEN=${API_TOKEN}|" \
        -e "s|^WEB_APP_BOOTSTRAP_SECRET=.*|WEB_APP_BOOTSTRAP_SECRET=${WEB_APP_BOOTSTRAP_SECRET}|" \
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
            hint "You can also run this directly: docker compose up -d"
            docker compose --project-directory "$REPO_ROOT" up -d
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
            rm "$ENV_FILE"
            SETUP_MODE="full"
            ;;
        *)
            error "Invalid choice '${choice}'. Run pnpm run setup again and enter 1, 2, or 3."
            exit 1
            ;;
    esac
}

# Polls docker for Postgres healthy status every 2s, up to 60s. Exits 1 on timeout.
wait_for_postgres() {
    local max_wait=60
    local elapsed=0

    info "Waiting for Postgres to be ready..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id ps_err
        # Distinguish "container not started yet" (empty output, exit 0) from docker failures.
        if ! ps_err=$(docker compose --project-directory "$REPO_ROOT" ps -q postgres 2>&1); then
            error "docker compose ps failed: $ps_err"
            hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs postgres"
            exit 1
        fi
        container_id="$ps_err"
        if [[ -n "$container_id" ]]; then
            local health inspect_err
            # Container may exit between ps and inspect — treat that as not-healthy yet.
            if inspect_err=$(docker inspect --format='{{.State.Health.Status}}' "$container_id" 2>&1); then
                health="$inspect_err"
                if [[ "$health" == "healthy" ]]; then
                    success "Postgres is ready"
                    return 0
                fi
            fi
        fi
        sleep 2
        elapsed=$((elapsed + 2))
        echo -e "${GREY}   ... still waiting (${elapsed}s)${RESET}"
    done

    error "Postgres did not become healthy within ${max_wait}s."
    hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs postgres"
    exit 1
}

# Polls docker for Curia healthy status every 2s, up to 120s. Returns 0 on healthy,
# 1 on timeout or detected failure. Does not exit — caller decides what to do
# (typically: print a red failure and exit, so the operator doesn't see a green
# success banner against a container that's actually in a restart loop).
#
# 120s is generous: Curia's HEALTHCHECK has start_period=60s + interval=30s, so the
# first probe lands at ~60s and a healthy verdict needs at least one successful
# probe. 120s = first probe + one retry window + slack for slow hosts.
#
# Failure detection beyond timeout:
#  - Once the container has been observed at least once, an empty `ps -q` result
#    means it was removed (crash without restart, or `docker rm`). Bail rather
#    than wait the full 120s with a misleading "did not become healthy" message.
#  - `.State.Status == exited` with a non-zero exit code or rising restart count
#    means the container is in a fast crash-loop. Bail immediately.
#  - `.State.Health.Status` is validated against {starting, healthy, unhealthy}.
#    Any other value (e.g. `<no value>` when no healthcheck is defined, or the
#    field being missing) is treated as a configuration error, not a "wait longer".
wait_for_curia() {
    local max_wait=120
    local elapsed=0
    local ever_seen=0   # 0 until we observe a container id at least once
    local last_seen_id=""

    info "Waiting for Curia to become healthy (up to ${max_wait}s)..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id ps_err
        if ! ps_err=$(docker compose --project-directory "$REPO_ROOT" ps -q curia 2>&1); then
            error "docker compose ps failed: $ps_err"
            hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs curia"
            return 1
        fi
        container_id="$ps_err"

        if [[ -z "$container_id" ]]; then
            if [[ "$ever_seen" -eq 1 ]]; then
                # Container existed earlier in this loop and is gone now — Docker
                # removed it (e.g. it crashed and the restart policy isn't bringing
                # it back, or someone ran `docker rm`). Don't wait the full timeout.
                error "Curia container disappeared (last seen: ${last_seen_id:0:12}) — likely a crash without restart."
                hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs curia"
                return 1
            fi
            # Not seen yet — keep waiting. Compose may still be creating the container.
        else
            ever_seen=1
            last_seen_id="$container_id"

            # Read State.Status and RestartCount alongside Health.Status so we can
            # bail on a clear failure rather than wait the full timeout. Format
            # uses a sentinel separator that's unlikely to appear in any value.
            local inspect_out inspect_err
            if ! inspect_out=$(docker inspect \
                --format='{{.State.Status}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}NO_HEALTHCHECK{{end}}' \
                "$container_id" 2>&1); then
                inspect_err="$inspect_out"
                # The container may have been removed between `ps -q` and `inspect` —
                # let the next loop iteration handle that via the empty-id branch.
                echo -e "${GREY}   ... inspect transient error: ${inspect_err}${RESET}"
            else
                local state restarts health
                state="${inspect_out%%|*}"
                local rest="${inspect_out#*|}"
                restarts="${rest%%|*}"
                health="${rest#*|}"

                if [[ "$state" == "exited" || "$state" == "dead" ]] && [[ "${restarts:-0}" -ge 1 ]]; then
                    error "Curia container is in a crash loop (state=${state}, restarts=${restarts})."
                    hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs curia"
                    return 1
                fi

                case "$health" in
                    healthy)
                        success "Curia is healthy"
                        return 0
                        ;;
                    starting|unhealthy)
                        # Both are transient; keep polling. The Dockerfile's retries
                        # let an unhealthy container recover within a probe or two.
                        ;;
                    NO_HEALTHCHECK)
                        error "Curia container has no healthcheck — cannot verify install."
                        hint "Was the Dockerfile rebuilt? Expected HEALTHCHECK on /api/health."
                        return 1
                        ;;
                    *)
                        # Unknown value — flag rather than silently keep waiting.
                        error "Unexpected Health.Status value: '$health' (expected starting/healthy/unhealthy)."
                        hint "Check logs: docker compose --project-directory \"$REPO_ROOT\" logs curia"
                        return 1
                        ;;
                esac
            fi
        fi

        sleep 2
        elapsed=$((elapsed + 2))
        echo -e "${GREY}   ... still waiting (${elapsed}s)${RESET}"
    done

    error "Curia did not become healthy within ${max_wait}s."
    hint "The container may be slow or stuck — check logs:"
    hint "  docker compose --project-directory \"$REPO_ROOT\" logs curia"
    return 1
}

# Starts Postgres, runs migrations, starts the full stack, writes SETUP_COMPLETE marker.
# Parses .env to get DATABASE_URL, HTTP_PORT, and WEB_APP_BOOTSTRAP_SECRET for use at runtime.
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
    docker compose --project-directory "$REPO_ROOT" up -d postgres

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

    info "Starting Curia..."
    if ! docker compose --project-directory "$REPO_ROOT" up -d; then
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

    print_summary "$WEB_APP_BOOTSTRAP_SECRET"
}

# Prints the final summary box with login URL and bootstrap secret.
# $1 = WEB_APP_BOOTSTRAP_SECRET (plain hex, no formatting)
print_summary() {
    local secret="$1"
    local port="${HTTP_PORT:-3000}"
    local W=70  # inner box width; wide enough for a 64-char hex secret + padding
    local border
    border=$(printf '═%.0s' $(seq 1 $W))

    echo ""
    printf "╔%s╗\n" "$border"
    printf "║%-${W}s║\n" ""
    printf "║   %-$((W-3))s║\n" "Curia is running."
    printf "║%-${W}s║\n" ""
    printf "║   %-$((W-3))s║\n" "Open:    http://localhost:${port}"
    printf "║%-${W}s║\n" ""
    printf "║   %-$((W-3))s║\n" "Bootstrap secret (save this to a password manager):"
    printf "║   %-$((W-3))s║\n" "${secret}"
    printf "║%-${W}s║\n" ""
    printf "║   %-$((W-3))s║\n" "Enter it on the login page to create your account."
    printf "║   %-$((W-3))s║\n" "You won't be shown it again here."
    printf "║%-${W}s║\n" ""
    printf "╚%s╝\n" "$border"
    echo ""
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
        write_env "$anthropic_key"
        success ".env written"
    fi

    run_infra
}

# Guard: only run main when executed directly, not when sourced (enables testing).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
