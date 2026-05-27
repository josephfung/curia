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

# Returns 0 if key matches sk-ant-... format, 1 otherwise.
validate_anthropic_key() {
    local key="$1"
    [[ "$key" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]]
}

main() {
    echo "setup not yet implemented"
}

# Guard: only run main when executed directly, not when sourced (enables testing).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
