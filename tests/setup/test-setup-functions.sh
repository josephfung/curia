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

# --- Results ---

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
