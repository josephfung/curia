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

# --- handle_existing_env tests ---

echo ""
echo "=== handle_existing_env ==="

# Test option 2: sets SETUP_MODE=resume
_menu_env=$(mktemp)
echo "DB_USER=curia" > "$_menu_env"
(
    ENV_FILE="$_menu_env"
    SETUP_MODE="full"
    handle_existing_env < <(echo "2")
    # Since the function runs in the same subshell, check SETUP_MODE here
    if [[ "$SETUP_MODE" == "resume" ]]; then
        exit 0
    else
        exit 1
    fi
)
if [[ $? -eq 0 ]]; then
    echo "  ✓ option 2 sets SETUP_MODE=resume"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 2 should set SETUP_MODE=resume"
    FAIL=$((FAIL + 1))
fi

# Test option 3 (cancel): "3\nno" should NOT delete .env and should exit 0
echo "DB_USER=curia" > "$_menu_env"
(
    ENV_FILE="$_menu_env"
    SETUP_MODE="full"
    handle_existing_env < <(printf "3\nno\n")
) 2>/dev/null
if [[ -f "$_menu_env" ]]; then
    echo "  ✓ option 3 + 'no' does not delete .env"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 3 + 'no' should not delete .env"
    FAIL=$((FAIL + 1))
fi

# Test option 3 (confirm): "3\nyes" deletes .env and sets SETUP_MODE=full
echo "DB_USER=curia" > "$_menu_env"
_opt3_rc=0
(
    ENV_FILE="$_menu_env"
    SETUP_MODE="resume"
    handle_existing_env < <(printf "3\nyes\n")
    # Verify file was deleted and mode changed
    if [[ ! -f "$ENV_FILE" ]] && [[ "$SETUP_MODE" == "full" ]]; then
        exit 0
    else
        exit 1
    fi
) 2>/dev/null || _opt3_rc=$?
if [[ $_opt3_rc -eq 0 ]] && [[ ! -f "$_menu_env" ]]; then
    echo "  ✓ option 3 + 'yes' deletes .env and sets SETUP_MODE=full"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 3 + 'yes' should delete .env and set SETUP_MODE=full"
    FAIL=$((FAIL + 1))
fi

# Test SETUP_COMPLETE marker: hint shown when absent, hidden when present
_hint_env=$(mktemp)
echo "DB_USER=curia" > "$_hint_env"  # no SETUP_COMPLETE
ENV_FILE="$_hint_env"
SETUP_MODE="full"
_stderr_output=$(echo "2" | handle_existing_env 2>&1 >/dev/null)
if echo "$_stderr_output" | grep -q "Setup didn't finish last time"; then
    echo "  ✓ hint shown when SETUP_COMPLETE absent"
    PASS=$((PASS + 1))
else
    echo "  ✗ hint should appear when SETUP_COMPLETE is absent"
    FAIL=$((FAIL + 1))
fi

printf "DB_USER=curia\n# SETUP_COMPLETE\n" > "$_hint_env"  # with SETUP_COMPLETE
ENV_FILE="$_hint_env"
SETUP_MODE="full"
_stderr_output=$(echo "2" | handle_existing_env 2>&1 >/dev/null)
if ! echo "$_stderr_output" | grep -q "Setup didn't finish last time"; then
    echo "  ✓ hint hidden when SETUP_COMPLETE present"
    PASS=$((PASS + 1))
else
    echo "  ✗ hint should be hidden when SETUP_COMPLETE is present"
    FAIL=$((FAIL + 1))
fi

rm -f "$_menu_env" "$_hint_env"
ENV_FILE="$REPO_ROOT/.env"

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

# --- Results ---

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
