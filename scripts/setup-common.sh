#!/usr/bin/env bash
# Shared helpers for both installers:
#   - scripts/setup.sh  (developer / build-from-source)
#   - install.sh        (operator / pull-published-image)
#
# Sourced by each installer, never executed directly. Callers must set REPO_ROOT
# before calling wait_for_postgres or wait_for_curia. Callers that want to pass
# extra compose flags (e.g. -f docker-compose.dev.yml) should set COMPOSE_FLAGS
# as an array before sourcing or before calling the wait_* functions — the helpers
# default to an empty array (no extra flags) when COMPOSE_FLAGS is unset.

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

# 32 random bytes, base64-encoded (44-char string). Used for vault master key.
# No openssl dependency — works on any POSIX host with /dev/urandom.
gen_secret_b64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# 32 random bytes, hex-encoded (64-char string). Used for api_token / bootstrap secret.
# No openssl dependency.
gen_secret_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

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

# Polls docker for Postgres healthy status every 2s, up to 60s. Exits 1 on timeout.
# Callers may set COMPOSE_FLAGS (array) for extra compose file flags; defaults to empty.
#
# TODO: asymmetry hazard — wait_for_postgres uses `exit 1` on failure while
# wait_for_curia uses `return 1`. This is intentional today (wait_for_postgres is
# always called unconditionally; wait_for_curia's return lets the caller decide),
# but if wait_for_curia is ever called inside a conditional (which disables set -e),
# a bare `return 1` propagates cleanly. Be mindful if you ever swap their call sites.
wait_for_postgres() {
    local max_wait=60
    local elapsed=0
    # Expand caller-supplied COMPOSE_FLAGS if set; default to empty array otherwise.
    local -a _flags=("${COMPOSE_FLAGS[@]+"${COMPOSE_FLAGS[@]}"}")

    info "Waiting for Postgres to be ready..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id ps_err
        # Distinguish "container not started yet" (empty output, exit 0) from docker failures.
        if ! ps_err=$(docker compose --project-directory "$REPO_ROOT" "${_flags[@]}" ps -q postgres 2>&1); then
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
#
# Callers may set COMPOSE_FLAGS (array) for extra compose file flags; defaults to empty.
wait_for_curia() {
    local max_wait=120
    local elapsed=0
    local ever_seen=0   # 0 until we observe a container id at least once
    local last_seen_id=""
    # Expand caller-supplied COMPOSE_FLAGS if set; default to empty array otherwise.
    local -a _flags=("${COMPOSE_FLAGS[@]+"${COMPOSE_FLAGS[@]}"}")

    info "Waiting for Curia to become healthy (up to ${max_wait}s)..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id ps_err
        if ! ps_err=$(docker compose --project-directory "$REPO_ROOT" "${_flags[@]}" ps -q curia 2>&1); then
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

# Prints the final summary box with login URL and bootstrap secret.
# $1 = WEB_APP_BOOTSTRAP_SECRET (plain hex, no formatting)
# Reads DOMAIN from the environment: when set, shows https://$DOMAIN;
# otherwise falls back to http://localhost:$HTTP_PORT.
print_summary() {
    local secret="$1"
    local port="${HTTP_PORT:-3000}"
    local W=70  # inner box width; wide enough for a 64-char hex secret + padding
    local border url
    border=$(printf '═%.0s' $(seq 1 $W))

    # Use the public HTTPS URL when the operator chose the domain topology;
    # fall back to localhost for local and behind-proxy installs.
    if [[ -n "${DOMAIN:-}" ]]; then
        url="https://${DOMAIN}"
    else
        url="http://localhost:${port}"
    fi

    echo ""
    printf "╔%s╗\n" "$border"
    printf "║%-${W}s║\n" ""
    printf "║   %-$((W-3))s║\n" "Curia is running."
    printf "║%-${W}s║\n" ""
    printf "║   %-$((W-3))s║\n" "Open:    $url"
    printf "║%-${W}s║\n" ""
    if [[ -n "$secret" ]]; then
        # Full setup — the freshly generated secret is in hand; show it once.
        printf "║   %-$((W-3))s║\n" "Bootstrap secret (save this to a password manager):"
        printf "║   %-$((W-3))s║\n" "${secret}"
        printf "║%-${W}s║\n" ""
        printf "║   %-$((W-3))s║\n" "Enter it on the login page to create your account."
        printf "║   %-$((W-3))s║\n" "You won't be shown it again here."
    else
        # Resume — the secret now lives in the vault, not .env, and isn't retrievable
        # here. It was shown during the initial setup run.
        printf "║   %-$((W-3))s║\n" "Bootstrap secret: stored in the encrypted vault."
        printf "║   %-$((W-3))s║\n" "(Shown once during initial setup; not retrievable here.)"
    fi
    printf "║%-${W}s║\n" ""
    printf "╚%s╝\n" "$border"
    echo ""
}
