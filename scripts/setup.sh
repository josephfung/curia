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
hint()    { echo -e "${GREY}   $*${RESET}"; }

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

# Global: set by handle_existing_env to control main() flow
SETUP_MODE="full"  # "full" | "resume"

# Verifies docker, docker compose, node >= 22, and pnpm are available.
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
        read -rsp "Paste your key: " key
        echo "" >&2
        if validate_anthropic_key "$key"; then
            echo "$key"
            return 0
        fi
        attempts=$((attempts + 1))
        local remaining=$((max_attempts - attempts))
        if [[ $remaining -gt 0 ]]; then
            error "Key must start with 'sk-ant-' followed by letters, numbers, hyphens, or underscores. Try again ($remaining attempt(s) remaining):"
        fi
    done

    error "Failed to get a valid Anthropic API key after $max_attempts attempts."
    hint "Get your key at: https://console.anthropic.com"
    exit 1
}

main() {
    check_prerequisites
    echo "Prerequisites OK — rest of setup not yet implemented"
}

# Guard: only run main when executed directly, not when sourced (enables testing).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
