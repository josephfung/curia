# Single-Command Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `pnpm setup` — a single command that takes a fresh clone to a running Curia instance with Postgres, migrations applied, and the bootstrap secret printed.

**Architecture:** A Bash script (`scripts/setup.sh`) drives all setup steps: prerequisite checks, `.env` generation, Postgres startup, host-side migrations via `pnpm run migrate`, full stack start, and a terminal summary box. The script exposes a menu when `.env` already exists to handle restarts, partial-failure recovery, and full resets. Three supporting file edits (package.json, .env.example, README.md) wire it in.

**Tech Stack:** Bash (`set -euo pipefail`), Docker Compose, pnpm, `openssl rand -hex 32`, ANSI terminal colors.

**Spec:** `docs/superpowers/specs/2026-05-27-single-command-setup-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `scripts/setup.sh` | All setup logic |
| Create | `tests/setup/test-setup-functions.sh` | Bash unit tests for pure functions |
| Modify | `package.json` | Add `"setup"` script entry |
| Modify | `.env.example` | Fix `DB_USER`, update `DATABASE_URL` comment |
| Modify | `README.md` | Replace stale Quick Start block |

---

## Task 1: Test harness + `validate_anthropic_key` (TDD)

**Files:**
- Create: `tests/setup/test-setup-functions.sh`
- Create: `scripts/setup.sh` (skeleton only — enough to be sourced)

- [ ] **Step 1: Create test file with harness and failing tests**

```bash
mkdir -p tests/setup
```

Create `tests/setup/test-setup-functions.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source the script under test without running main (guarded by BASH_SOURCE check at script bottom)
source "$SCRIPT_DIR/../../scripts/setup.sh"

# --- Helpers ---

assert_true() {
    local desc="$1"
    local file="$2"
    local pattern="$3"
    if grep -qF "$pattern" "$file" 2>/dev/null; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — expected '$pattern' not found in $file"
        FAIL=$((FAIL + 1))
    fi
}

assert_valid_key() {
    local desc="$1"
    local key="$2"
    if validate_anthropic_key "$key"; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — expected key '$key' to be valid"
        FAIL=$((FAIL + 1))
    fi
}

assert_invalid_key() {
    local desc="$1"
    local key="$2"
    if ! validate_anthropic_key "$key" 2>/dev/null; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — expected key '$key' to be invalid"
        FAIL=$((FAIL + 1))
    fi
}

# --- validate_anthropic_key tests ---

echo "=== validate_anthropic_key ==="
assert_valid_key   "accepts sk-ant-api03-..." "sk-ant-api03-abc123XYZ"
assert_valid_key   "accepts key with hyphens in suffix" "sk-ant-abc-def-123"
assert_valid_key   "accepts key with underscores" "sk-ant-abc_def_123"
assert_invalid_key "rejects OpenAI key prefix" "sk-oai-abc123"
assert_invalid_key "rejects empty string" ""
assert_invalid_key "rejects plain string" "abc123"
assert_invalid_key "rejects sk-ant with no suffix" "sk-ant"
assert_invalid_key "rejects sk-ant- with empty suffix" "sk-ant-"
assert_invalid_key "rejects key with spaces" "sk-ant- abc123"

# --- Results ---

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
```

- [ ] **Step 2: Create minimal `scripts/setup.sh` skeleton (enough to be sourced)**

```bash
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
```

- [ ] **Step 3: Run tests — expect FAIL (function exists but test harness works)**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: all `validate_anthropic_key` tests pass, "Results: 9 passed, 0 failed".

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add scripts/setup.sh tests/setup/test-setup-functions.sh
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: add setup.sh skeleton and validate_anthropic_key with tests"
```

---

## Task 2: Prerequisite checks + Anthropic key prompt

**Files:**
- Modify: `scripts/setup.sh` (add `check_prerequisites`, `prompt_anthropic_key`)

These functions depend on system state (docker, node, pnpm), so they aren't unit-tested. Manual verification is at the end of this task.

- [ ] **Step 1: Add `check_prerequisites` after the color/helper section in `scripts/setup.sh`**

Add this function before `validate_anthropic_key`:

```bash
# Verifies docker, docker compose, node >= 22, and pnpm are available.
# Exits 1 with an install link on the first missing tool.
check_prerequisites() {
    if ! docker info &>/dev/null 2>&1; then
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
    node_major=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$node_major" -lt 22 ]]; then
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
```

- [ ] **Step 2: Add `prompt_anthropic_key` after `validate_anthropic_key`**

```bash
# Prompts for an Anthropic API key, validates format, retries up to 3 times.
# Prints the key to stdout on success. Exits 1 after 3 failed attempts.
prompt_anthropic_key() {
    local key=""
    local attempts=0
    local max_attempts=3

    echo ""
    echo "Curia needs an Anthropic API key to run its agents."
    hint "Get one at: https://console.anthropic.com"
    echo ""

    while [[ $attempts -lt $max_attempts ]]; do
        read -rsp "Paste your key: " key
        echo ""
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
```

Note: `read -rsp` uses `-s` (silent) so the key isn't echoed to the terminal.

- [ ] **Step 3: Update `main()` to call check_prerequisites**

Replace the current `main()` stub:

```bash
main() {
    check_prerequisites
    echo "Prerequisites OK — rest of setup not yet implemented"
}
```

- [ ] **Step 4: Manual smoke test**

```bash
bash scripts/setup.sh
```

Expected: "Prerequisites OK — rest of setup not yet implemented" (assuming docker, node >= 22, pnpm are installed).

Also verify error paths: temporarily rename docker to confirm the error message and exit code.

- [ ] **Step 5: Run existing unit tests to confirm they still pass**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 9 passed, 0 failed"

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add scripts/setup.sh
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: add prerequisite checks and anthropic key prompt"
```

---

## Task 3: Secret generation + `write_env` (TDD)

**Files:**
- Modify: `scripts/setup.sh` (add `generate_secrets`, `write_env`)
- Modify: `tests/setup/test-setup-functions.sh` (add `write_env` tests)

- [ ] **Step 1: Add `write_env` tests to the test file**

Add after the `validate_anthropic_key` tests, before the Results section:

```bash
# --- write_env tests ---

echo ""
echo "=== write_env ==="

# Create a minimal .env.example for testing
_tmp_example=$(mktemp)
cat > "$_tmp_example" <<'EXAMPLE_EOF'
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DATABASE_URL=postgres://your-db-user:your-db-password@localhost:5432/curia
ANTHROPIC_API_KEY=sk-ant-...
API_TOKEN=your-secret-token-here
WEB_APP_BOOTSTRAP_SECRET=replace-with-a-long-random-secret
# NYLAS_API_KEY=nyk_v0_...
LOG_LEVEL=info
EXAMPLE_EOF

_tmp_env=$(mktemp)

# Override script globals for test isolation
ENV_EXAMPLE="$_tmp_example"
ENV_FILE="$_tmp_env"
DB_USER="curia"
DB_PASSWORD="testpassword123abc"
API_TOKEN="testtoken456def"
WEB_APP_BOOTSTRAP_SECRET="testsecret789ghi"
DATABASE_URL="postgres://curia:testpassword123abc@localhost:5432/curia"

write_env "sk-ant-testkey999"

assert_true "DB_USER=curia written"                   "$_tmp_env" "DB_USER=curia"
assert_true "DB_PASSWORD written"                      "$_tmp_env" "DB_PASSWORD=testpassword123abc"
assert_true "DATABASE_URL written"                     "$_tmp_env" "DATABASE_URL=postgres://curia:testpassword123abc@localhost:5432/curia"
assert_true "ANTHROPIC_API_KEY written"                "$_tmp_env" "ANTHROPIC_API_KEY=sk-ant-testkey999"
assert_true "API_TOKEN written"                        "$_tmp_env" "API_TOKEN=testtoken456def"
assert_true "WEB_APP_BOOTSTRAP_SECRET written"         "$_tmp_env" "WEB_APP_BOOTSTRAP_SECRET=testsecret789ghi"
assert_true "optional comment line preserved"          "$_tmp_env" "# NYLAS_API_KEY"
assert_true "non-substituted var preserved"            "$_tmp_env" "LOG_LEVEL=info"

rm -f "$_tmp_example" "$_tmp_env"
# Reset ENV_FILE/ENV_EXAMPLE to real paths after test
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
```

- [ ] **Step 2: Run tests — expect failure on write_env tests**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: `validate_anthropic_key` tests pass, `write_env` tests fail with "write_env: command not found" or similar.

- [ ] **Step 3: Add `generate_secrets` and `write_env` to `scripts/setup.sh`**

Add after `prompt_anthropic_key`:

```bash
# Populates global secret variables using openssl CSPRNG.
generate_secrets() {
    DB_USER="curia"
    DB_PASSWORD=$(openssl rand -hex 32)
    API_TOKEN=$(openssl rand -hex 32)
    WEB_APP_BOOTSTRAP_SECRET=$(openssl rand -hex 32)
    DATABASE_URL="postgres://curia:${DB_PASSWORD}@localhost:5432/curia"
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
        "$ENV_EXAMPLE" > "$ENV_FILE"
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 17 passed, 0 failed"

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add scripts/setup.sh tests/setup/test-setup-functions.sh
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: add secret generation and .env templating with tests"
```

---

## Task 4: Interactive menu — `handle_existing_env` (TDD)

**Files:**
- Modify: `scripts/setup.sh` (add `handle_existing_env`)
- Modify: `tests/setup/test-setup-functions.sh` (add menu tests)

- [ ] **Step 1: Add `handle_existing_env` tests**

Add after the `write_env` tests, before the Results section:

```bash
# --- handle_existing_env tests ---

echo ""
echo "=== handle_existing_env ==="

# Test option 2: sets SETUP_MODE=resume
_menu_env=$(mktemp)
echo "DB_USER=curia" > "$_menu_env"
ENV_FILE="$_menu_env"
SETUP_MODE="full"
# Feed "2" as stdin; function must NOT exit for option 2
echo "2" | handle_existing_env
if [[ "$SETUP_MODE" == "resume" ]]; then
    echo "  ✓ option 2 sets SETUP_MODE=resume"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 2 should set SETUP_MODE=resume, got: $SETUP_MODE"
    FAIL=$((FAIL + 1))
fi

# Test option 3 (cancel): "3\nno" should NOT delete .env and should exit 0
# We run in a subshell to catch the exit
echo "DB_USER=curia" > "$_menu_env"
ENV_FILE="$_menu_env"
SETUP_MODE="full"
(
    printf "3\nno\n" | handle_existing_env
) 2>/dev/null || true
if [[ -f "$_menu_env" ]]; then
    echo "  ✓ option 3 + 'no' does not delete .env"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 3 + 'no' should not delete .env"
    FAIL=$((FAIL + 1))
fi

# Test option 3 (confirm): "3\nyes" deletes .env and sets SETUP_MODE=full
echo "DB_USER=curia" > "$_menu_env"
ENV_FILE="$_menu_env"
SETUP_MODE="resume"
printf "3\nyes\n" | handle_existing_env
if [[ ! -f "$_menu_env" ]] && [[ "$SETUP_MODE" == "full" ]]; then
    echo "  ✓ option 3 + 'yes' deletes .env and sets SETUP_MODE=full"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 3 + 'yes' should delete .env and set SETUP_MODE=full (mode=$SETUP_MODE, file_exists=$([ -f $_menu_env ] && echo yes || echo no))"
    FAIL=$((FAIL + 1))
fi

# Test SETUP_COMPLETE marker detection
_completed_env=$(mktemp)
printf "DB_USER=curia\n# SETUP_COMPLETE\n" > "$_completed_env"
ENV_FILE="$_completed_env"
if grep -q "^# SETUP_COMPLETE" "$_completed_env"; then
    echo "  ✓ SETUP_COMPLETE marker is detectable via grep"
    PASS=$((PASS + 1))
else
    echo "  ✗ SETUP_COMPLETE marker detection failed"
    FAIL=$((FAIL + 1))
fi

rm -f "$_menu_env" "$_completed_env"
ENV_FILE="$REPO_ROOT/.env"
```

- [ ] **Step 2: Run tests — expect failure on menu tests**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: prior tests pass, new menu tests fail with "handle_existing_env: command not found".

- [ ] **Step 3: Add `handle_existing_env` to `scripts/setup.sh`**

Add after `write_env`:

```bash
# Shown when .env already exists. Exits for option 1, sets SETUP_MODE for 2 and 3.
handle_existing_env() {
    local has_completed=""
    if grep -q "^# SETUP_COMPLETE" "$ENV_FILE" 2>/dev/null; then
        has_completed=1
    fi

    echo ""
    echo "Your .env already exists. Looks like you've been here before."
    echo ""
    echo "  1  Start the stack      → docker compose up -d            (default)"
    echo "  2  Resume setup         → re-run infra with existing .env"
    if [[ -z "$has_completed" ]]; then
        echo -e "     ${YELLOW}↑ Setup didn't finish last time — this is probably what you want${RESET}"
    fi
    echo -e "  3  Full reset           → ${YELLOW}⚠${RESET}  regenerates secrets, invalidates active sessions"
    echo ""
    read -rp "Choice [1]: " choice
    choice="${choice:-1}"

    case "$choice" in
        1)
            info "Starting the stack..."
            hint "You can also run this directly: docker compose up -d"
            docker compose --project-directory "$REPO_ROOT" up -d
            success "Stack is up."
            exit 0
            ;;
        2)
            SETUP_MODE="resume"
            ;;
        3)
            echo ""
            warn "This will regenerate all secrets. Any active sessions will be invalidated."
            read -rp "Type 'yes' to confirm: " confirm
            if [[ "$confirm" != "yes" ]]; then
                echo "Aborted."
                exit 0
            fi
            rm "$ENV_FILE"
            SETUP_MODE="full"
            ;;
        *)
            error "Invalid choice '${choice}'. Run pnpm setup again and enter 1, 2, or 3."
            exit 1
            ;;
    esac
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 21 passed, 0 failed"

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add scripts/setup.sh tests/setup/test-setup-functions.sh
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: add interactive menu for existing .env with tests"
```

---

## Task 5: Infra orchestration — `wait_for_postgres` + `run_infra`

**Files:**
- Modify: `scripts/setup.sh` (add `wait_for_postgres`, `run_infra`)

These functions call docker and pnpm — not unit-testable without mocking. Integration verification is at the end of Task 7.

- [ ] **Step 1: Add `wait_for_postgres` to `scripts/setup.sh`**

Add after `handle_existing_env`:

```bash
# Polls docker for Postgres healthy status every 2s, up to 60s. Exits 1 on timeout.
wait_for_postgres() {
    local max_wait=60
    local elapsed=0

    info "Waiting for Postgres to be ready..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id
        container_id=$(docker compose --project-directory "$REPO_ROOT" ps -q postgres 2>/dev/null || true)
        if [[ -n "$container_id" ]]; then
            local health
            health=$(docker inspect --format='{{.State.Health.Status}}' "$container_id" 2>/dev/null || echo "unknown")
            if [[ "$health" == "healthy" ]]; then
                success "Postgres is ready"
                return 0
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
```

- [ ] **Step 2: Add `run_infra` to `scripts/setup.sh`**

Add after `wait_for_postgres`:

```bash
# Starts Postgres, runs migrations, starts the full stack, writes SETUP_COMPLETE marker.
# Sources .env to get HTTP_PORT and WEB_APP_BOOTSTRAP_SECRET for the summary.
run_infra() {
    # Export all .env vars into the shell environment so pnpm migrate and the
    # summary box can read DATABASE_URL, HTTP_PORT, WEB_APP_BOOTSTRAP_SECRET, etc.
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a

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
        hint "To retry: pnpm setup  (choose option 2 — Resume setup)"
        exit 1
    fi
    success "Migrations applied"

    info "Starting Curia..."
    docker compose --project-directory "$REPO_ROOT" up -d
    success "Curia is up"

    # Mark setup as complete so the idempotency menu can distinguish restart vs recovery.
    printf "\n# SETUP_COMPLETE\n" >> "$ENV_FILE"

    print_summary "$WEB_APP_BOOTSTRAP_SECRET"
}
```

Note on `pnpm --prefix`: pnpm changes the working directory to `$REPO_ROOT` before running the script, so `--env-file=.env` inside the `migrate` script resolves correctly to `$REPO_ROOT/.env`.

- [ ] **Step 3: Run existing tests to confirm nothing broke**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 21 passed, 0 failed"

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add scripts/setup.sh
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: add postgres health wait and infra orchestration"
```

---

## Task 6: `print_summary` (TDD) + wire `main()`

**Files:**
- Modify: `scripts/setup.sh` (add `print_summary`, complete `main()`)
- Modify: `tests/setup/test-setup-functions.sh` (add `print_summary` tests)

- [ ] **Step 1: Add `print_summary` tests to test file**

Add after the menu tests, before the Results section:

```bash
# --- print_summary tests ---

echo ""
echo "=== print_summary ==="

HTTP_PORT="3000"
_test_secret="aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
_summary_output=$(print_summary "$_test_secret")

_assert_output() {
    local desc="$1"
    local pattern="$2"
    if echo "$_summary_output" | grep -qF "$pattern"; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — expected '$pattern'"
        FAIL=$((FAIL + 1))
    fi
}

_assert_output "contains 'Curia is running'"                "Curia is running."
_assert_output "contains login URL"                         "http://localhost:3000"
_assert_output "contains the full secret"                   "$_test_secret"
_assert_output "contains 'Bootstrap secret' label"          "Bootstrap secret"
_assert_output "contains password manager instruction"      "save this to a password manager"
_assert_output "contains login instruction"                 "Enter it on the login page"
_assert_output "contains box top-left corner"               "╔"
_assert_output "contains box bottom-right corner"           "╝"
```

- [ ] **Step 2: Run tests — expect failure on summary tests**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: prior tests pass, summary tests fail with "print_summary: command not found".

- [ ] **Step 3: Add `print_summary` to `scripts/setup.sh`**

Add after `run_infra`:

```bash
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
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 29 passed, 0 failed"

- [ ] **Step 5: Replace the `main()` stub with the complete implementation**

Replace the current `main()` in `scripts/setup.sh`:

```bash
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
```

- [ ] **Step 6: Run all tests one final time**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 29 passed, 0 failed"

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add scripts/setup.sh tests/setup/test-setup-functions.sh
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: add print_summary and wire up main() flow"
```

---

## Task 7: `package.json` + `.env.example` + `README.md`

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add `setup` script to `package.json`**

In the `"scripts"` object, add `"setup"` as the first entry (it's the top-level entry point):

```json
"scripts": {
    "setup": "bash scripts/setup.sh",
    "predev": "pnpm migrate",
    ...
```

- [ ] **Step 2: Update `.env.example` — fix `DB_USER` and `DATABASE_URL`**

Change these two lines:

```
# Before:
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DATABASE_URL=postgres://your-db-user:your-db-password@localhost:5432/curia

# After:
DB_USER=curia
DB_PASSWORD=your-db-password
# DATABASE_URL is constructed from DB_USER and DB_PASSWORD by pnpm setup.
# For manual setup, substitute the values below:
DATABASE_URL=postgres://curia:your-db-password@localhost:5432/curia
```

- [ ] **Step 3: Replace the `## Quick Start` section in `README.md`**

Find and replace the entire `## Quick Start` section (from `## Quick Start` to just before `## Contributing`). The current content to remove:

```markdown
## Quick Start

> **Note:** Curia is in pre-alpha. The spec is complete; implementation is underway. Star the repo to follow progress.

**Prerequisites:** Node >= 22, PostgreSQL 16+ with pgvector, an LLM provider API key (Anthropic, OpenAI, or Ollama).

```bash
git clone https://github.com/josephfung/curia.git
cd curia
cp .env.example .env        # add your API keys and DB connection
npm install
npm run db:migrate
npm start
```

The full setup guide covers configuration tiers, channel setup, Docker Compose, and verification steps:

**[→ Full installation guide](https://docs.meetcuria.com/get-started/installation)**
```

Replace with:

```markdown
## Quickstart

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/), Node >= 22, pnpm, and an [Anthropic API key](https://console.anthropic.com).

```bash
git clone https://github.com/josephfung/curia.git
cd curia
pnpm setup
```

Curia will be running at `http://localhost:3000`. The setup script prints your bootstrap secret — save it to a password manager and use it on the login page to create your account.

**[→ Full installation guide](https://docs.meetcuria.com/get-started/installation)**  
(channels, production deploy, configuration reference)
```

- [ ] **Step 4: Run vitest to confirm no TypeScript tests broke**

```bash
pnpm --prefix /Users/josephfung/Projects/worktrees/curia-single-command-setup test
```

Expected: all existing tests pass (these changes touch no TypeScript source).

- [ ] **Step 5: Run bash unit tests**

```bash
bash tests/setup/test-setup-functions.sh
```

Expected: "Results: 29 passed, 0 failed"

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup add package.json .env.example README.md
git -C /Users/josephfung/Projects/worktrees/curia-single-command-setup commit -m "feat: wire pnpm setup into package.json, update .env.example and README"
```

---

## Integration Test Checklist (manual — requires Docker)

After all tasks complete, verify the acceptance criteria from the spec:

```bash
# 1. Fresh-clone simulation: remove .env if present, then run setup
rm -f /Users/josephfung/Projects/worktrees/curia-single-command-setup/.env
pnpm --prefix /Users/josephfung/Projects/worktrees/curia-single-command-setup setup

# Expected: prereq checks pass, prompts for Anthropic key, generates .env,
# starts postgres, runs migrations, starts curia, prints summary box.

# 2. Verify containers running and healthy
docker compose --project-directory /Users/josephfung/Projects/worktrees/curia-single-command-setup ps
# Expected: postgres and curia both "running (healthy)"

# 3. Idempotent re-run: .env now exists, expect menu
pnpm --prefix /Users/josephfung/Projects/worktrees/curia-single-command-setup setup
# Expected: menu appears, choose 1, stack comes up, exits cleanly

# 4. Option 2 recovery: simulate partial failure by removing SETUP_COMPLETE marker
sed -i '' '/^# SETUP_COMPLETE/d' /Users/josephfung/Projects/worktrees/curia-single-command-setup/.env
pnpm --prefix /Users/josephfung/Projects/worktrees/curia-single-command-setup setup
# Expected: menu highlights option 2, choosing it re-runs infra steps successfully

# 5. Prerequisite check: temporarily confirm error message
# (run `docker stop` then `docker desktop quit` and re-run to verify error text)
```
