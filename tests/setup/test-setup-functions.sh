#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Capture the test dir before sourcing setup.sh, which re-assigns SCRIPT_DIR to scripts/.
TEST_DIR="$SCRIPT_DIR"
# Source the script under test without running main (guarded by BASH_SOURCE check at script bottom)
source "$SCRIPT_DIR/../../scripts/setup.sh"
# Source the shared helpers explicitly so this file documents its direct dependency.
# setup.sh already sources setup-common.sh at load time, so this is a no-op in practice;
# we use TEST_DIR here because SCRIPT_DIR was re-assigned by setup.sh's sourcing.
source "$TEST_DIR/../../scripts/setup-common.sh"

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

assert_false() {
    local desc="$1"
    local file="$2"
    local pattern="$3"
    if ! grep -qF "$pattern" "$file" 2>/dev/null; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — did not expect '$pattern' in $file"
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

run_check_prerequisites_with_node() {
    local node_version="$1"
    local out_file="$2"
    local tmp_bin
    tmp_bin=$(mktemp -d)

    cat > "$tmp_bin/docker" <<'DOCKER_EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "info" ]]; then
    exit 0
fi
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
    exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 1
DOCKER_EOF

    cat > "$tmp_bin/node" <<NODE_EOF
#!/usr/bin/env bash
echo "v${node_version}"
NODE_EOF

    cat > "$tmp_bin/pnpm" <<'PNPM_EOF'
#!/usr/bin/env bash
exit 0
PNPM_EOF

    chmod +x "$tmp_bin/docker" "$tmp_bin/node" "$tmp_bin/pnpm"

    local rc
    set +e
    (PATH="$tmp_bin:$PATH"; check_prerequisites) > "$out_file" 2>&1
    rc=$?
    set -e

    rm -rf "$tmp_bin"
    return "$rc"
}

# --- check_prerequisites tests ---

echo "=== check_prerequisites ==="
_node_out=$(mktemp)
if run_check_prerequisites_with_node "22.19.0" "$_node_out"; then
    echo "  ✗ rejects Node 22"
    FAIL=$((FAIL + 1))
else
    assert_true "rejects Node 22 with >= 24 message" "$_node_out" ">= 24 is required"
fi

if run_check_prerequisites_with_node "23.11.0" "$_node_out"; then
    echo "  ✗ rejects Node 23"
    FAIL=$((FAIL + 1))
else
    assert_true "rejects Node 23 with >= 24 message" "$_node_out" ">= 24 is required"
fi

if run_check_prerequisites_with_node "24.0.0" "$_node_out"; then
    echo "  ✓ accepts Node 24"
    PASS=$((PASS + 1))
else
    echo "  ✗ accepts Node 24"
    FAIL=$((FAIL + 1))
fi
rm -f "$_node_out"

# --- validate_anthropic_key tests ---

echo ""
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
SECRET_ENCRYPTION_KEY=replace-with-a-base64-32-byte-key
ANTHROPIC_API_KEY=sk-ant-...
API_TOKEN=your-secret-token-here
WEB_APP_BOOTSTRAP_SECRET=replace-with-a-long-random-secret
# NYLAS_API_KEY=nyk_v0_...
LOG_LEVEL=info
EXAMPLE_EOF

_tmp_env=$(mktemp)

# Override script globals for test isolation. Under vault-only (#911), write_env only
# templates the four bootstrap values into .env; ANTHROPIC_API_KEY / API_TOKEN /
# WEB_APP_BOOTSTRAP_SECRET are seeded into the encrypted vault and must NOT appear here.
ENV_EXAMPLE="$_tmp_example"
ENV_FILE="$_tmp_env"
DB_USER="curia"
DB_PASSWORD="testpassword123abc"
SECRET_ENCRYPTION_KEY="dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmcxMjM0NQ=="
API_TOKEN="testtoken456def"
WEB_APP_BOOTSTRAP_SECRET="testsecret789ghi"
DATABASE_URL="postgres://curia:testpassword123abc@localhost:5432/curia"

write_env

assert_true  "DB_USER=curia written"                  "$_tmp_env" "DB_USER=curia"
assert_true  "DB_PASSWORD written"                     "$_tmp_env" "DB_PASSWORD=testpassword123abc"
assert_true  "DATABASE_URL written"                    "$_tmp_env" "DATABASE_URL=postgres://curia:testpassword123abc@localhost:5432/curia"
assert_true  "SECRET_ENCRYPTION_KEY written"           "$_tmp_env" "SECRET_ENCRYPTION_KEY=dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmcxMjM0NQ=="
# Vault-only: these three are NOT written to .env (they go to the encrypted vault). The
# live values must never be templated in, and the example placeholders stay untouched.
assert_false "API_TOKEN live value not written to .env"    "$_tmp_env" "API_TOKEN=testtoken456def"
assert_false "WEB_APP_BOOTSTRAP live value not in .env"    "$_tmp_env" "WEB_APP_BOOTSTRAP_SECRET=testsecret789ghi"
assert_true  "ANTHROPIC_API_KEY placeholder left untouched" "$_tmp_env" "ANTHROPIC_API_KEY=sk-ant-..."
assert_true  "API_TOKEN placeholder left untouched"        "$_tmp_env" "API_TOKEN=your-secret-token-here"
assert_true  "WEB_APP_BOOTSTRAP placeholder left untouched" "$_tmp_env" "WEB_APP_BOOTSTRAP_SECRET=replace-with-a-long-random-secret"
assert_true  "optional comment line preserved"            "$_tmp_env" "# NYLAS_API_KEY"
assert_true  "non-substituted var preserved"              "$_tmp_env" "LOG_LEVEL=info"

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
_opt2_rc=0
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
) 2>/dev/null || _opt2_rc=$?
if [[ $_opt2_rc -eq 0 ]]; then
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

# --- setup-common: secret generator tests ---

echo ""
echo "=== setup-common: secret generators ==="
key_b64="$(gen_secret_b64)"
# base64 of 32 bytes is 44 chars ending in '='
if [[ "${#key_b64}" -eq 44 ]]; then echo "  ✓ gen_secret_b64 length 44"; PASS=$((PASS+1)); else echo "  ✗ gen_secret_b64 length ${#key_b64}"; FAIL=$((FAIL+1)); fi
key_hex="$(gen_secret_hex)"
if [[ "${#key_hex}" -eq 64 ]]; then echo "  ✓ gen_secret_hex length 64"; PASS=$((PASS+1)); else echo "  ✗ gen_secret_hex length ${#key_hex}"; FAIL=$((FAIL+1)); fi

# --- install.sh: source-checkout detection ---
# Source install.sh (guarded: defines functions, does not run main).
# Suppress setup-common.sh re-sourcing output; the helpers are already loaded.
source "$TEST_DIR/../../install.sh" 2>/dev/null

echo ""
echo "=== install.sh: detect_source_checkout ==="

# A directory with .git + src/ + package.json naming the curia project.
tmp_src=$(mktemp -d)
mkdir -p "$tmp_src/src" "$tmp_src/.git"
printf '{"name":"curia"}' > "$tmp_src/package.json"
if detect_source_checkout "$tmp_src"; then
    echo "  ✓ detects a curia source tree"
    PASS=$((PASS+1))
else
    echo "  ✗ missed a curia source tree"
    FAIL=$((FAIL+1))
fi

# A bare directory: no .git, no src/, no package.json.
tmp_bare=$(mktemp -d)
if ! detect_source_checkout "$tmp_bare"; then
    echo "  ✓ bare dir is not a source tree"
    PASS=$((PASS+1))
else
    echo "  ✗ false-positive on bare dir"
    FAIL=$((FAIL+1))
fi

# A directory with .git + src but a different package name (not curia).
tmp_other=$(mktemp -d)
mkdir -p "$tmp_other/src" "$tmp_other/.git"
printf '{"name":"other-project"}' > "$tmp_other/package.json"
if ! detect_source_checkout "$tmp_other"; then
    echo "  ✓ non-curia package.json is not a source tree"
    PASS=$((PASS+1))
else
    echo "  ✗ false-positive on non-curia package.json"
    FAIL=$((FAIL+1))
fi

rm -rf "$tmp_src" "$tmp_bare" "$tmp_other"

# --- install.sh: set_env_var ---

echo ""
echo "=== install.sh: set_env_var ==="

# set_env_var replaces an existing uncommented key.
_sv_env=$(mktemp)
printf 'FOO=old\nBAR=keep\n' > "$_sv_env"
set_env_var "$_sv_env" FOO new_value
if grep -qF "FOO=new_value" "$_sv_env"; then
    echo "  ✓ replaces existing key"
    PASS=$((PASS+1))
else
    echo "  ✗ did not replace existing key"
    FAIL=$((FAIL+1))
fi
if grep -qF "BAR=keep" "$_sv_env"; then
    echo "  ✓ preserves unrelated key"
    PASS=$((PASS+1))
else
    echo "  ✗ unrelated key was clobbered"
    FAIL=$((FAIL+1))
fi
# Old value must not remain.
if ! grep -qF "FOO=old" "$_sv_env"; then
    echo "  ✓ old value removed"
    PASS=$((PASS+1))
else
    echo "  ✗ old value still present"
    FAIL=$((FAIL+1))
fi

# set_env_var replaces a commented-out key (e.g. # FOO=placeholder).
printf '# FOO=placeholder\nBAR=keep\n' > "$_sv_env"
set_env_var "$_sv_env" FOO activated
if grep -qF "FOO=activated" "$_sv_env"; then
    echo "  ✓ activates commented key"
    PASS=$((PASS+1))
else
    echo "  ✗ did not activate commented key"
    FAIL=$((FAIL+1))
fi

# set_env_var appends when the key is entirely absent.
printf 'BAR=keep\n' > "$_sv_env"
set_env_var "$_sv_env" NEWKEY newval
if grep -qF "NEWKEY=newval" "$_sv_env"; then
    echo "  ✓ appends missing key"
    PASS=$((PASS+1))
else
    echo "  ✗ did not append missing key"
    FAIL=$((FAIL+1))
fi

rm -f "$_sv_env"

# --- install.sh: install_is_complete ---

echo ""
echo "=== install.sh: install_is_complete ==="

# Returns true (0) when .env has the SETUP_COMPLETE marker.
_ic_env=$(mktemp)
printf 'DB_PASSWORD=abc123\n# SETUP_COMPLETE\n' > "$_ic_env"
if install_is_complete "$_ic_env"; then
    echo "  ✓ SETUP_COMPLETE marker → complete"
    PASS=$((PASS+1))
else
    echo "  ✗ SETUP_COMPLETE marker should return complete"
    FAIL=$((FAIL+1))
fi

# Returns true (0) when .env has a real (non-placeholder, non-empty) DB_PASSWORD.
printf 'DB_PASSWORD=realhexvalue0011aabbccdd\n' > "$_ic_env"
if install_is_complete "$_ic_env"; then
    echo "  ✓ real DB_PASSWORD (no marker) → complete"
    PASS=$((PASS+1))
else
    echo "  ✗ real DB_PASSWORD with no marker should also return complete"
    FAIL=$((FAIL+1))
fi

# Returns false (1) for a brand-new .env with the placeholder DB_PASSWORD.
printf 'DB_PASSWORD=replace-with-a-strong-password\n' > "$_ic_env"
if ! install_is_complete "$_ic_env"; then
    echo "  ✓ placeholder DB_PASSWORD → not complete"
    PASS=$((PASS+1))
else
    echo "  ✗ placeholder DB_PASSWORD should return not complete"
    FAIL=$((FAIL+1))
fi

# Returns false (1) when DB_PASSWORD is absent entirely.
printf 'DB_USER=curia\n' > "$_ic_env"
if ! install_is_complete "$_ic_env"; then
    echo "  ✓ absent DB_PASSWORD → not complete"
    PASS=$((PASS+1))
else
    echo "  ✗ absent DB_PASSWORD should return not complete"
    FAIL=$((FAIL+1))
fi

# Returns false (1) when DB_PASSWORD is empty (key present, value blank).
printf 'DB_PASSWORD=\n' > "$_ic_env"
if ! install_is_complete "$_ic_env"; then
    echo "  ✓ empty DB_PASSWORD → not complete"
    PASS=$((PASS+1))
else
    echo "  ✗ empty DB_PASSWORD should return not complete"
    FAIL=$((FAIL+1))
fi

rm -f "$_ic_env"

# --- Results ---

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
