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

# --- Provider credential validators (#2749) ---

# $1 validator, $2 expected (valid|invalid), $3 value, $4 description.
_assert_validator() {
    local got=invalid
    if "$1" "$3" 2>/dev/null; then got=valid; fi
    if [[ "$got" == "$2" ]]; then
        echo "  ✓ $4"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $4 — expected '$3' to be $2 for $1"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "=== validate_openrouter_key ==="
_assert_validator validate_openrouter_key valid   "sk-or-v1-0123abcdef" "accepts sk-or-v1-..."
_assert_validator validate_openrouter_key invalid "sk-ant-api03-abc"    "rejects an Anthropic key"
_assert_validator validate_openrouter_key invalid "sk-or-"              "rejects sk-or- with empty suffix"
_assert_validator validate_openrouter_key invalid "sk-or-v1 abc"        "rejects a key with spaces"
_assert_validator validate_openrouter_key invalid ""                    "rejects empty string"

echo ""
echo "=== validate_aws_access_key_id ==="
# Fake key IDs are built at runtime: a literal in the AKIA/ASIA shape trips
# GitHub secret scanning even when it is AWS's documented placeholder.
_fake16="FAKEKEYFORTESTS0"
_assert_validator validate_aws_access_key_id valid   "AK""IA$_fake16"        "accepts AKIA + 16"
_assert_validator validate_aws_access_key_id invalid "AS""IA$_fake16"        "rejects a temporary ASIA key (needs a session token)"
_assert_validator validate_aws_access_key_id invalid "AK""IA${_fake16%?}"    "rejects 15 characters after AKIA"
_assert_validator validate_aws_access_key_id invalid "ak""ia$_fake16"        "rejects lowercase"
_assert_validator validate_aws_access_key_id invalid ""                      "rejects empty string"

echo ""
echo "=== validate_aws_secret_access_key ==="
_assert_validator validate_aws_secret_access_key valid   "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" "accepts 40 base64 characters"
_assert_validator validate_aws_secret_access_key invalid "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE"  "rejects 39 characters"
_assert_validator validate_aws_secret_access_key invalid "wJalrXUtnFEMI-K7MDENG/bPxRfiCYEXAMPLEKEY" "rejects a '-'"
_assert_validator validate_aws_secret_access_key invalid ""                                         "rejects empty string"

echo ""
echo "=== validate_aws_region ==="
_assert_validator validate_aws_region valid   "us-east-1"      "accepts us-east-1"
_assert_validator validate_aws_region valid   "ap-southeast-2" "accepts ap-southeast-2"
_assert_validator validate_aws_region valid   "us-gov-west-1"  "accepts us-gov-west-1"
_assert_validator validate_aws_region invalid "us-east"        "rejects a region with no number"
_assert_validator validate_aws_region invalid "US-EAST-1"      "rejects uppercase"
_assert_validator validate_aws_region invalid ""               "rejects empty string"

echo ""
echo "=== prompt_validated ==="
_pv_rc=0
_pv_out="$(prompt_validated "region" validate_aws_region "bad" "hint" visible 2>/dev/null <<< $'nope\nus-east-1')" || _pv_rc=$?
_assert_validator validate_aws_region valid "$_pv_out" "retries, then echoes the valid value"
_pv_out="$(prompt_validated "region" validate_aws_region "bad" "hint" visible 2>/dev/null <<< '  us-east-1  ')"
if [[ "$_pv_out" == us-east-1 ]]; then echo "  ✓ trims a pasted value before checking it"; PASS=$((PASS + 1)); else echo "  ✗ trims a pasted value before checking it — got '$_pv_out'"; FAIL=$((FAIL + 1)); fi
_pv_rc=0
( prompt_validated "region" validate_aws_region "bad" "hint" visible <<< $'a\nb\nc' ) >/dev/null 2>&1 || _pv_rc=$?
if [[ $_pv_rc -ne 0 ]]; then echo "  ✓ exits non-zero after 3 bad answers"; PASS=$((PASS + 1)); else echo "  ✗ exits non-zero after 3 bad answers"; FAIL=$((FAIL + 1)); fi

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

# The LiveKit assertions below read what write_env puts in .env; a value the caller's
# shell sets would suppress the write.
unset COMPOSE_PROFILES LIVEKIT_KEYS LIVEKIT_COMMAND

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

# LiveKit is on by default for source installs (#2357): voice profile, generated keys,
# loopback command.
assert_true  "COMPOSE_PROFILES=voice written"          "$_tmp_env" "COMPOSE_PROFILES=voice"
assert_true  "LIVEKIT_KEYS generated"                  "$_tmp_env" 'LIVEKIT_KEYS=API'
assert_true  "LIVEKIT_COMMAND is the local command"    "$_tmp_env" "LIVEKIT_COMMAND=$(livekit_command_for local)"

# A preserved key (full reset) is kept, not regenerated.
PRESERVED_LIVEKIT_KEYS="APIkeep: keepsecret"
write_env
assert_true  "preserved LIVEKIT_KEYS kept"             "$_tmp_env" 'LIVEKIT_KEYS=APIkeep: keepsecret'
PRESERVED_LIVEKIT_KEYS=""

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

# Test option 3 (confirm): "3\nyes" keeps .env and its key, sets SETUP_MODE=full
printf 'DB_USER=curia\nSECRET_ENCRYPTION_KEY=keepme\n' > "$_menu_env"
_opt3_rc=0
(
    ENV_FILE="$_menu_env"
    SETUP_MODE="resume"
    handle_existing_env < <(printf "3\nyes\n")
    # .env stays until write_env replaces it, so a setup that stops partway keeps
    # the encryption key (#2749); the preserved key is read and the mode changes.
    if [[ -f "$ENV_FILE" ]] && [[ "$SETUP_MODE" == "full" ]] && [[ -n "$PRESERVED_ENCRYPTION_KEY" ]]; then
        exit 0
    else
        exit 1
    fi
) 2>/dev/null || _opt3_rc=$?
if [[ $_opt3_rc -eq 0 ]] && [[ -f "$_menu_env" ]]; then
    echo "  ✓ option 3 + 'yes' keeps .env, preserves its key and sets SETUP_MODE=full"
    PASS=$((PASS + 1))
else
    echo "  ✗ option 3 + 'yes' should keep .env, preserve its key and set SETUP_MODE=full"
    FAIL=$((FAIL + 1))
fi

# Test option 3 (confirm) carries LIVEKIT_KEYS over into PRESERVED_LIVEKIT_KEYS
printf 'DB_USER=curia\nLIVEKIT_KEYS="APIkeep: keepsecret"\n' > "$_menu_env"
_opt3k_out=$(
    ENV_FILE="$_menu_env"
    PRESERVED_LIVEKIT_KEYS=""
    handle_existing_env < <(printf "3\nyes\n") >/dev/null 2>&1
    printf '%s' "$PRESERVED_LIVEKIT_KEYS"
) || true
if [[ "$_opt3k_out" == "APIkeep: keepsecret" ]]; then
    echo "  ✓ full reset keeps LIVEKIT_KEYS"
    PASS=$((PASS + 1))
else
    echo "  ✗ full reset should keep LIVEKIT_KEYS (got '${_opt3k_out}')"
    FAIL=$((FAIL + 1))
fi

# build_livekit_seed_env: LiveKit seed args for full and resume alike, nothing else
unset COMPOSE_PROFILES LIVEKIT_KEYS LIVEKIT_COMMAND
_lk_seed_env=$(mktemp)
printf 'COMPOSE_PROFILES=voice\nLIVEKIT_KEYS="APIres: ressecret"\nLIVEKIT_COMMAND=--config /etc/livekit.local.yaml\n' > "$_lk_seed_env"
build_livekit_seed_env "$_lk_seed_env"
_lk_joined=" ${LIVEKIT_SEED_ENV[*]} "
if [[ "$_lk_joined" == *" SEED_LIVEKIT_URL=ws://localhost:7880 "* \
   && "$_lk_joined" == *" SEED_LIVEKIT_API_KEY=APIres "* \
   && "$_lk_joined" == *" SEED_LIVEKIT_API_SECRET=ressecret "* \
   && "$_lk_joined" != *ANTHROPIC_API_KEY* && "$_lk_joined" != *API_TOKEN=* \
   && "$_lk_joined" != *WEB_APP_BOOTSTRAP_SECRET* ]]; then
    echo "  ✓ build_livekit_seed_env yields only SEED_LIVEKIT_* from .env"
    PASS=$((PASS + 1))
else
    echo "  ✗ build_livekit_seed_env should yield only SEED_LIVEKIT_* entries"
    FAIL=$((FAIL + 1))
fi
printf 'DB_USER=curia\n' > "$_lk_seed_env"
build_livekit_seed_env "$_lk_seed_env"
if [[ ${#LIVEKIT_SEED_ENV[@]} -eq 0 ]]; then
    echo "  ✓ build_livekit_seed_env yields nothing for an old .env"
    PASS=$((PASS + 1))
else
    echo "  ✗ old .env without LiveKit values should yield no seed args"
    FAIL=$((FAIL + 1))
fi
rm -f "$_lk_seed_env"

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
_assert_output "contains the Setup page URL"                 "http://localhost:3000/setup"
_assert_output "contains the full secret"                   "$_test_secret"
_assert_output "contains 'Bootstrap secret' label"          "Bootstrap secret"
_assert_output "contains password manager instruction"      "save this to a password manager"
_assert_output "contains login instruction"                 "Enter it on the login page"
_assert_output "contains box top-left corner"               "╔"
_assert_output "contains box bottom-right corner"           "╝"
_summary_output=$(print_summary "" "https://c.example.com/")
_assert_output "given base URL: its Setup page"             "https://c.example.com/setup"

# --- setup-common: secret generator tests ---

echo ""
echo "=== setup-common: secret generators ==="
key_b64="$(gen_secret_b64)"
# base64 of 32 bytes is 44 chars ending in '='
if [[ "${#key_b64}" -eq 44 ]]; then echo "  ✓ gen_secret_b64 length 44"; PASS=$((PASS+1)); else echo "  ✗ gen_secret_b64 length ${#key_b64}"; FAIL=$((FAIL+1)); fi
key_hex="$(gen_secret_hex)"
if [[ "${#key_hex}" -eq 64 ]]; then echo "  ✓ gen_secret_hex length 64"; PASS=$((PASS+1)); else echo "  ✗ gen_secret_hex length ${#key_hex}"; FAIL=$((FAIL+1)); fi

# --- setup-common: wait_* with no COMPOSE_FLAGS under set -u ---
# install.sh sets COMPOSE_FLAGS=() and macOS ships bash 3.2, where "${empty[@]}" is
# unbound under `set -u`. Run in /bin/bash when it exists, with docker stubbed healthy.

echo ""
echo "=== setup-common: wait_* with empty COMPOSE_FLAGS ==="
_wf_bash=/bin/bash; [[ -x "$_wf_bash" ]] || _wf_bash=bash
for _wf_fn in wait_for_postgres wait_for_curia; do
    _wf_out="$("$_wf_bash" -c '
        set -euo pipefail
        source "$1"
        docker() {
            case "$*" in
                *" ps -q "*) echo cid123 ;;
                *State.Health.Status*) echo healthy ;;
                *State.Status*) echo running ;;
                *RestartCount*) echo 0 ;;
                *) echo healthy ;;
            esac
        }
        sleep() { :; }
        REPO_ROOT=/tmp COMPOSE_FLAGS=()
        "$2" >/dev/null 2>&1
        echo ok' _ "$TEST_DIR/../../scripts/setup-common.sh" "$_wf_fn" 2>&1)" || true
    if [[ "$_wf_out" == *ok ]]; then
        echo "  ✓ $_wf_fn runs with empty COMPOSE_FLAGS under set -u"; PASS=$((PASS+1))
    else
        echo "  ✗ $_wf_fn failed with empty COMPOSE_FLAGS: $_wf_out"; FAIL=$((FAIL+1))
    fi
done

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
_assert_lk "installer-managed local command, loopback" 'LIVEKIT_COMMAND=--config /etc/livekit.local.yaml --node-ip 127.0.0.1\n' '127.0.0.1:7880' quiet
_assert_lk "installer-managed public command, loopback" 'LIVEKIT_COMMAND=--config /etc/livekit.yaml\n' '127.0.0.1:7880' quiet
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
      choose_provider() { echo anthropic; }
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

# --- setup-common: livekit helpers ---

echo ""
echo "=== setup-common: livekit helpers ==="

_lk_k1="$(gen_livekit_keys)"; _lk_k2="$(gen_livekit_keys)"
_assert_var "gen_livekit_keys format" \
    "$([[ "$_lk_k1" =~ ^API[A-Za-z0-9]{12}:\ [0-9a-f]{64}$ ]] && echo ok)" "ok"
_assert_var "gen_livekit_keys differs per call" "$([[ "$_lk_k1" != "$_lk_k2" ]] && echo ok)" "ok"

_assert_var "seed from LIVEKIT_KEYS" "$(livekit_seed_keys 'APIabc: s3cr3t' '')" "APIabc s3cr3t"
_assert_var "seed from quoted LIVEKIT_KEYS" "$(livekit_seed_keys '"APIabc: s3cr3t"' '')" "APIabc s3cr3t"
_assert_var "seed from LIVEKIT_KEYS with extra spaces" "$(livekit_seed_keys '  APIabc :   s3cr3t ' '--dev')" "APIabc s3cr3t"
_assert_var "seed from --keys" "$(livekit_seed_keys '' '--config /x --keys "APIk: sec"')" "APIk sec"
_assert_var "seed from --keys=" "$(livekit_seed_keys '' "--config /x --keys='APIk: sec'")" "APIk sec"
_assert_var "seed from --dev" "$(livekit_seed_keys '' '--dev --bind 0.0.0.0')" "devkey secret"
_assert_var "--keys wins over LIVEKIT_KEYS" "$(livekit_seed_keys 'APIenv: envsecret' '--config /x --keys "APIk: sec"')" "APIk sec"
_lk_rc=0; livekit_seed_keys 'APIenv: envsecret' '--config /x --key-file /keys.yaml' >/dev/null || _lk_rc=$?
_assert_var "--key-file: unknown" "$_lk_rc" "1"
_assert_var "seed from empty command" "$(livekit_seed_keys '' '')" "devkey secret"
_lk_rc=0; _lk_out="$(livekit_seed_keys '' '--config /etc/livekit.yaml')" || _lk_rc=$?
_assert_var "seed unknown: empty output" "$_lk_out" ""
_assert_var "seed unknown: rc 1" "$_lk_rc" "1"

_assert_var "command for local" "$(livekit_command_for local)" "--config /etc/livekit.local.yaml --node-ip 127.0.0.1"
_assert_var "command for public" "$(livekit_command_for public)" "--config /etc/livekit.yaml"

_lk_env="$(mktemp)"
cp "$TEST_DIR/../../.env.example" "$_lk_env"
unset LIVEKIT_KEYS LIVEKIT_COMMAND COMPOSE_PROFILES
ensure_livekit_env "$_lk_env" local
_assert_var "fresh: COMPOSE_PROFILES" "$(env_value "$_lk_env" COMPOSE_PROFILES)" "voice"
_assert_var "fresh: LIVEKIT_KEYS format" \
    "$([[ "$(env_value "$_lk_env" LIVEKIT_KEYS)" =~ ^API[A-Za-z0-9]{12}:\ [0-9a-f]{64}$ ]] && echo ok)" "ok"
_assert_var "fresh: LIVEKIT_KEYS is unquoted (setup.sh exports .env raw)" \
    "$(grep -cE '^LIVEKIT_KEYS=API[A-Za-z0-9]{12}: [0-9a-f]{64}$' "$_lk_env")" "1"
_assert_var "fresh: LIVEKIT_COMMAND" "$(env_value "$_lk_env" LIVEKIT_COMMAND)" "$(livekit_command_for local)"

printf 'LIVEKIT_KEYS="APIold: oldsecret"\nLIVEKIT_COMMAND=--config /mine.yaml\n' > "$_lk_env"
ensure_livekit_env "$_lk_env" public
_assert_var "keeps existing LIVEKIT_KEYS" "$(env_value "$_lk_env" LIVEKIT_KEYS)" "APIold: oldsecret"
_assert_var "keeps operator LIVEKIT_COMMAND" "$(env_value "$_lk_env" LIVEKIT_COMMAND)" "--config /mine.yaml"

: > "$_lk_env"
LIVEKIT_COMMAND="--dev" LIVEKIT_KEYS="APIsh: shsecret" ensure_livekit_env "$_lk_env" public
_assert_var "shell LIVEKIT_COMMAND blocks the write" "$(grep -c '^LIVEKIT_COMMAND=' "$_lk_env")" "0"
_assert_var "shell LIVEKIT_KEYS blocks the write" "$(grep -c '^LIVEKIT_KEYS=' "$_lk_env")" "0"

printf 'COMPOSE_PROFILES=signal\n' > "$_lk_env"
ensure_livekit_env "$_lk_env" public
_assert_var "appends voice to profiles" "$(env_value "$_lk_env" COMPOSE_PROFILES)" "signal,voice"
printf 'COMPOSE_PROFILES=voice,x\n' > "$_lk_env"
ensure_livekit_env "$_lk_env" public
_assert_var "profiles already with voice unchanged" "$(env_value "$_lk_env" COMPOSE_PROFILES)" "voice,x"
_assert_var "public: LIVEKIT_COMMAND" "$(env_value "$_lk_env" LIVEKIT_COMMAND)" "--config /etc/livekit.yaml"
: > "$_lk_env"
_lk_w="$(COMPOSE_PROFILES=signal ensure_livekit_env "$_lk_env" public 2>&1 >/dev/null)"
_assert_var "shell profiles without voice: .env has no COMPOSE_PROFILES" "$(grep -c '^COMPOSE_PROFILES=' "$_lk_env")" "0"
_assert_var "shell profiles without voice: warns" "$([[ "$_lk_w" == *"without 'voice'"* ]] && echo ok)" "ok"
: > "$_lk_env"
_lk_w="$(COMPOSE_PROFILES=voice,x LIVEKIT_KEYS=a:b LIVEKIT_COMMAND=--dev ensure_livekit_env "$_lk_env" public 2>&1)"
_assert_var "shell profiles with voice: .env untouched" "$(grep -c '^COMPOSE_PROFILES=' "$_lk_env")" "0"
_assert_var "shell profiles with voice: silent" "$_lk_w" ""
: > "$_lk_env"
_lk_w="$(LIVEKIT_COMMAND= ensure_livekit_env "$_lk_env" public 2>&1 >/dev/null)"
_assert_var "empty shell LIVEKIT_COMMAND: not written" "$(grep -c '^LIVEKIT_COMMAND=' "$_lk_env")" "0"
_assert_var "empty shell LIVEKIT_COMMAND: warns" "$([[ "$_lk_w" == *LIVEKIT_COMMAND* ]] && echo ok)" "ok"
: > "$_lk_env"
_lk_w="$(LIVEKIT_KEYS= ensure_livekit_env "$_lk_env" public 2>&1 >/dev/null)"
_assert_var "empty shell LIVEKIT_KEYS: not written" "$(grep -c '^LIVEKIT_KEYS=' "$_lk_env")" "0"
_assert_var "empty shell LIVEKIT_KEYS: warns" "$([[ "$_lk_w" == *LIVEKIT_KEYS* ]] && echo ok)" "ok"
rm -f "$_lk_env"

# --- install.sh: topology ---

echo ""
echo "=== install.sh: topology ==="

_assert_var "topology: empty -> domain" "$(topology_for_choice "")" "domain"
_assert_var "topology: 1 -> domain" "$(topology_for_choice 1)" "domain"
_assert_var "topology: 2 -> proxy" "$(topology_for_choice 2)" "proxy"
_assert_var "topology: 3 -> local" "$(topology_for_choice 3)" "local"
_assert_var "topology: unknown -> domain" "$(topology_for_choice x)" "domain"

_assert_var "normalize_origin strips trailing slash" "$(normalize_origin 'https://curia.example.com/')" "https://curia.example.com"
_assert_var "normalize_origin lowercases scheme" "$(normalize_origin 'HTTPS://h.example.com:8443')" "https://h.example.com:8443"
_assert_var "normalize_origin keeps http host:port" "$(normalize_origin 'http://10.0.0.5:3000')" "http://10.0.0.5:3000"
for _no_bad in 'curia.example.com' 'https://h.example.com/curia' 'https://h .com' 'https://' 'https://h.com?x=1' 'https://h.com#f'; do
    if normalize_origin "$_no_bad" >/dev/null 2>&1; then _no_rc=0; else _no_rc=1; fi
    _assert_var "normalize_origin rejects '$_no_bad'" "$_no_rc" "1"
done

_assert_var "livekit url: domain" "$(livekit_browser_url domain curia.example.com)" "wss://curia.example.com"
_assert_var "livekit url: proxy https" "$(livekit_browser_url proxy https://h.example.com:8443)" "wss://h.example.com:8443"
_assert_var "livekit url: proxy http" "$(livekit_browser_url proxy http://10.0.0.5:3000)" "ws://10.0.0.5:3000"
_assert_var "livekit url: proxy empty" "$(livekit_browser_url proxy '')" "ws://localhost:7880"
_assert_var "livekit url: local" "$(livekit_browser_url local '')" "ws://localhost:7880"
for _lu in "$(livekit_browser_url domain d.com)" "$(livekit_browser_url proxy https://h.com)" "$(livekit_browser_url local '')"; do
    _assert_var "livekit url never ends in /rtc ($_lu)" "$([[ "$_lu" == */rtc ]] && echo bad || echo ok)" "ok"
done

# --- setup-common: print_next_steps ---

echo ""
echo "=== print_next_steps ==="

_has() { [[ "$1" == *"$2"* ]] && echo yes || echo no; }
_pns="$(print_next_steps domain on 2>&1)" || true
_assert_var "domain: setup page"       "$(_has "$_pns" 'Finish setting up Curia in your browser at the address above.')" yes
_assert_var "domain: docs guide"       "$(_has "$_pns" 'Guide: https://docs.meetcuria.com/get-started/check-your-setup')" yes
_assert_var "domain: Start onboarding" "$(_has "$_pns" 'When every step is done, choose Start onboarding.')" yes
_assert_var "domain: voice on"         "$(_has "$_pns" 'Voice (LiveKit): on.')" yes
_assert_var "domain: RTC ports"        "$(_has "$_pns" 'Open these ports for calls: 7881/tcp, 7882/udp')" yes
_assert_var "domain: no proxy rule"    "$(_has "$_pns" '/rtc* to')" no
_pns="$(print_next_steps proxy on 2>&1)" || true
_assert_var "proxy: forwarding line"   "$(_has "$_pns" 'Your proxy must forward / to port 3000 and /rtc* to 127.0.0.1:7880 on this host.')" yes
_assert_var "proxy: RTC ports"         "$(_has "$_pns" '7881/tcp, 7882/udp')" yes
_pns="$(print_next_steps local on 2>&1)" || true
_assert_var "local: no RTC ports"      "$(_has "$_pns" '7881/tcp')" no
_assert_var "local: no proxy rule"     "$(_has "$_pns" '/rtc*')" no
_pns="$(print_next_steps domain off 2>&1)" || true
_assert_var "voice off: says so"       "$(_has "$_pns" 'Voice (LiveKit): off.')" yes
_assert_var "voice off: no RTC ports"  "$(_has "$_pns" '7881/tcp')" no

_assert_var "setup url: domain"        "$(setup_base_url domain c.example.com 2>&1 || true)" "https://c.example.com"
_assert_var "setup url: proxy origin"  "$(setup_base_url proxy https://p.example.com 2>&1 || true)" "https://p.example.com"
_assert_var "setup url: proxy, no origin" "$( (unset HTTP_PORT; setup_base_url proxy '') 2>&1 || true)" "http://localhost:3000"
_assert_var "setup url: local, HTTP_PORT" "$( (HTTP_PORT=3100; setup_base_url local '') 2>&1 || true)" "http://localhost:3100"
_assert_var "setup url: domain, none known" "$( (unset HTTP_PORT; setup_base_url domain '') 2>&1 || true)" "http://localhost:3000"

# --- install.sh: an older setup-common.sh on disk (upgrade skew, #2357) ---
# An install from an older release keeps its setup-common.sh, which lacks
# ensure_livekit_env. install.sh fetches this release's copy over it; when the
# fetch fails (or is still old) it stops with a hint instead of crashing later.

echo ""
echo "=== install.sh: older setup-common.sh on disk ==="
_sk_dir="$(mktemp -d)"; mkdir -p "$_sk_dir/inst/scripts" "$_sk_dir/bin"
cp "$TEST_DIR/../../install.sh" "$_sk_dir/inst/install.sh"
_sk_old() { printf 'info() { :; }\nwarn() { :; }\nerror() { :; }\nhint() { :; }\n' > "$_sk_dir/inst/scripts/setup-common.sh"; }
# Fake curl: copy this checkout's setup-common.sh to the -o target, or fail.
cat > "$_sk_dir/bin/curl" <<CURL
#!/usr/bin/env bash
[[ -n "\${SK_CURL_OK:-}" ]] || exit 22
while [[ \$# -gt 0 ]]; do [[ "\$1" == -o ]] && { cp "$TEST_DIR/../../scripts/setup-common.sh" "\$2"; exit 0; }; shift; done
exit 22
CURL
chmod +x "$_sk_dir/bin/curl"
_sk_old
_sk_out="$(PATH="$_sk_dir/bin:$PATH" SK_CURL_OK=1 bash -c 'source "$1"; declare -F ensure_livekit_env >/dev/null && echo refreshed' _ "$_sk_dir/inst/install.sh" 2>&1)" || true
_assert_var "old copy, fetch works: refreshed" "$([[ "$_sk_out" == *refreshed* ]] && echo yes || echo no)" yes
_sk_old
_sk_rc=0
_sk_out="$(PATH="$_sk_dir/bin:$PATH" bash -c 'source "$1"; echo continued' _ "$_sk_dir/inst/install.sh" 2>&1)" || _sk_rc=$?
_assert_var "old copy, fetch fails: stops" "$_sk_rc" "1"
_assert_var "old copy, fetch fails: says why" "$([[ "$_sk_out" == *"older than this installer"* ]] && echo yes || echo no)" yes
rm -rf "$_sk_dir"

# --- install.sh: fetch_bundle fetches the LiveKit configs the compose file mounts ---

echo ""
echo "=== install.sh: fetch_bundle livekit.yaml ==="

_fb_dir="$(mktemp -d)"
_fb_calls="$(mktemp)"
# $1 = compose file contents; prints the fetch_asset calls, one per line.
_fb_run() {
    rm -rf "$_fb_dir"; mkdir -p "$_fb_dir/deploy"
    printf '%s' "$1" > "$_fb_dir/docker-compose.yml"
    : > "$_fb_dir/docker-compose.tls.yml"; : > "$_fb_dir/.env.example"; : > "$_fb_dir/deploy/Caddyfile"
    [[ -z "${_FB_EXISTING:-}" ]] || { mkdir -p "$_fb_dir/docker"; : > "$_fb_dir/docker/livekit.yaml"; : > "$_fb_dir/docker/livekit.local.yaml"; }
    : > "$_fb_calls"
    (
      INSTALL_DIR="$_fb_dir"
      fetch_asset() { printf '%s:%s\n' "$1" "$2" >> "$_fb_calls"; }
      fetch_bundle
    ) >/dev/null 2>&1 || true
    tr '\n' ' ' < "$_fb_calls"
}
_FB_LK=$'services:\n  livekit:\n    volumes:\n      - ./docker/livekit.yaml:/etc/livekit.yaml:ro\n      - ./docker/livekit.local.yaml:/etc/livekit.local.yaml:ro\n'
_FB_LK_PUBLIC_ONLY=$'services:\n  livekit:\n    volumes:\n      - ./docker/livekit.yaml:/etc/livekit.yaml:ro\n'
_FB_OLD=$'services:\n  livekit:\n    command: --dev\n'
_assert_var "compose mounts both: both fetched" "$(_fb_run "$_FB_LK")" "docker/livekit.yaml:livekit.yaml docker/livekit.local.yaml:livekit.local.yaml "
_assert_var "compose mounts livekit.yaml only" "$(_fb_run "$_FB_LK_PUBLIC_ONLY")" "docker/livekit.yaml:livekit.yaml "
_assert_var "older compose without the mounts: nothing fetched" "$(_fb_run "$_FB_OLD")" ""
_FB_COMMENT=$'services:\n  livekit:\n    # mount ./docker/livekit.yaml:/etc/livekit.yaml for a real config\n    command: --dev\n'
_assert_var "mount named in a comment only: nothing fetched" "$(_fb_run "$_FB_COMMENT")" ""
_FB_EXISTING=1
_assert_var "files already present: nothing fetched" "$(_fb_run "$_FB_LK")" ""
_FB_EXISTING=""
rm -rf "$_fb_dir" "$_fb_calls"

# --- install.sh: note_voice_off (upgrade path) ---

echo ""
echo "=== note_voice_off ==="

_nv_env="$(mktemp)"
# $1 env contents, $2 shell COMPOSE_PROFILES ("-" = unset), $3 running (1/""), $4 want: note | silent
_assert_nv() {
    local out got
    printf '%b' "$1" > "$_nv_env"
    out="$(
      unset COMPOSE_PROFILES
      [[ "$2" == - ]] || export COMPOSE_PROFILES="$2"
      _nv_running="$3"
      service_running() { [[ -n "$_nv_running" ]]; }
      note_voice_off "$_nv_env" 2>&1
    )" || true
    if [[ "$out" == *"Voice (LiveKit) is off on this install."* ]]; then got=note
    elif [[ -z "$out" ]]; then got=silent; else got="other: $out"; fi
    _assert_var "note_voice_off: $5" "$got" "$4"
}
_assert_nv ''                           -          ''  note   "profiles unset, not running"
_assert_nv 'COMPOSE_PROFILES=voice\n'   -          ''  silent "COMPOSE_PROFILES=voice in .env"
_assert_nv 'COMPOSE_PROFILES=signal,voice\n' -     ''  silent "voice in a profile list"
_assert_nv 'COMPOSE_PROFILES=voices\n'  -          ''  note   "voices is not voice"
_assert_nv ''                           voice      ''  silent "COMPOSE_PROFILES=voice in the shell"
_assert_nv 'COMPOSE_PROFILES=voice\n'   ''         ''  note   "shell empty COMPOSE_PROFILES wins over .env"
_assert_nv ''                           -          1   silent "livekit running"
_nv_out="$( unset COMPOSE_PROFILES; service_running() { return 1; }; note_voice_off "$_nv_env" 2>&1 )" || true
_assert_var "note_voice_off names the voice docs" "$(_has "$_nv_out" 'voice-setup')" yes
rm -f "$_nv_env"

# --- install.sh: LiveKit --dev on public installs (fail closed, #2357) ---

echo ""
echo "=== install.sh: LiveKit --dev on public installs ==="

_rk_env="$(mktemp)"
# $1 topology, $2 proxy origin, $3 env contents, $4 shell LIVEKIT_COMMAND ("-" = unset), $5 want: ok | stopped
_assert_rk() {
    local got
    printf '%b' "$3" > "$_rk_env"
    if (
      unset LIVEKIT_COMMAND
      [[ "$4" == - ]] || export LIVEKIT_COMMAND="$4"
      TOPOLOGY="$1"; PROXY_ORIGIN="$2"
      require_livekit_real_keys "$_rk_env"
    ) >/dev/null 2>&1; then got=ok; else got=stopped; fi
    _assert_var "real keys: $6" "$got" "$5"
}
_RK_REAL='LIVEKIT_COMMAND=--config /etc/livekit.yaml\n'
_RK_DEV='LIVEKIT_COMMAND=--dev --bind 0.0.0.0\n'
_assert_rk domain ''                  "$_RK_REAL" -       ok      "domain, real config"
_assert_rk domain ''                  "$_RK_DEV"  -       stopped "domain, --dev in .env"
_assert_rk domain ''                  ''          -       stopped "domain, command empty (--dev default)"
_assert_rk domain ''                  "$_RK_REAL" '--dev' stopped "domain, --dev in the shell wins"
_assert_rk domain ''                  "$_RK_REAL" ''      stopped "domain, empty shell value wins"
_assert_rk proxy  https://p.example   "$_RK_DEV"  -       stopped "proxy with an origin, --dev"
_assert_rk proxy  https://p.example   "$_RK_REAL" -       ok      "proxy with an origin, real config"
_assert_rk proxy  ''                  "$_RK_DEV"  -       ok      "proxy for localhost testing, --dev"
_assert_rk local  ''                  "$_RK_DEV"  -       ok      "local, operator's own --dev"
_rk_out="$( unset LIVEKIT_COMMAND; TOPOLOGY=domain; PROXY_ORIGIN=""; printf '%b' "$_RK_DEV" > "$_rk_env"; require_livekit_real_keys "$_rk_env" 2>&1 )" || true
_assert_var "real keys: says how to fix" "$(_has "$_rk_out" 'LIVEKIT_KEYS')" yes
rm -f "$_rk_env"

# warn_public_livekit_dev: --dev is flagged only when 7880 is published beyond
# loopback (the TLS overlay itself fails closed at Compose level).
_wd_env="$(mktemp)"
# $1 env contents, $2 bindings, $3 live command, $4 running (1/""), $5 want: warn | quiet
_assert_wd() {
    local out got
    printf '%b' "$1" > "$_wd_env"
    out="$(
      unset COMPOSE_FILE LIVEKIT_COMMAND
      _wd_cmd="$3"; _wd_running="$4"
      live_command() { printf '%s' "$_wd_cmd"; }
      service_running() { [[ -n "$_wd_running" ]]; }
      warn_public_livekit_dev "$_wd_env" "$2" 2>&1
    )" || true
    if [[ "$out" == *"--dev credentials"* ]]; then got=warn
    elif [[ -z "$out" ]]; then got=quiet; else got="other: $out"; fi
    _assert_var "--dev warning: $6" "$got" "$5"
}
_assert_wd "$_RK_DEV"            '127.0.0.1:7880' '--dev'                      1  quiet "no overlay, loopback, --dev"
_assert_wd "$_RK_DEV"            '0.0.0.0:7880'   '--dev'                      1  warn  "no overlay, public, --dev (unchanged)"
rm -f "$_wd_env"

# --- install.sh: fresh_install starts LiveKit and seeds matching vault values ---

echo ""
echo "=== install.sh: fresh_install LiveKit seeding ==="

_fi_dir="$(mktemp -d)"
_fi_env="$_fi_dir/.env"
_fi_calls="$_fi_dir/calls"
# $1 topology, $2 stdin answers, $3 extra env contents. Leaves docker calls in
# $_fi_calls and the run's output in $_fi_out; returns the run's status.
_fi_run() {
    printf '%b' "DB_PASSWORD=your-db-password\n$3" > "$_fi_env"
    : > "$_fi_calls"
    local rc=0
    _fi_out="$(
      unset COMPOSE_FILE APP_ORIGIN HTTP_BIND DOMAIN COMPOSE_PROFILES LIVEKIT_KEYS LIVEKIT_COMMAND HTTP_PORT
      [[ -z "${_FI_SHELL_CMD+set}" ]] || export LIVEKIT_COMMAND="$_FI_SHELL_CMD"
      [[ -z "${_FI_SHELL_KEYS_EMPTY:-}" ]] || export LIVEKIT_KEYS=""
      docker() {
        printf '%s\n' "$*" >> "$_fi_calls"
        [[ "$1 $2" != "volume inspect" || -n "${_FI_PGDATA:-}" ]]
      }
      wait_for_postgres() { :; }; wait_for_curia() { return 0; }
      check_postgres_exposure() { :; }; check_http_exposure() { :; }
      check_livekit_exposure() { :; }; note_missing_browser() { :; }
      port_listening() { return 1; }; getent() { return 0; }
      prompt_anthropic_key() { echo sk-ant-test; }
      choose_provider() { echo anthropic; }
      choose_topology() { echo "$_FI_TOPOLOGY"; }
      INSTALL_DIR="$_fi_dir"
      _FI_TOPOLOGY="$1"
      fresh_install "$_fi_env" <<< "$2" 2>&1
    )" || rc=$?
    return $rc
}
_seed_line() { grep 'seed-vault' "$_fi_calls" || true; }

_fi_run domain "c.example.com" '' || true
_fi_keys="$(env_value "$_fi_env" LIVEKIT_KEYS)"
_fi_k="${_fi_keys%%:*}"; _fi_s="${_fi_keys#*: }"
_assert_var "domain: voice profile on"        "$(env_value "$_fi_env" COMPOSE_PROFILES)" "voice"
_assert_var "domain: public LiveKit command"  "$(env_value "$_fi_env" LIVEKIT_COMMAND)" "--config /etc/livekit.yaml"
_assert_var "domain: seeds wss URL"           "$(_has "$(_seed_line)" '-e SEED_LIVEKIT_URL=wss://c.example.com ')" yes
_assert_var "domain: seeds the generated key" "$(_has "$(_seed_line)" "-e SEED_LIVEKIT_API_KEY=$_fi_k ")" yes
_assert_var "domain: seeds the generated secret" "$(_has "$(_seed_line)" "-e SEED_LIVEKIT_API_SECRET=$_fi_s ")" yes
_assert_var "domain: secret never printed"    "$(_has "$_fi_out" "$_fi_s")" no
_assert_var "domain: key never printed"       "$(_has "$_fi_out" "$_fi_k")" no
_assert_var "domain: next steps printed"      "$(_has "$_fi_out" 'https://c.example.com/setup')" yes

_fi_run local "" '' || true
_assert_var "local: placeholder DB password replaced" "$(_has "$(env_value "$_fi_env" DB_PASSWORD)" 'your-db-password')" no
_assert_var "local: loopback LiveKit command" "$(env_value "$_fi_env" LIVEKIT_COMMAND)" "--config /etc/livekit.local.yaml --node-ip 127.0.0.1"
_assert_var "local: seeds ws://localhost:7880" "$(_has "$(_seed_line)" '-e SEED_LIVEKIT_URL=ws://localhost:7880 ')" yes
_assert_var "local: next steps on localhost" "$(_has "$_fi_out" 'http://localhost:3000/setup')" yes

_fi_run proxy "" '' || true
_assert_var "proxy, no origin: loopback LiveKit command" "$(env_value "$_fi_env" LIVEKIT_COMMAND)" "--config /etc/livekit.local.yaml --node-ip 127.0.0.1"
_fi_run proxy "https://p.example.com" '' || true
_assert_var "proxy with origin: public LiveKit command" "$(env_value "$_fi_env" LIVEKIT_COMMAND)" "--config /etc/livekit.yaml"
_assert_var "proxy with origin: seeds wss URL" "$(_has "$(_seed_line)" '-e SEED_LIVEKIT_URL=wss://p.example.com ')" yes
_assert_var "proxy with origin: next steps on the origin" "$(_has "$_fi_out" 'https://p.example.com/setup')" yes
_assert_var "proxy with origin: forwarding rule" "$(_has "$_fi_out" '/rtc* to 127.0.0.1:7880')" yes
_assert_var "proxy with origin: voice on line" "$(_has "$_fi_out" 'Voice (LiveKit): on.')" yes

# Keys LiveKit's command hides (an operator --config without LIVEKIT_KEYS): URL only, with a warning.
_FI_SHELL_CMD="--config /mine.yaml"
_FI_SHELL_KEYS_EMPTY=1
_fi_rc=0; _fi_run local "" '' || _fi_rc=$?
unset _FI_SHELL_CMD _FI_SHELL_KEYS_EMPTY
_assert_var "unknown keys: install continues" "$_fi_rc" "0"
_assert_var "unknown keys: URL still seeded"  "$(_has "$(_seed_line)" 'SEED_LIVEKIT_URL=')" yes
_assert_var "unknown keys: no key seeded"     "$(_has "$(_seed_line)" 'SEED_LIVEKIT_API_KEY')" no
_assert_var "unknown keys: warns where to enter them" "$(_has "$_fi_out" 'Settings → Channels → Voice')" yes

# Fail closed: an HTTPS install with --dev stops before Postgres starts.
_FI_SHELL_CMD="--dev --bind 0.0.0.0"
_fi_rc=0; _fi_run domain "c.example.com" '' || _fi_rc=$?
unset _FI_SHELL_CMD
_assert_var "domain + --dev: stops"                 "$([[ $_fi_rc -ne 0 ]] && echo yes || echo no)" yes
_assert_var "domain + --dev: Postgres never started" "$(grep -c 'up -d postgres' "$_fi_calls" | tr -d ' ')" "0"
# LIVEKIT_KEYS, when set, wins over --dev's devkey (LiveKit reads it too), so
# devkey is seeded only with LIVEKIT_KEYS empty.
_FI_SHELL_CMD="--dev"; _FI_SHELL_KEYS_EMPTY=1
_fi_rc=0; _fi_run local "" '' || _fi_rc=$?
unset _FI_SHELL_CMD _FI_SHELL_KEYS_EMPTY
_assert_var "local + operator --dev: continues"     "$_fi_rc" "0"
_assert_var "local + --dev: seeds devkey"           "$(_has "$(_seed_line)" '-e SEED_LIVEKIT_API_KEY=devkey ')" yes
# The placeholder DB password stays when its Postgres volume already exists.
_FI_PGDATA=1
_fi_run local "" '' || true
unset _FI_PGDATA
_assert_var "pgdata exists: placeholder DB password kept" "$(env_value "$_fi_env" DB_PASSWORD)" "your-db-password"
_assert_var "pgdata exists: warns it is weak" "$(_has "$_fi_out" 'weak default')" yes
rm -rf "$_fi_dir"

# --- Model provider: menus and config/local.yaml (#2749) ---

echo ""
echo "=== provider_for_choice ==="
_assert_var "Enter is anthropic"      "$(provider_for_choice "")"  "anthropic"
_assert_var "1 is anthropic"          "$(provider_for_choice 1)"   "anthropic"
_assert_var "2 is openrouter"         "$(provider_for_choice 2)"   "openrouter"
_assert_var "3 is bedrock"            "$(provider_for_choice 3)"   "bedrock"
_assert_var "unknown is anthropic"    "$(provider_for_choice x)"   "anthropic"

echo ""
echo "=== choose_models ==="
choose_models openrouter <<< "" 2>/dev/null
_assert_var "Enter keeps the recommended fast model"     "$MODEL_FAST"     "$(model_for_choice openrouter fast 1)"
_assert_var "Enter keeps the recommended standard model" "$MODEL_STANDARD" "$(model_for_choice openrouter standard 1)"
# n, then one answer per slot that has more than one model (all four for OpenRouter).
choose_models openrouter <<< $'n\n2\n2\n\n2' 2>/dev/null
_assert_var "n: picks per slot (fast)"     "$MODEL_FAST"     "$(model_for_choice openrouter fast 2)"
_assert_var "n: picks per slot (standard)" "$MODEL_STANDARD" "$(model_for_choice openrouter standard 2)"
_assert_var "n: Enter keeps recommended"   "$MODEL_POWERFUL" "$(model_for_choice openrouter powerful 1)"
_assert_var "n: picks per slot (judge)"    "$MODEL_JUDGE"    "$(model_for_choice openrouter judge 2)"

_assert_var "bedrock, no region: offers all geographies" "$(model_choice_count bedrock fast)" "3"
PROVIDER_AWS_REGION=eu-west-2
_assert_var "bedrock, eu region: global and eu only"     "$(model_choices bedrock fast | cut -d. -f1 | tr '\n' ' ')" "global eu "
PROVIDER_AWS_REGION=ap-southeast-2
_assert_var "bedrock, other region: global only"         "$(model_choices bedrock standard | cut -d. -f1 | tr '\n' ' ')" "global "
PROVIDER_AWS_REGION=""

echo ""
echo "=== write_model_config ==="
_wm_dir="$(mktemp -d)"
_wm="$_wm_dir/config/local.yaml"
write_model_config "$_wm" anthropic "" "" "" "" 2>/dev/null
_assert_var "anthropic: creates the file" "$([[ -f "$_wm" ]] && echo yes || echo no)" yes
_assert_var "anthropic: header only"      "$(local_config_has_settings "$_wm" && echo yes || echo no)" no
write_model_config "$_wm" bedrock "global.anthropic.claude-haiku-4-5-20251001-v1:0" "s" "p" "j" 2>/dev/null
_assert_var "bedrock: quotes the model id" "$(grep -c 'model: "global.anthropic.claude-haiku-4-5-20251001-v1:0"' "$_wm" | tr -d ' ')" "1"
write_model_config "$_wm" openrouter "f2" "s2" "p2" "j2" 2>/dev/null
_assert_var "rerun: replaces the earlier block"  "$(grep -c 'model_routing:' "$_wm" | tr -d ' ')" "1"
_assert_var "rerun: has the new models"          "$(grep -c 'model: "f2"' "$_wm" | tr -d ' ')" "1"
write_model_config "$_wm" anthropic "" "" "" "" 2>/dev/null
_assert_var "back to anthropic: block removed"   "$(local_config_has_settings "$_wm" && echo yes || echo no)" no
printf 'intentDrift:\n  enabled: false\n' >> "$_wm"
_wm_rc=0; _wm_out="$(write_model_config "$_wm" openrouter f s p j 2>&1)" || _wm_rc=$?
_assert_var "operator settings: returns 1"            "$_wm_rc" "1"
_assert_var "operator settings: file left alone"      "$(grep -c 'model_routing' "$_wm" | tr -d ' ')" "0"
_assert_var "operator settings: prints the block"     "$(_has "$_wm_out" 'model: "s"')" yes
# The installer's block plus an operator setting: a rerun that can't write must
# leave the earlier block in place, not strip it (review of #2749).
printf '%s\n' "$LOCAL_CONFIG_HEADER" > "$_wm"
write_model_config "$_wm" openrouter f1 s1 p1 j1 2>/dev/null
printf 'intentDrift:\n  enabled: false\n' >> "$_wm"
_wm_before="$(cat "$_wm")"
_wm_rc=0; write_model_config "$_wm" bedrock f2 s2 p2 j2 2>/dev/null || _wm_rc=$?
_assert_var "block + operator settings: returns 1"     "$_wm_rc" "1"
_assert_var "block + operator settings: file unchanged" "$([[ "$(cat "$_wm")" == "$_wm_before" ]] && echo yes || echo no)" yes
# Reruns don't pile up blank lines.
printf '%s\n' "$LOCAL_CONFIG_HEADER" > "$_wm"
write_model_config "$_wm" openrouter a b c d 2>/dev/null
_wm_once="$(cat "$_wm")"
write_model_config "$_wm" openrouter a b c d 2>/dev/null
write_model_config "$_wm" openrouter a b c d 2>/dev/null
_assert_var "reruns: file stable"                      "$([[ "$(cat "$_wm")" == "$_wm_once" ]] && echo yes || echo no)" yes
# A begin marker with no end: refuse, and keep the rest of the file.
printf '%s\n' "$MODEL_BLOCK_BEGIN" 'x: 1' > "$_wm"
_wm_rc=0; write_model_config "$_wm" openrouter a b c d 2>/dev/null || _wm_rc=$?
_assert_var "unterminated block: returns 1"            "$_wm_rc" "1"
_assert_var "unterminated block: keeps the rest"       "$(grep -c '^x: 1$' "$_wm" | tr -d ' ')" "1"
# Created readable by the container user whatever the umask.
rm -f "$_wm"; ( umask 077; ensure_local_config "$_wm" )
_assert_var "created 0644 under umask 077"             "$(ls -l "$_wm" | cut -c1-10)" "-rw-r--r--"
rm -rf "$_wm_dir"

echo ""
echo "=== install.sh: fresh_install per provider ==="
_fp_dir="$(mktemp -d)"
_fp_env="$_fp_dir/.env"
_fp_calls="$_fp_dir/calls"
_fp_secret="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
# $1 provider. Leaves docker calls in $_fp_calls and output in $_fp_out.
_fp_run() {
    printf 'DB_PASSWORD=your-db-password\n' > "$_fp_env"
    rm -rf "$_fp_dir/config"
    : > "$_fp_calls"
    _fp_out="$(
      unset COMPOSE_FILE APP_ORIGIN HTTP_BIND DOMAIN COMPOSE_PROFILES LIVEKIT_KEYS LIVEKIT_COMMAND HTTP_PORT AWS_REGION
      docker() { printf '%s\n' "$*" >> "$_fp_calls"; [[ "$1 $2" != "volume inspect" ]]; }
      wait_for_postgres() { :; }; wait_for_curia() { return 0; }
      check_postgres_exposure() { :; }; check_http_exposure() { :; }
      check_livekit_exposure() { :; }; note_missing_browser() { :; }
      port_listening() { return 1; }; getent() { return 0; }
      choose_topology() { echo local; }
      choose_provider() { echo "$_FP_PROVIDER"; }
      compose_mounts_local_config() { [[ -z "${_FP_OLD_COMPOSE:-}" ]]; }
      choose_models() { MODEL_FAST="$(model_for_choice "$1" fast 1)"; MODEL_STANDARD="$(model_for_choice "$1" standard 1)"
                        MODEL_POWERFUL="$(model_for_choice "$1" powerful 1)"; MODEL_JUDGE="$(model_for_choice "$1" judge 1)"; }
      prompt_validated() {
        case "$2" in
          (validate_anthropic_key) echo sk-ant-test ;;
          (validate_openrouter_key) echo sk-or-v1-test ;;
          (validate_aws_access_key_id) echo "AK""IA$_fake16" ;;
          (validate_aws_secret_access_key) echo "$_fp_secret" ;;
          (validate_aws_region) echo eu-west-2 ;;
        esac
      }
      INSTALL_DIR="$_fp_dir"
      _FP_PROVIDER="$1"
      fresh_install "$_fp_env" < /dev/null 2>&1
    )" || true
}

_fp_run anthropic
_assert_var "anthropic: seeds the Anthropic key"      "$(_has "$(grep seed-vault "$_fp_calls")" '-e ANTHROPIC_API_KEY=sk-ant-test ')" yes
_assert_var "anthropic: requires it"                  "$(_has "$(grep seed-vault "$_fp_calls")" '-e SEED_VAULT_REQUIRE=anthropic_api_key ')" yes
_assert_var "anthropic: local.yaml created, no models" "$(local_config_has_settings "$_fp_dir/config/local.yaml" && echo yes || echo no)" no
_assert_var "anthropic: voice on"                     "$(env_value "$_fp_env" COMPOSE_PROFILES)" "voice"

_fp_run openrouter
_assert_var "openrouter: seeds the OpenRouter key"    "$(_has "$(grep seed-vault "$_fp_calls")" '-e OPENROUTER_API_KEY=sk-or-v1-test ')" yes
_assert_var "openrouter: no Anthropic key"            "$(_has "$(grep seed-vault "$_fp_calls")" 'ANTHROPIC_API_KEY')" no
_assert_var "openrouter: requires its key"            "$(_has "$(grep seed-vault "$_fp_calls")" '-e SEED_VAULT_REQUIRE=openrouter_api_key ')" yes
_assert_var "openrouter: writes its standard model"   "$(grep -c "model: \"$(model_for_choice openrouter standard 1)\"" "$_fp_dir/config/local.yaml" | tr -d ' ')" "1"
_assert_var "openrouter: voice on"                    "$(env_value "$_fp_env" COMPOSE_PROFILES)" "voice"
_assert_var "openrouter: key never in .env"           "$(grep -c 'sk-or-v1-test' "$_fp_env" | tr -d ' ')" "0"

_fp_run bedrock
_assert_var "bedrock: seeds both AWS keys"            "$(_has "$(grep seed-vault "$_fp_calls")" "-e AWS_ACCESS_KEY_ID=AKIA$_fake16 -e AWS_SECRET_ACCESS_KEY=$_fp_secret ")" yes
_assert_var "bedrock: requires both"                  "$(_has "$(grep seed-vault "$_fp_calls")" '-e SEED_VAULT_REQUIRE=aws_access_key_id,aws_secret_access_key ')" yes
_assert_var "bedrock: region in .env"                 "$(env_value "$_fp_env" AWS_REGION)" "eu-west-2"
_assert_var "bedrock: secret never in .env"           "$(grep -c "$_fp_secret" "$_fp_env" | tr -d ' ')" "0"
_assert_var "bedrock: secret never printed"           "$(_has "$_fp_out" "$_fp_secret")" no
_assert_var "bedrock: writes its fast model"          "$(grep -A1 '^    fast:' "$_fp_dir/config/local.yaml" | grep -c "model: \"$(model_for_choice bedrock fast 1)\"" | tr -d ' ')" "1"
_assert_var "bedrock: voice left off"                 "$(env_value "$_fp_env" COMPOSE_PROFILES)" ""
_assert_var "bedrock: no LiveKit values seeded"       "$(_has "$(grep seed-vault "$_fp_calls")" 'SEED_LIVEKIT')" no
_assert_var "bedrock: says voice is off"              "$(_has "$_fp_out" 'Voice (LiveKit): off.')" yes

# An older docker-compose.yml that doesn't mount local.yaml: stop before Postgres.
_FP_OLD_COMPOSE=1
_fp_run openrouter
_assert_var "old compose + openrouter: Postgres never started" "$(grep -c 'up -d postgres' "$_fp_calls" | tr -d ' ')" "0"
_assert_var "old compose + openrouter: says why"     "$(_has "$_fp_out" "doesn't mount config/local.yaml")" yes
_fp_run anthropic
_assert_var "old compose + anthropic: installs"       "$(_has "$(grep seed-vault "$_fp_calls")" 'ANTHROPIC_API_KEY=')" yes
unset _FP_OLD_COMPOSE
rm -rf "$_fp_dir"

# --- Results ---

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
