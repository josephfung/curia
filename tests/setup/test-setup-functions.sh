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
if run_check_prerequisites_with_node "24.21.0" "$_node_out"; then
    echo "  ✗ rejects Node 24"
    FAIL=$((FAIL + 1))
else
    assert_true "rejects Node 24 with >= 26 message" "$_node_out" ">= 26 is required"
fi

if run_check_prerequisites_with_node "25.9.0" "$_node_out"; then
    echo "  ✗ rejects Node 25"
    FAIL=$((FAIL + 1))
else
    assert_true "rejects Node 25 with >= 26 message" "$_node_out" ">= 26 is required"
fi

if run_check_prerequisites_with_node "26.0.0" "$_node_out"; then
    echo "  ✓ accepts Node 26"
    PASS=$((PASS + 1))
else
    echo "  ✗ accepts Node 26"
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

# Returns false (1) when .env has a real DB_PASSWORD but NO marker: this is a
# partial/interrupted install (DB creds written, vault not yet seeded). It must
# route through fresh_install (which preserves the DB password) so the missing
# vault secrets still get seeded — not the verify-only upgrade path.
printf 'DB_PASSWORD=realhexvalue0011aabbccdd\n' > "$_ic_env"
if ! install_is_complete "$_ic_env"; then
    echo "  ✓ real DB_PASSWORD, no marker → not complete (partial install)"
    PASS=$((PASS+1))
else
    echo "  ✗ real DB_PASSWORD without marker should NOT be treated as complete"
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

_assert_var() {
    local desc="$1" got="$2" want="$3"
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ $desc"; PASS=$((PASS+1))
    else
        echo "  ✗ $desc — got '$got' want '$want'"; FAIL=$((FAIL+1))
    fi
}

# --- install.sh: bindings_are_loopback ---
# Judges `docker port` output, so every compose file shape (quoting, a changed
# default, a trailing comment, an override or COMPOSE_FILE overlay) reduces to
# the same few binding lines.

echo ""
echo "=== install.sh: bindings_are_loopback ==="

_assert_loopback() {
    local desc="$1" bindings="$2" want="$3" got
    if bindings_are_loopback "$bindings"; then got=loopback; else got=exposed; fi
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ $desc → $want"
        PASS=$((PASS+1))
    else
        echo "  ✗ $desc: got $got, want $want"
        FAIL=$((FAIL+1))
    fi
}

_assert_loopback "no host IP (pre-#2408 default)"  $'0.0.0.0:5432\n[::]:5432'  exposed
_assert_loopback "explicit 0.0.0.0"                 '0.0.0.0:5432'             exposed
_assert_loopback "explicit ::"                      '[::]:5432'                exposed
_assert_loopback "private interface address"        '10.0.0.5:5432'            exposed
_assert_loopback "changed host port, all interfaces" $'0.0.0.0:5433\n[::]:5433' exposed
_assert_loopback "loopback plus a public binding"   $'127.0.0.1:5432\n0.0.0.0:5433' exposed
_assert_loopback "127.0.0.1"                        '127.0.0.1:5432'           loopback
_assert_loopback "other 127/8 address"              '127.0.0.2:5432'           loopback
_assert_loopback "IPv6 loopback"                    '[::1]:5432'               loopback
_assert_loopback "not published (empty output)"     ''                         loopback
_assert_loopback "trailing blank line"              $'127.0.0.1:5432\n'        loopback

# --- install.sh: env_value ---

echo ""
echo "=== install.sh: env_value ==="

_ev_env=$(mktemp)
printf 'HTTP_BIND=127.0.0.1\nPOSTGRES_BIND=::\nHTTP_BIND=0.0.0.0\n# POSTGRES_PORT=5432\n' > "$_ev_env"
_assert_var "last assignment wins"         "$(env_value "$_ev_env" HTTP_BIND)"     "0.0.0.0"
_assert_var "value containing colons"      "$(env_value "$_ev_env" POSTGRES_BIND)" "::"
_assert_var "commented-out key is absent"  "$(env_value "$_ev_env" POSTGRES_PORT)" ""
_assert_var "missing file is absent"       "$(env_value "$_ev_env.missing" HTTP_BIND)" ""
# Compose's .env parser strips one layer of matching quotes; env_value must too,
# or HTTP_BIND="127.0.0.1" would read as non-loopback and skip the checks.
printf 'A="127.0.0.1"\nB=\x27::1\x27\nC="mismatched\x27\nD="\nE=""\n' > "$_ev_env"
_assert_var "double-quoted value stripped"   "$(env_value "$_ev_env" A)" "127.0.0.1"
_assert_var "single-quoted value stripped"   "$(env_value "$_ev_env" B)" "::1"
_assert_var "mismatched quotes kept"         "$(env_value "$_ev_env" C)" "\"mismatched'"
_assert_var "lone quote kept"                "$(env_value "$_ev_env" D)" '"'
_assert_var "empty quoted value is empty"    "$(env_value "$_ev_env" E)" ""
_ev_env2=$(mktemp)
printf '%s\n' 'A=127.0.0.1 # note' 'B="127.0.0.1" # note' "C='::1'   # note" 'D=  10.0.0.5  ' 'E=a#b' > "$_ev_env2"
_assert_var "unquoted inline comment dropped"  "$(env_value "$_ev_env2" A)" "127.0.0.1"
_assert_var "comment after quotes dropped"     "$(env_value "$_ev_env2" B)" "127.0.0.1"
_assert_var "single quotes, comment dropped"   "$(env_value "$_ev_env2" C)" "::1"
_assert_var "blanks around unquoted trimmed"   "$(env_value "$_ev_env2" D)" "10.0.0.5"
_assert_var "# without a blank is part of it"  "$(env_value "$_ev_env2" E)" "a#b"
rm -f "$_ev_env2"

# install.sh runs under `set -euo pipefail`; an absent key must not abort it
# from inside an assignment (it did, before env_value swallowed grep's status).
if ( set -euo pipefail; _v="$(env_value "$_ev_env" NOT_THERE)"; [[ -z "$_v" ]] ); then
    echo "  ✓ absent key survives set -euo pipefail"
    PASS=$((PASS+1))
else
    echo "  ✗ absent key aborts under set -euo pipefail"
    FAIL=$((FAIL+1))
fi
rm -f "$_ev_env"

# --- install.sh: bind_value_is_loopback / uses_tls_overlay ---

echo ""
echo "=== install.sh: bind_value_is_loopback ==="

_assert_rc() {
    local desc="$1" want="$2"; shift 2
    local got=0
    "$@" || got=$?
    [[ "$got" -ne 0 ]] && got=1
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ $desc"; PASS=$((PASS+1))
    else
        echo "  ✗ $desc — got rc $got want $want"; FAIL=$((FAIL+1))
    fi
}

_assert_rc "127.0.0.1 is loopback"   0 bind_value_is_loopback 127.0.0.1
_assert_rc "127.0.0.2 is loopback"   0 bind_value_is_loopback 127.0.0.2
_assert_rc "::1 is loopback"         0 bind_value_is_loopback ::1
_assert_rc "[::1] is loopback"       0 bind_value_is_loopback '[::1]'
_assert_rc "localhost is loopback"   0 bind_value_is_loopback localhost
_assert_rc "empty is not loopback"   1 bind_value_is_loopback ''
_assert_rc "0.0.0.0 is not loopback" 1 bind_value_is_loopback 0.0.0.0
_assert_rc ":: is not loopback"      1 bind_value_is_loopback ::
_assert_rc "10.0.0.5 is not loopback" 1 bind_value_is_loopback 10.0.0.5

echo ""
echo "=== install.sh: uses_tls_overlay ==="

_assert_rc "base + TLS overlay"              0 uses_tls_overlay 'docker-compose.yml:docker-compose.tls.yml'
_assert_rc "TLS overlay plus a voice overlay" 0 uses_tls_overlay 'docker-compose.yml:docker-compose.tls.yml:docker-compose.voice.yml'
_assert_rc "base only"                       1 uses_tls_overlay 'docker-compose.yml'
_assert_rc "unset"                           1 uses_tls_overlay ''
_assert_rc "overlay given by path"           0 uses_tls_overlay 'docker-compose.yml:./deploy/docker-compose.tls.yml'
_assert_rc "similarly named file"            1 uses_tls_overlay 'docker-compose.yml:my-docker-compose.tls.yml'
_assert_rc "backup copy of the overlay"      1 uses_tls_overlay 'docker-compose.yml:docker-compose.tls.yml.bak'

echo ""
echo "=== install.sh: bindings_honour_bind ==="

_assert_rc "0.0.0.0 accepts IPv4 everywhere"        0 bindings_honour_bind 0.0.0.0 '0.0.0.0:5432'
_assert_rc "0.0.0.0 accepts a specific IPv4"        0 bindings_honour_bind 0.0.0.0 '10.0.0.5:5432'
_assert_rc "0.0.0.0 rejects IPv6 [::]"              1 bindings_honour_bind 0.0.0.0 $'0.0.0.0:5432\n[::]:5432'
_assert_rc ":: accepts every interface"             0 bindings_honour_bind :: $'0.0.0.0:5432\n[::]:5432'
_assert_rc "specific address honoured"              0 bindings_honour_bind 10.0.0.5 '10.0.0.5:5432'
_assert_rc "specific address plus loopback"         0 bindings_honour_bind 10.0.0.5 $'10.0.0.5:5432\n127.0.0.1:5433'
_assert_rc "IPv6 address honoured"                  0 bindings_honour_bind 'fd00::5' '[fd00::5]:5432'
_assert_rc "nothing published"                      0 bindings_honour_bind 10.0.0.5 ''
_assert_rc "old file ignores a specific address"    1 bindings_honour_bind 10.0.0.5 $'0.0.0.0:5432\n[::]:5432'
_assert_rc "a different address"                    1 bindings_honour_bind 10.0.0.5 '10.0.0.6:5432'

echo ""
echo "=== install.sh: livekit_command_is_dev ==="

_assert_rc "unset is the --dev default"   0 livekit_command_is_dev ''
_assert_rc "explicit --dev"               0 livekit_command_is_dev '--dev --bind 0.0.0.0'
_assert_rc "real config"                  1 livekit_command_is_dev '--config /etc/livekit.yaml'

# --- install.sh: exposure check decisions (Docker stubbed) ---
# published_bindings is the only Docker call; stub it so the skip/verify
# decisions run without containers. Each case runs in a subshell because a
# refused prompt exits.

echo ""
echo "=== install.sh: check_postgres_exposure / check_http_exposure ==="

_xp_env=$(mktemp)
_STUB_BINDINGS=""
_STUB_RC=0
_STUB_CMD=""
# Keep the real functions so they can be restored after the stubbed block.
eval "_orig_$(declare -f published_bindings)"
eval "_orig_$(declare -f live_command)"
eval "_orig_$(declare -f service_running)"
_STUB_RUNNING=""
published_bindings() { printf '%s' "$_STUB_BINDINGS"; return "$_STUB_RC"; }
live_command() { printf '%s' "$_STUB_CMD"; }
service_running() { [[ -n "$_STUB_RUNNING" ]]; }

# $1 desc, $2 env file contents, $3 stub bindings, $4 want: ok | stopped
_assert_pg() {
    local desc="$1" envtxt="$2" want="$4" got
    printf '%b' "$envtxt" > "$_xp_env"
    _STUB_BINDINGS="$3"
    if (
      unset POSTGRES_BIND
      [[ -z "${_SHELL_PG_BIND_SET:-}" ]] || export POSTGRES_BIND="$_SHELL_PG_BIND"
      check_postgres_exposure "$_xp_env" <<< "n"
    ) >/dev/null 2>&1; then got=ok; else got=stopped; fi
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ postgres: $desc → $want"; PASS=$((PASS+1))
    else
        echo "  ✗ postgres: $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_exposed=$'0.0.0.0:5432\n[::]:5432'
_assert_pg "unset, old file exposes"                ''                         "$_exposed"        stopped
_assert_pg "loopback POSTGRES_BIND, old file ignores it" 'POSTGRES_BIND=127.0.0.1\n' "$_exposed"  stopped
_assert_pg "quoted loopback, old file ignores it"   'POSTGRES_BIND="127.0.0.1"\n' "$_exposed"     stopped
_assert_pg "non-loopback opt-in 0.0.0.0, IPv4 only" 'POSTGRES_BIND=0.0.0.0\n'   '0.0.0.0:5432'     ok
_assert_pg "0.0.0.0 opt-in, also published on IPv6" 'POSTGRES_BIND=0.0.0.0\n'   "$_exposed"        stopped
_assert_pg "non-loopback opt-in ::"                'POSTGRES_BIND=::\n'        "$_exposed"        ok
_assert_pg "specific opt-in, honoured"             'POSTGRES_BIND=10.0.0.5\n'  '10.0.0.5:5432'    ok
_assert_pg "specific opt-in, old file ignores it"  'POSTGRES_BIND=10.0.0.5\n'  "$_exposed"        stopped
_assert_pg "unset, new file binds loopback"        ''                          '127.0.0.1:5432'   ok
_assert_pg "with a comment in .env"                'POSTGRES_BIND=127.0.0.1 # local\n' "$_exposed"  stopped
# An exported empty POSTGRES_BIND wins over .env in Compose: loopback intent.
_SHELL_PG_BIND_SET=1; _SHELL_PG_BIND=""
_assert_pg "shell empty overrides a public .env"    'POSTGRES_BIND=0.0.0.0\n'   "$_exposed"        stopped
_SHELL_PG_BIND=0.0.0.0
_assert_pg "shell value overrides .env"             'POSTGRES_BIND=127.0.0.1\n' '0.0.0.0:5432'     ok
_SHELL_PG_BIND_SET=""; _SHELL_PG_BIND=""
# Bindings could not be read: ask rather than guess loopback.
_STUB_RC=2
_assert_pg "bindings unreadable"                   ''                          ''                 stopped
_STUB_RC=0

# check_http_exposure only warns; detect the warning on stderr.
_assert_http() {
    local desc="$1" envtxt="$2" want="$4" out got
    printf '%b' "$envtxt" > "$_xp_env"
    _STUB_BINDINGS="$3"
    out="$(
      unset HTTP_BIND
      [[ -z "${_SHELL_HTTP_BIND:-}" ]] || export HTTP_BIND="$_SHELL_HTTP_BIND"
      check_http_exposure "$_xp_env" 2>&1
    )"
    if [[ "$out" == *"still published beyond loopback"* ]]; then got=warned
    elif [[ "$out" == *"does not resolve"* ]]; then got=unresolved
    else got=quiet; fi
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ http: $desc → $want"; PASS=$((PASS+1))
    else
        echo "  ✗ http: $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_assert_http "HTTP_BIND unset (proxy topology)"     ''                       '0.0.0.0:3000' quiet
_assert_http "loopback asked, old file ignores it"  'HTTP_BIND=127.0.0.1\n'  '0.0.0.0:3000' warned
_assert_http "quoted loopback, old file ignores it" 'HTTP_BIND="127.0.0.1"\n' '0.0.0.0:3000' warned
_assert_http "loopback asked and honoured"          'HTTP_BIND=127.0.0.1\n'  '127.0.0.1:3000' quiet
_assert_http "loopback with a comment, old file ignores it" 'HTTP_BIND=127.0.0.1 # https\n' '0.0.0.0:3000' warned
_assert_http "\${...} reference left unresolved"   'HTTP_BIND=${HOST_BIND:-127.0.0.1}\n' '0.0.0.0:3000' unresolved
_SHELL_HTTP_BIND=127.0.0.1
_assert_http "loopback asked in the shell, old file ignores it" '' '0.0.0.0:3000' warned
_SHELL_HTTP_BIND=""

# ensure_https_http_bind: the upgrade-time HTTP_BIND rewrite.
_assert_hb() {
    local desc="$1" envtxt="$2" want="$3" got
    printf '%b' "$envtxt" > "$_xp_env"
    (
      unset HTTP_BIND COMPOSE_FILE
      [[ -z "${_SHELL_COMPOSE_FILE:-}" ]] || export COMPOSE_FILE="$_SHELL_COMPOSE_FILE"
      [[ -z "${_SHELL_HTTP_BIND_SET:-}" ]] || export HTTP_BIND=""
      ensure_https_http_bind "$_xp_env" 2>/dev/null
    )
    if grep -qE '^HTTP_BIND=' "$_xp_env"; then got="$(env_value "$_xp_env" HTTP_BIND)"; got="${got:-<empty>}"; else got="<absent>"; fi
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ upgrade: $desc → HTTP_BIND $want"; PASS=$((PASS+1))
    else
        echo "  ✗ upgrade: $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_assert_hb "TLS overlay, no HTTP_BIND"          'DOMAIN=x.example\nCOMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml\n' 127.0.0.1
_assert_hb "DOMAIN by hand, no overlay"         'DOMAIN=x.example\n'                                         '<absent>'
_assert_hb "TLS overlay, explicit empty kept"   'COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml\nHTTP_BIND=\n' '<empty>'
_assert_hb "TLS overlay, explicit value kept"   'COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml\nHTTP_BIND=10.0.0.5\n' 10.0.0.5
_assert_hb "local/proxy install untouched"      'HTTP_PORT=3000\n'                                           '<absent>'
_SHELL_COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml
_assert_hb "TLS overlay from the shell COMPOSE_FILE" 'DOMAIN=x.example\n'                                    127.0.0.1
_SHELL_HTTP_BIND_SET=1
_assert_hb "shell HTTP_BIND (empty) respected"  'DOMAIN=x.example\n'                                         '<absent>'
_SHELL_HTTP_BIND_SET=""
_SHELL_COMPOSE_FILE=""

# note_livekit_signaling: warns while signaling is still public (change not
# applied yet) and once it is loopback-only; any LIVEKIT_HTTP_BIND silences it.
_assert_lk() {
    local desc="$1" envtxt="$2" want="$4" out got
    printf '%b' "$envtxt" > "$_xp_env"
    _STUB_BINDINGS="$3"
    out="$(
      unset LIVEKIT_HTTP_BIND LIVEKIT_COMMAND
      { check_livekit_exposure "$_xp_env"; note_livekit_signaling "$_xp_env"; } 2>&1
    )"
    if [[ "$out" == *"still published beyond loopback"* ]]; then got=recreate
    elif [[ "$out" == *"is still on loopback"* ]]; then got=not-applied
    elif [[ "$out" == *"is published on:"* ]]; then got=mismatch
    elif [[ "$out" == *"publishes no port 7880"* ]]; then got=unpublished
    elif [[ "$out" == *"does not resolve"* ]]; then got=unresolved
    elif [[ "$out" == *"loopback only"* ]]; then got=loopback-note
    elif [[ "$out" == *"--dev credentials"* ]]; then got=dev-warning
    elif [[ -z "$out" ]]; then got=quiet
    else got="unexpected: $out"; fi
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ livekit: $desc → $want"; PASS=$((PASS+1))
    else
        echo "  ✗ livekit: $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_assert_lk "voice not running"                 ''                                 ''                          quiet
_assert_lk "unset, still public (not recreated)" ''                               $'0.0.0.0:7880\n[::]:7880'  recreate
_assert_lk "unset, loopback"                   ''                                 '127.0.0.1:7880'            loopback-note
_assert_lk "LIVEKIT_HTTP_BIND=127.0.0.1 (proxied)" 'LIVEKIT_HTTP_BIND=127.0.0.1\n'  '127.0.0.1:7880'            quiet
_assert_lk "loopback intent, still public (not recreated)" 'LIVEKIT_HTTP_BIND=127.0.0.1\n' $'0.0.0.0:7880\n[::]:7880' recreate
_assert_lk "quoted loopback intent, still public" 'LIVEKIT_HTTP_BIND="127.0.0.1"\n' '0.0.0.0:7880'              recreate
_assert_lk "public opt-in, real config"         'LIVEKIT_HTTP_BIND=0.0.0.0\nLIVEKIT_COMMAND=--config /etc/livekit.yaml\n' '0.0.0.0:7880' quiet
_assert_lk "public opt-in, LIVEKIT_COMMAND unset (--dev default)" 'LIVEKIT_HTTP_BIND=0.0.0.0\n' '0.0.0.0:7880'   dev-warning
_assert_lk "public opt-in, explicit --dev"      'LIVEKIT_HTTP_BIND=::\nLIVEKIT_COMMAND=--dev --bind 0.0.0.0\n' '[::]:7880' dev-warning
_assert_lk "specific opt-in, old file ignores it" 'LIVEKIT_HTTP_BIND=10.0.0.5\nLIVEKIT_COMMAND=--config /etc/livekit.yaml\n' $'0.0.0.0:7880\n[::]:7880' mismatch
_assert_lk "specific opt-in, honoured"          'LIVEKIT_HTTP_BIND=10.0.0.5\nLIVEKIT_COMMAND=--config /etc/livekit.yaml\n' '10.0.0.5:7880' quiet
_assert_lk "\${...} reference left unresolved"  'LIVEKIT_HTTP_BIND=${LK:-0.0.0.0}\n' '0.0.0.0:7880'         unresolved
_STUB_RUNNING=1
_assert_lk "public opt-in, running, 7880 unpublished" 'LIVEKIT_HTTP_BIND=0.0.0.0\n'     ''                          unpublished
_assert_lk "unset intent, running, 7880 unpublished"  ''                                ''                          quiet
_STUB_RUNNING=""
_assert_lk "public opt-in, not yet recreated off loopback" 'LIVEKIT_HTTP_BIND=0.0.0.0\n' '127.0.0.1:7880' not-applied
# The running container's command wins over .env: one not recreated keeps --dev.
_STUB_CMD="--dev --bind 0.0.0.0"
_assert_lk "public opt-in, .env real config, live --dev" 'LIVEKIT_HTTP_BIND=0.0.0.0\nLIVEKIT_COMMAND=--config /etc/livekit.yaml\n' '0.0.0.0:7880' dev-warning
_STUB_CMD="--config /etc/livekit.yaml"
_assert_lk "public opt-in, live real config"    'LIVEKIT_HTTP_BIND=0.0.0.0\n'     '0.0.0.0:7880'              quiet
_STUB_CMD=""

# Fresh installs: check_livekit_exposure alone (no loopback-only note).
_assert_lkdev() {
    local desc="$1" envtxt="$2" want="$4" out got
    printf '%b' "$envtxt" > "$_xp_env"
    _STUB_BINDINGS="$3"
    out="$(unset LIVEKIT_HTTP_BIND LIVEKIT_COMMAND; check_livekit_exposure "$_xp_env" 2>&1)"
    if [[ "$out" == *"still published beyond loopback"* ]]; then got=recreate
    elif [[ "$out" == *"--dev credentials"* ]]; then got=dev-warning
    elif [[ -z "$out" ]]; then got=quiet; else got="unexpected: $out"; fi
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ livekit (fresh): $desc → $want"; PASS=$((PASS+1))
    else
        echo "  ✗ livekit (fresh): $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_assert_lkdev "voice not running"         ''                                             ''             quiet
_assert_lkdev "loopback"                  ''                                             '127.0.0.1:7880' quiet
_assert_lkdev "public, --dev default"     'LIVEKIT_HTTP_BIND=0.0.0.0\n'                  '0.0.0.0:7880' dev-warning
_assert_lkdev "public opt-in, real config" 'LIVEKIT_HTTP_BIND=0.0.0.0\nLIVEKIT_COMMAND=--config /etc/livekit.yaml\n' '0.0.0.0:7880' quiet
_assert_lkdev "loopback intent, resumed install still public" 'LIVEKIT_HTTP_BIND=127.0.0.1\nLIVEKIT_COMMAND=--config /etc/livekit.yaml\n' '0.0.0.0:7880' recreate
_assert_lkdev "unset intent, still public, --dev" ''                                        $'0.0.0.0:7880\n[::]:7880' recreate

# The recreate rows classify on the first message; check the --dev warning
# separately, for unset and loopback intent alike.
for _lk_env in '' 'LIVEKIT_HTTP_BIND=127.0.0.1\n'; do
    printf '%b' "$_lk_env" > "$_xp_env"
    _STUB_BINDINGS=$'0.0.0.0:7880\n[::]:7880'
    _out="$(unset LIVEKIT_HTTP_BIND LIVEKIT_COMMAND; check_livekit_exposure "$_xp_env" 2>&1)"
    if [[ "$_out" == *"--dev credentials"* ]]; then
        echo "  ✓ livekit (fresh): '${_lk_env%\\n}' intent, public, --dev also warns about the credentials"; PASS=$((PASS+1))
    else
        echo "  ✗ livekit (fresh): '${_lk_env%\\n}' intent, public, --dev has no credentials warning"; FAIL=$((FAIL+1))
    fi
done

rm -f "$_xp_env"
# Restore the real functions for anything below.
eval "$(declare -f _orig_published_bindings | sed '1s/^_orig_//')"
eval "$(declare -f _orig_live_command | sed '1s/^_orig_//')"
eval "$(declare -f _orig_service_running | sed '1s/^_orig_//')"
unset -f _orig_published_bindings _orig_live_command _orig_service_running

if declare -f published_bindings | grep -q 'docker compose'; then
    echo "  ✓ real published_bindings restored after the stubs"; PASS=$((PASS+1))
else
    echo "  ✗ published_bindings not restored"; FAIL=$((FAIL+1))
fi

# published_bindings with `docker` stubbed: "no public port" is the nothing-
# published answer; any other docker port failure is unknown and warned about.
_assert_pb() {
    local desc="$1" port_out="$2" port_rc="$3" want="$4" outf err rc got
    outf="$(mktemp)"; err="$(mktemp)"
    # A subshell, not $(...): bash 3.2 can't parse a case statement inside $(...).
    (
      docker() {
        case "$1" in
          compose) echo cid123 ;;
          port) printf '%s\n' "$port_out" >&2; return "$port_rc" ;;
        esac
      }
      pb_rc=0
      published_bindings postgres 5432 >"$outf" 2>"$err" || pb_rc=$?
      echo "$pb_rc" > "$outf.rc"
    )
    rc="$(cat "$outf.rc")"
    if [[ -s "$outf" ]]; then
      got="bindings"
      # The exact address must pass through: a rewritten host would hide exposure.
      [[ "$(cat "$outf")" == "$port_out" ]] || got="bindings-mismatch: $(cat "$outf")"
      [[ "$rc" == 0 ]] || got="bindings but exit $rc"
    elif grep -q "Could not read" "$err"; then
      got=warned
      # Unknown must be reported as such (exit 2) so check_postgres_exposure can ask.
      [[ "$rc" == 2 ]] || got="warned but exit $rc"
    else
      got=empty
      [[ "$rc" == 0 ]] || got="empty but exit $rc"
    fi
    rm -f "$outf" "$outf.rc" "$err"
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ published_bindings: $desc → $want"; PASS=$((PASS+1))
    else
        echo "  ✗ published_bindings: $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_assert_pb "port not published"   "no public port '5432/tcp' published for cid123" 1 empty
_assert_pb "daemon error"         "Error response from daemon: No such container: cid123" 1 warned
_assert_pb "published"            "0.0.0.0:5432" 0 bindings

# --- shipped docker-compose.yml bind defaults ---

echo ""
echo "=== docker-compose.yml: bind defaults ==="

_compose="$TEST_DIR/../../docker-compose.yml"
# The items of one service's ports: list, one per line, quotes kept. Comment
# lines and other services' entries are not items, so they can't satisfy a check.
_service_ports() {
    awk -v svc="$1" '
      /^  [A-Za-z0-9_-]+:/ { insvc = ($0 ~ "^  " svc ":"); inports = 0; next }
      /^[^ #]/             { insvc = 0; inports = 0; next }
      insvc && /^    ports:/ { inports = 1; next }
      insvc && inports && /^      - / { sub(/^      - /, ""); sub(/[ \t]+#.*$/, ""); print; next }
      insvc && inports && /^    [^ #]/ { inports = 0 }
    ' "$2"
}
for _entry in \
    'postgres|"${POSTGRES_BIND:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432"' \
    'curia|"${HTTP_BIND:-}:${HTTP_PORT:-3000}:3000"' \
    'livekit|"${LIVEKIT_HTTP_BIND:-127.0.0.1}:${LIVEKIT_HTTP_PORT:-7880}:7880"'; do
    _svc="${_entry%%|*}"; _line="${_entry#*|}"
    if _service_ports "$_svc" "$_compose" | grep -qxF -- "$_line"; then
        echo "  ✓ $_svc publishes $_line"
        PASS=$((PASS+1))
    else
        echo "  ✗ $_svc ports: has no entry $_line"
        FAIL=$((FAIL+1))
    fi
done

# postgres publishes one mapping only: a second, public entry beside the
# loopback one must fail.
_pg_ports=$(_service_ports postgres "$_compose" | wc -l | tr -d ' ')
if [[ "$_pg_ports" -eq 1 ]]; then
    echo "  ✓ postgres has one ports: entry"; PASS=$((PASS+1))
else
    echo "  ✗ postgres ports: has $_pg_ports entries, want 1"; FAIL=$((FAIL+1))
fi

# The parser itself: a commented-out entry, or the entry under another service, must not count.
_sp_fixture=$(mktemp)
printf '%s\n' 'services:' '  postgres:' '    ports:' '      # - "a:b"' '      - "c:d"  # note' '    volumes:' '      - "a:b"' '  other:' '    ports:' '      - "e:f"' > "$_sp_fixture"
_assert_var "service ports: real entry, comment stripped"   "$(_service_ports postgres "$_sp_fixture")" '"c:d"'
_assert_var "another service's entry is not ours"           "$(_service_ports postgres "$_sp_fixture" | grep -c 'e:f')" "0"
rm -f "$_sp_fixture"

# --- install.sh: resolve_version ---

echo ""
echo "=== install.sh: resolve_version ==="

# latest (default): release assets + image tag "latest".
CURIA_REF=""; CURIA_VERSION="latest"; resolve_version
_assert_var "latest → release mode" "$ASSET_MODE" "release"
_assert_var "latest → latest/download base" "$ASSET_BASE" "https://github.com/josephfung/curia/releases/latest/download"
_assert_var "latest → image tag latest" "$CURIA_IMAGE_TAG_RESOLVED" "latest"

# vX.Y.Z: that release's assets + matching image tag.
CURIA_REF=""; CURIA_VERSION="v0.41.0"; resolve_version
_assert_var "v0.41.0 → release mode" "$ASSET_MODE" "release"
_assert_var "v0.41.0 → download/<tag> base" "$ASSET_BASE" "https://github.com/josephfung/curia/releases/download/v0.41.0"
_assert_var "v0.41.0 → image tag v0.41.0" "$CURIA_IMAGE_TAG_RESOLVED" "v0.41.0"

# Bare X.Y.Z is normalized to vX.Y.Z.
CURIA_REF=""; CURIA_VERSION="0.41.0"; resolve_version
_assert_var "0.41.0 normalized → image tag v0.41.0" "$CURIA_IMAGE_TAG_RESOLVED" "v0.41.0"
_assert_var "0.41.0 normalized → download/v0.41.0 base" "$ASSET_BASE" "https://github.com/josephfung/curia/releases/download/v0.41.0"

# edge: config from raw main + image tag "edge".
CURIA_REF=""; CURIA_VERSION="edge"; resolve_version
_assert_var "edge → raw mode" "$ASSET_MODE" "raw"
_assert_var "edge → raw main base" "$RAW_BASE" "https://raw.githubusercontent.com/josephfung/curia/main"
_assert_var "edge → image tag edge" "$CURIA_IMAGE_TAG_RESOLVED" "edge"

# CURIA_REF override: raw mode at that ref, no image-tag pin (empty).
CURIA_REF="my-branch"; CURIA_VERSION="latest"; resolve_version
_assert_var "CURIA_REF override → raw mode" "$ASSET_MODE" "raw"
_assert_var "CURIA_REF override → raw base at ref" "$RAW_BASE" "https://raw.githubusercontent.com/josephfung/curia/my-branch"
_assert_var "CURIA_REF override → no image-tag pin" "$CURIA_IMAGE_TAG_RESOLVED" ""

# Invalid version errors (subshell so exit 1 doesn't kill the suite).
if ( CURIA_REF=""; CURIA_VERSION="nope"; resolve_version ) 2>/dev/null; then
    echo "  ✗ invalid version should error"; FAIL=$((FAIL+1))
else
    echo "  ✓ invalid version errors out"; PASS=$((PASS+1))
fi

# Reset globals so nothing downstream inherits test state.
CURIA_REF=""; CURIA_VERSION="latest"; resolve_version

# --- install.sh: ensure_https_app_origin (#2368) ---

echo ""
echo "=== install.sh: ensure_https_app_origin ==="

_ao_env=$(mktemp)
_TLS='COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml\n'
# Echo APP_ORIGIN after the helper runs: <absent>, <empty> or the value.
_ao_got() {
    if grep -qE '^APP_ORIGIN=' "$1"; then local v; v="$(env_value "$1" APP_ORIGIN)"; printf '%s' "${v:-<empty>}"; else printf '<absent>'; fi
}
_assert_ao() {
    local desc="$1" envtxt="$2" want="$3" got
    printf '%b' "$envtxt" > "$_ao_env"
    ( unset COMPOSE_FILE APP_ORIGIN; ensure_https_app_origin "$_ao_env" 2>/dev/null )
    got="$(_ao_got "$_ao_env")"
    if [[ "$got" == "$want" ]]; then
        echo "  ✓ $desc → APP_ORIGIN $want"; PASS=$((PASS+1))
    else
        echo "  ✗ $desc — got $got want $want"; FAIL=$((FAIL+1))
    fi
}
_assert_ao "TLS overlay, missing"            "${_TLS}DOMAIN=x.example\n"                                'https://x.example'
_assert_ao "TLS overlay, empty"              "${_TLS}DOMAIN=x.example\nAPP_ORIGIN=\n"                   'https://x.example'
_assert_ao "TLS overlay, commented template" "${_TLS}DOMAIN=x.example\n# APP_ORIGIN=https://curia.example.com\n" 'https://x.example'
_assert_ao "TLS overlay, quoted DOMAIN"      "${_TLS}DOMAIN=\"x.example\"\n"                            'https://x.example'
_assert_ao "TLS overlay, explicit kept"      "${_TLS}DOMAIN=x.example\nAPP_ORIGIN=https://other.example\n" 'https://other.example'
_assert_ao "TLS overlay, explicit http kept" "${_TLS}DOMAIN=x.example\nAPP_ORIGIN=http://10.0.0.5:3000\n" 'http://10.0.0.5:3000'
_assert_ao "DOMAIN by hand, no overlay"      'DOMAIN=x.example\n'                                         '<absent>'
_assert_ao "local/proxy install untouched"   'HTTP_PORT=3000\nAPP_ORIGIN=\n'                              '<empty>'
_assert_ao "TLS overlay, no DOMAIN"          "${_TLS}"                                                    '<absent>'
_assert_ao "TLS overlay, empty DOMAIN"       "${_TLS}DOMAIN=\n"                                           '<absent>'
_assert_ao "TLS overlay, unresolved DOMAIN"  "${_TLS}"'DOMAIN=${HOST}\n'                                  '<absent>'

# Only one APP_ORIGIN line after filling the commented template line.
printf '%b' "${_TLS}DOMAIN=x.example\n# APP_ORIGIN=https://curia.example.com\n" > "$_ao_env"
( unset COMPOSE_FILE; ensure_https_app_origin "$_ao_env" 2>/dev/null )
_assert_var "commented line replaced, not duplicated" "$(grep -c 'APP_ORIGIN=' "$_ao_env" | tr -d ' ')" "1"

# The upgrade note: printed in note mode when the value is filled, never otherwise.
printf '%b' "${_TLS}DOMAIN=x.example\n" > "$_ao_env"
_ao_out="$( unset COMPOSE_FILE; ensure_https_app_origin "$_ao_env" note 2>&1 )"
_assert_var "note printed when filled on upgrade" "$(grep -c 'https://x.example' <<< "$_ao_out" | tr -d ' ')" "2"
_ao_out="$( unset COMPOSE_FILE; ensure_https_app_origin "$_ao_env" note 2>&1 )"
_assert_var "no note once the value is set"        "$_ao_out" ""

# Both install paths, with Docker and the interactive prompts stubbed out. The
# .env is checked for the origin and for every other line staying as it was.
_ao_paths() {
    local path="$1" envf="$2"
    (
      unset COMPOSE_FILE APP_ORIGIN HTTP_BIND DOMAIN
      docker() { return 0; }
      wait_for_postgres() { :; }; wait_for_curia() { return 0; }
      check_postgres_exposure() { :; }; check_http_exposure() { :; }
      check_livekit_exposure() { :; }; note_livekit_signaling() { :; }
      note_missing_browser() { :; }
      print_summary() { :; }; getent() { return 0; }
      prompt_anthropic_key() { echo sk-ant-test; }
      choose_topology() { echo "$_AO_TOPOLOGY"; }
      gen_secret_hex() { echo genhex; }; gen_secret_b64() { echo genb64; }
      INSTALL_DIR="$(dirname "$envf")"
      if [[ "$path" == fresh ]]; then fresh_install "$envf" <<< "x.example"; else existing_install "$envf"; fi
    ) >/dev/null 2>&1 || { echo "  ✗ $path install aborted"; FAIL=$((FAIL+1)); }
}

# Fresh install, HTTPS topology: missing and empty both get the origin. The seed
# mirrors .env.example's DB_PASSWORD line, which fresh_install reads.
_ao_fresh='DB_PASSWORD=your-db-password\nLOG_LEVEL=info\n'
for _ao_case in missing empty; do
    printf '%b' "$_ao_fresh" > "$_ao_env"
    [[ "$_ao_case" == missing ]] || printf 'APP_ORIGIN=\n' >> "$_ao_env"
    _AO_TOPOLOGY=domain _ao_paths fresh "$_ao_env"
    _assert_var "fresh HTTPS install, $_ao_case → origin" "$(_ao_got "$_ao_env")" "https://x.example"
done
# Fresh install keeps an explicit value (an interrupted install re-run).
printf '%b' "${_ao_fresh}APP_ORIGIN=https://other.example\n" > "$_ao_env"
_AO_TOPOLOGY=domain _ao_paths fresh "$_ao_env"
_assert_var "fresh HTTPS install keeps explicit origin" "$(_ao_got "$_ao_env")" "https://other.example"
# Fresh local and proxy installs write nothing.
for _ao_t in local proxy; do
    printf '%b' "$_ao_fresh" > "$_ao_env"
    _AO_TOPOLOGY=$_ao_t _ao_paths fresh "$_ao_env"
    _assert_var "fresh $_ao_t install → no origin" "$(_ao_got "$_ao_env")" "<absent>"
done

# Existing HTTPS install: repaired; every other line unchanged, secrets included.
_ao_base="${_TLS}DOMAIN=x.example\nHTTP_BIND=127.0.0.1\nDB_PASSWORD=keepme\nSECRET_ENCRYPTION_KEY=keepkey\nLOG_LEVEL=debug\n\n# SETUP_COMPLETE\n"
for _ao_seed in "$_ao_base" "${_ao_base}APP_ORIGIN=\n"; do
    printf '%b' "$_ao_seed" > "$_ao_env"
    _ao_before="$(grep -v '^APP_ORIGIN=' "$_ao_env")"
    _ao_paths existing "$_ao_env"
    _assert_var "existing HTTPS install repaired" "$(_ao_got "$_ao_env")" "https://x.example"
    _assert_var "existing HTTPS install: other lines untouched" "$(grep -v '^APP_ORIGIN=' "$_ao_env" | sed '/^$/d')" "$(sed '/^$/d' <<< "$_ao_before")"
done
# Repeated upgrade runs leave the file byte-for-byte the same.
_ao_snap="$(cat "$_ao_env")"
_ao_paths existing "$_ao_env"; _ao_paths existing "$_ao_env"
_assert_var "repeated upgrade runs are idempotent" "$(cat "$_ao_env")" "$_ao_snap"
# Existing install keeps an explicit value.
printf '%b' "${_ao_base}APP_ORIGIN=https://other.example\n" > "$_ao_env"
_ao_paths existing "$_ao_env"
_assert_var "existing HTTPS install keeps explicit origin" "$(_ao_got "$_ao_env")" "https://other.example"
# Existing non-TLS install and TLS install without a domain: unchanged.
for _ao_seed in 'DOMAIN=x.example\nLOG_LEVEL=info\n# SETUP_COMPLETE\n' "${_TLS}LOG_LEVEL=info\n# SETUP_COMPLETE\n"; do
    printf '%b' "$_ao_seed" > "$_ao_env"
    _ao_snap="$(cat "$_ao_env")"
    _ao_paths existing "$_ao_env"
    _assert_var "existing install without TLS + domain unchanged" "$(grep -v '^HTTP_BIND=' "$_ao_env" | sed '/^$/d')" "$(sed '/^$/d' <<< "$_ao_snap")"
done
rm -f "$_ao_env"

# --- install.sh: note_missing_browser (#2541) ---
# compose_services and curl are stubbed: the install's effective services come
# from _nb_live (or fail when _nb_live_rc is non-zero), and the release's
# docker-compose.yml is _nb_ref (or a failed download when _nb_curl_rc is set).

echo ""
echo "=== install.sh: note_missing_browser ==="

_NB_NEW=$'services:\n  postgres:\n    image: x\n  curia:\n    networks: [default, browser]\n  browser:\n    image: y\nvolumes:\n  browser_profile:\nnetworks:\n  browser:\n'
# A release from before the service: a `browser` network and volume but no service.
_NB_OLD=$'services:\n  postgres:\n    image: x\n  curia:\n    image: z\nvolumes:\n  browser_profile:\nnetworks:\n  browser:\n'

_assert_var "compose_file_services lists services only" \
    "$(compose_file_services <<< "$_NB_NEW" | tr '\n' ' ')" "postgres curia browser "
_assert_var "compose_file_services ignores a browser network or volume" \
    "$(compose_file_services <<< "$_NB_OLD" | tr '\n' ' ')" "postgres curia "

_nb_env=$(mktemp)
# $1 desc, $2 env file contents, $3 live services, $4 live rc, $5 release file, $6 curl rc, $7 want: note | silent
_assert_nb() {
    local desc="$1" got out rc=0
    printf '%b' "$2" > "$_nb_env"
    out="$(
      unset BROWSER_CDP_URL
      _nb_live="$3"; _nb_live_rc="$4"; _nb_ref="$5"; _nb_curl_rc="$6"
      compose_services() { [[ "$_nb_live_rc" == 0 ]] || return 1; printf '%s\n' "$_nb_live"; }
      curl() {
        local o=""
        while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && o="$2"; shift; done
        [[ "$_nb_curl_rc" == 0 ]] || return "$_nb_curl_rc"
        printf '%s' "$_nb_ref" > "$o"
      }
      note_missing_browser "$_nb_env" 2>&1
    )" || rc=$?
    if [[ "$rc" != 0 ]]; then got="exit $rc"
    elif grep -q "no browser service" <<< "$out"; then got=note
    elif [[ -z "$out" ]]; then got=silent
    else got="other output: $out"
    fi
    if [[ "$got" == "$7" ]]; then
        echo "  ✓ browser note: $desc → $7"; PASS=$((PASS+1))
    else
        echo "  ✗ browser note: $desc — got $got want $7"; FAIL=$((FAIL+1))
    fi
}
_old_live=$'postgres\ncuria'
_assert_nb "old compose, release has the service"     ''                                   "$_old_live"                 0 "$_NB_NEW" 0  note
_assert_nb "compose already has the service"          ''                                   $'postgres\ncuria\nbrowser'  0 "$_NB_NEW" 0  silent
_assert_nb "BROWSER_CDP_URL points elsewhere"         'BROWSER_CDP_URL=http://chrome:9222\n' "$_old_live"               0 "$_NB_NEW" 0  silent
_assert_nb "pinned release predates the service"      ''                                   "$_old_live"                 0 "$_NB_OLD" 0  silent
_assert_nb "compose config unreadable"                 ''                                   ''                           1 "$_NB_NEW" 0  silent
_assert_nb "release file download fails"               ''                                   "$_old_live"                 0 "$_NB_NEW" 22 silent

# The note names the docs page and the release's own compose file.
printf '' > "$_nb_env"
_nb_out="$(
  unset BROWSER_CDP_URL
  compose_services() { printf 'postgres\ncuria\n'; }
  curl() { local o=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && o="$2"; shift; done; printf '%s' "$_NB_NEW" > "$o"; }
  note_missing_browser "$_nb_env" 2>&1
)"
_assert_var "note links the upgrade docs" \
    "$(grep -c 'docs.meetcuria.com/integrations/web-browser#upgrading-from-an-older-install' <<< "$_nb_out" | tr -d ' ')" "1"
_assert_var "note links this release's compose file" \
    "$(grep -cF "$(bundle_asset_url docker-compose.yml docker-compose.yml)" <<< "$_nb_out" | tr -d ' ')" "1"
rm -f "$_nb_env"

# --- install.sh: fetch_asset leaves no partial file ---

echo ""
echo "=== install.sh: fetch_asset ==="

# curl stubbed: writes some bytes, then fails (or succeeds) per _curl_rc.
_fa_dir=$(mktemp -d)
curl() {
    local out=""
    while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done
    printf 'partial' > "$out"
    return "$_curl_rc"
}
_saved_install_dir="$INSTALL_DIR"; INSTALL_DIR="$_fa_dir"; mkdir -p "$_fa_dir/docker"

_curl_rc=56
if fetch_asset docker/seccomp-chrome.json seccomp-chrome.json; then _fa_rc=0; else _fa_rc=1; fi
_assert_var "a failed fetch returns failure" "$_fa_rc" "1"
_assert_var "a failed fetch leaves no partial profile" "$(ls -A "$_fa_dir/docker")" ""

printf 'hand-edited' > "$_fa_dir/docker-compose.yml"
if fetch_asset docker-compose.yml docker-compose.yml; then _fa_rc=0; else _fa_rc=1; fi
_assert_var "a failed fetch leaves an existing file as it was" "$(< "$_fa_dir/docker-compose.yml")" "hand-edited"

_curl_rc=0
fetch_asset docker/seccomp-chrome.json seccomp-chrome.json
_assert_var "a successful fetch lands the file" "$(< "$_fa_dir/docker/seccomp-chrome.json")" "partial"
_assert_var "a successful fetch leaves no temp file" "$(ls -A "$_fa_dir/docker")" "seccomp-chrome.json"
_assert_var "a fetched file gets the umask mode, not mktemp's 0600" \
    "$( (umask 022; fetch_asset docker/seccomp-chrome.json seccomp-chrome.json; find "$_fa_dir/docker/seccomp-chrome.json" -perm 0644) )" \
    "$_fa_dir/docker/seccomp-chrome.json"

# Another run's in-flight download of the same asset (its temp file) is never
# written to or removed, on success or failure, and each transfer uses its own file.
_fa_outs=()
curl() {
    local out=""
    while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done
    _fa_outs+=("$out")
    printf 'mine' > "$out"
    return "$_curl_rc"
}
printf 'theirs' > "$_fa_dir/docker-compose.yml.part"
_curl_rc=56
fetch_asset docker-compose.yml docker-compose.yml || true
_curl_rc=0
fetch_asset docker-compose.yml docker-compose.yml
_assert_var "another run's temp file survives a failed and a successful fetch" \
    "$(< "$_fa_dir/docker-compose.yml.part")" "theirs"
_assert_var "each transfer writes its own temp file" \
    "$([[ "${_fa_outs[0]}" != "${_fa_outs[1]}" && "${_fa_outs[0]}" != "$_fa_dir/docker-compose.yml.part" ]] && echo distinct)" "distinct"
_assert_var "the successful fetch landed its own bytes" "$(< "$_fa_dir/docker-compose.yml")" "mine"

unset -f curl
INSTALL_DIR="$_saved_install_dir"
rm -rf "$_fa_dir"

# --- Results ---

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
