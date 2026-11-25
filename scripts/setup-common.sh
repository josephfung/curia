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

# --- .env helpers (shared by install.sh and scripts/setup.sh) ---

# Set KEY=VALUE in the .env file at path $1.
#   - If the key already exists (commented or uncommented), replace that line.
#   - If the key is absent, append it.
# Uses awk for a portable in-place edit that avoids sed -i portability issues
# between GNU and BSD sed.
set_env_var() {
  local env="$1" key="$2" val="$3"
  if grep -qE "^#?[[:space:]]*${key}=" "$env"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" '
      $0 ~ "^#?[[:space:]]*"k"=" && !done { print k"="v; done=1; next }
      { print }
      END { if (!done) print k"="v }' "$env" > "$tmp"
    mv "$tmp" "$env"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$env"
  fi
}

# Echo the value of KEY from an env file (last assignment wins), or nothing when
# the key is absent or the file is missing. Follows Compose's .env value rules
# for the shapes a *_BIND or COMPOSE_FILE value takes: a "..." or '...' value is
# what the quotes hold, anything after the closing quote (e.g. `# note`) is
# dropped; an unquoted value ends at a ` #` inline comment, blanks around it
# trimmed. So HTTP_BIND="127.0.0.1" # note reads as 127.0.0.1. ${VAR}
# interpolation inside .env is not resolved (is_unresolved flags it). Always returns 0: this script runs
# under `set -euo pipefail`, where grep's no-match status would abort the
# installer from inside `x="$(env_value ...)"`.
env_value() {
  local env="$1" key="$2" v rest q
  v="$({ grep -E "^${key}=" "$env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-)"
  case "$v" in
    \"*|\'*)
      q="${v:0:1}"; rest="${v:1}"
      # Unterminated quote: keep the raw value, as before.
      [[ "$rest" == *"$q"* ]] && v="${rest%%"$q"*}"
      ;;
    *)
      v="${v%%[[:blank:]]#*}"
      v="${v%"${v##*[![:blank:]]}"}"
      v="${v#"${v%%[![:blank:]]*}"}"
      ;;
  esac
  printf '%s' "$v"
}

# Echo VAR as Compose resolves it: the shell's value when the shell sets it
# (even to empty, which Compose also prefers over .env), else the .env value.
compose_var() {
  local env="$1" key="$2"
  if [[ -n "${!key+set}" ]]; then printf '%s' "${!key}"; else env_value "$env" "$key"; fi
}

# 12 alphanumeric characters, no openssl. `cut` drains its input, so no SIGPIPE
# under pipefail. 48 random bytes give ~64 alnum characters after filtering.
gen_livekit_keys() {
  local id
  id="$(head -c 48 /dev/urandom | base64 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-12)"
  printf 'API%s: %s' "$id" "$(gen_secret_hex)"
}

# Echo "<key> <secret>" for the keys LiveKit will run on, or return 1 with no
# output when they cannot be known. $1 = LIVEKIT_KEYS value, $2 = LIVEKIT_COMMAND.
# LiveKit's own precedence: --key-file in the command (unreadable here, so
# unknown), then --keys in the command (LIVEKIT_KEYS is only its environment
# default), then LIVEKIT_KEYS ("k: s", quotes and spaces tolerated), then --dev
# (or an empty command) -> devkey/secret.
livekit_seed_keys() {
  local keys="$1" cmd="$2" flag="" k s
  case "$cmd" in *--key-file*) return 1 ;; esac
  case "$cmd" in
    *--keys=*) flag="${cmd#*--keys=}" ;;
    *--keys\ *) flag="${cmd#*--keys }" ;;
  esac
  if [[ -n "$flag" ]]; then
    case "$flag" in
      \"*) flag="${flag#\"}"; flag="${flag%%\"*}" ;;
      \'*) flag="${flag#\'}"; flag="${flag%%\'*}" ;;
      *) flag="${flag%% *}" ;;
    esac
    keys="$flag"
  fi
  if [[ -n "$keys" ]]; then
    keys="${keys#\"}"; keys="${keys%\"}"; keys="${keys#\'}"; keys="${keys%\'}"
    k="${keys%%:*}"; s="${keys#*:}"
    k="${k#"${k%%[![:space:]]*}"}"; k="${k%"${k##*[![:space:]]}"}"
    s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
    [[ "$keys" == *:* && -n "$k" && -n "$s" ]] || return 1
    printf '%s %s' "$k" "$s"
    return 0
  fi
  if [[ -z "$cmd" || "$cmd" == *--dev* ]]; then
    printf 'devkey secret'
    return 0
  fi
  return 1
}

# LIVEKIT_COMMAND for a local (loopback-only, node-ip pinned) or public install.
livekit_command_for() {
  case "$1" in
    local) printf '%s' '--config /etc/livekit.local.yaml --node-ip 127.0.0.1' ;;
    *) printf '%s' '--config /etc/livekit.yaml' ;;
  esac
}

# Enable the voice profile and give LiveKit generated keys in env file $1.
# $2 = local|public. Existing operator values (shell or .env) are never replaced.
ensure_livekit_env() {
  local env="$1" mode="$2" profiles key
  # A value the shell sets (even empty) wins in Compose, so never write .env then.
  if [[ -n "${COMPOSE_PROFILES+set}" ]]; then
    if [[ ",${COMPOSE_PROFILES}," != *,voice,* ]]; then
      warn "COMPOSE_PROFILES is set in your shell without 'voice'; LiveKit will not start."
      hint "Add voice to COMPOSE_PROFILES (e.g. COMPOSE_PROFILES=${COMPOSE_PROFILES:+${COMPOSE_PROFILES},}voice)."
    fi
  else
    profiles="$(env_value "$env" COMPOSE_PROFILES)"
    if [[ -z "$profiles" ]]; then
      set_env_var "$env" COMPOSE_PROFILES voice
    elif [[ ",$profiles," != *,voice,* ]]; then
      set_env_var "$env" COMPOSE_PROFILES "${profiles},voice"
    fi
  fi
  for key in LIVEKIT_KEYS LIVEKIT_COMMAND; do
    if [[ -n "${!key+set}" ]]; then
      [[ -n "${!key}" ]] || warn "$key is set but empty in your shell; Compose will use the empty value."
    elif [[ -z "$(env_value "$env" "$key")" ]]; then
      if [[ "$key" == LIVEKIT_KEYS ]]; then
        set_env_var "$env" LIVEKIT_KEYS "$(gen_livekit_keys)"
      else
        set_env_var "$env" LIVEKIT_COMMAND "$(livekit_command_for "$mode")"
      fi
    fi
  done
}

# --- Model provider (#2749) ---

# Returns 0 if key matches sk-ant-... format, 1 otherwise.
validate_anthropic_key() {
    local key="$1"
    [[ "$key" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]]
}

# Returns 0 if key matches OpenRouter's sk-or-... format, 1 otherwise.
validate_openrouter_key() {
    local key="$1"
    [[ "$key" =~ ^sk-or-[A-Za-z0-9_-]+$ ]]
}

# Returns 0 for a long-term IAM access key id (AKIA + 16 uppercase letters or
# digits). Temporary ASIA... keys need a session token, which Curia doesn't take.
validate_aws_access_key_id() {
    local key="$1"
    [[ "$key" =~ ^AKIA[A-Z0-9]{16}$ ]]
}

# Returns 0 for an AWS secret access key (40 base64 characters), 1 otherwise.
validate_aws_secret_access_key() {
    local key="$1"
    [[ "$key" =~ ^[A-Za-z0-9/+]{40}$ ]]
}

# Returns 0 for an AWS region name such as us-east-1 or ap-southeast-2.
validate_aws_region() {
    local region="$1"
    [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]
}

# Prompts for a value, validates it, retries up to 3 times. Prints the value to
# stdout on success. Exits 1 after 3 failed attempts.
#   prompt_validated <what> <validator> <format message> <where to get one> [visible]
# Input is hidden unless $5 is "visible" (for non-secret values like a region).
prompt_validated() {
    local what="$1" validator="$2" format_msg="$3" get_hint="$4" visible="${5:-}"
    local value="" attempts=0 max_attempts=3 remaining

    while [[ $attempts -lt $max_attempts ]]; do
        if [[ "$visible" == visible ]]; then
            read -rp "$what: " value || true
        else
            read -rsp "Paste your $what: " value || true
            echo "" >&2
        fi
        if "$validator" "$value"; then
            echo "$value"
            return 0
        fi
        attempts=$((attempts + 1))
        remaining=$((max_attempts - attempts))
        if [[ $remaining -gt 0 ]]; then
            error "$format_msg Try again ($remaining attempt(s) remaining):"
        else
            error "$format_msg"
        fi
    done

    error "Failed to get a valid $what after $max_attempts attempts."
    hint "$get_hint"
    exit 1
}

# Prompts for an Anthropic API key, validates format, retries up to 3 times.
# Prints the key to stdout on success. Exits 1 after 3 failed attempts.
prompt_anthropic_key() {
    echo "" >&2
    echo "Curia needs an Anthropic API key to run its agents." >&2
    hint "Get one at: https://console.anthropic.com"
    echo "" >&2
    prompt_validated "Anthropic API key" validate_anthropic_key \
        "Key must start with 'sk-ant-' followed by letters, numbers, hyphens, or underscores." \
        "Get your key at: https://console.anthropic.com"
}

# Map a menu answer to a provider: 1/empty/unknown -> anthropic, 2 -> openrouter,
# 3 -> bedrock. Anthropic is the default, so Enter keeps the original flow.
provider_for_choice() {
    case "$1" in
        2) echo "openrouter" ;;
        3) echo "bedrock" ;;
        *) echo "anthropic" ;;
    esac
}

# Prompt for the model provider. Echoes anthropic | openrouter | bedrock.
choose_provider() {
    {
        echo ""
        echo "Which model provider should Curia use?"
        echo "  1  Anthropic        (recommended) an Anthropic API key"
        echo "  2  OpenRouter       an OpenRouter API key; Claude, GPT, Gemini and DeepSeek models"
        echo "  3  AWS Bedrock      an IAM access key with Bedrock access, and a region"
        echo "     Voice calls need streaming, which Bedrock doesn't have: voice stays off."
        echo "Not sure? Choose 1."
    } >&2
    local c
    read -rp "Choice [1]: " c || c=""
    provider_for_choice "$c"
}

# Set by prompt_provider_credentials: KEY=VALUE pairs for seed-vault (never
# written to .env), the vault names the install must end up with, and the AWS
# region (Bedrock only; not a secret, so it goes in .env).
PROVIDER_SEED_VARS=()
PROVIDER_REQUIRED_SECRETS=""
PROVIDER_AWS_REGION=""

# Prompt for the chosen provider's credentials. Runs in the caller's shell (not
# in $(...)) so it can set the globals above.
prompt_provider_credentials() {
    local provider="$1" v
    PROVIDER_SEED_VARS=()
    PROVIDER_AWS_REGION=""
    case "$provider" in
        openrouter)
            echo "" >&2
            echo "Curia needs an OpenRouter API key to run its agents." >&2
            hint "Get one at: https://openrouter.ai/settings/keys"
            echo "" >&2
            v="$(prompt_validated "OpenRouter API key" validate_openrouter_key \
                "Key must start with 'sk-or-' followed by letters, numbers, hyphens, or underscores." \
                "Get your key at: https://openrouter.ai/settings/keys")" || exit 1
            PROVIDER_SEED_VARS=("OPENROUTER_API_KEY=$v")
            PROVIDER_REQUIRED_SECRETS="openrouter_api_key"
            ;;
        bedrock)
            echo "" >&2
            echo "Curia needs an AWS IAM access key with access to Bedrock's Claude models." >&2
            hint "Create one in the IAM console: https://console.aws.amazon.com/iam/"
            hint "Turn on model access first: https://console.aws.amazon.com/bedrock/"
            echo "" >&2
            local id secret
            id="$(prompt_validated "AWS access key ID" validate_aws_access_key_id \
                "An access key ID is 'AKIA' followed by 16 capital letters or digits." \
                "Create an access key in the IAM console: https://console.aws.amazon.com/iam/")" || exit 1
            secret="$(prompt_validated "AWS secret access key" validate_aws_secret_access_key \
                "A secret access key is 40 characters: letters, digits, '/' or '+'." \
                "The secret is shown once, when the access key is created in the IAM console.")" || exit 1
            PROVIDER_AWS_REGION="$(prompt_validated "AWS region (e.g. us-east-1)" validate_aws_region \
                "A region looks like us-east-1 or eu-west-2." \
                "Use the region where you turned on Bedrock model access." visible)" || exit 1
            PROVIDER_SEED_VARS=("AWS_ACCESS_KEY_ID=$id" "AWS_SECRET_ACCESS_KEY=$secret")
            PROVIDER_REQUIRED_SECRETS="aws_access_key_id,aws_secret_access_key"
            ;;
        *)
            v="$(prompt_anthropic_key)" || exit 1
            PROVIDER_SEED_VARS=("ANTHROPIC_API_KEY=$v")
            PROVIDER_REQUIRED_SECRETS="anthropic_api_key"
            ;;
    esac
}

# Set by choose_provider_setup: anthropic | openrouter | bedrock.
PROVIDER="anthropic"

# Ask for the model provider, its credentials and, for a provider other than
# Anthropic, its models. Sets PROVIDER, the PROVIDER_* credential globals and
# MODEL_*. Runs in the caller's shell so it can set them.
choose_provider_setup() {
    PROVIDER="$(choose_provider)"
    prompt_provider_credentials "$PROVIDER"
    MODEL_FAST=""; MODEL_STANDARD=""; MODEL_POWERFUL=""; MODEL_JUDGE=""
    [[ "$PROVIDER" == anthropic ]] || choose_models "$PROVIDER"
}

# Models the installer offers for each provider and slot, "provider|slot|model|label".
# The first entry for a provider and slot is the recommended one. Slots are the
# three tiers and "judge" (the outbound filter and escalation judges). Anthropic
# has no entries: its install keeps config/default.yaml's models. Every model must
# be an exact model-registry key with that provider, and fast and judge models must
# be able to turn thinking off (tests/unit/setup/install-model-choices.test.ts).
INSTALL_MODEL_CHOICES=(
    "openrouter|fast|openai/gpt-4o|GPT-4o (\$2.50 / \$10 per 1M tokens in / out)"
    "openrouter|fast|google/gemini-3.1-flash-lite|Gemini 3.1 Flash Lite (\$0.25 / \$1.50); rejects some tool schemas, so contacts jobs can stall"
    "openrouter|standard|anthropic/claude-sonnet-5.5|Claude Sonnet 5.5 (\$2 / \$10); uncached through OpenRouter, so dearer than via Anthropic"
    "openrouter|standard|deepseek/deepseek-v4.1-flash|DeepSeek V4.1 Flash (\$0.15 / \$0.60); latency depends on which OpenRouter endpoint serves it"
    "openrouter|standard|anthropic/claude-opus-5.5|Claude Opus 5.5 (\$4 / \$20); uncached through OpenRouter"
    "openrouter|powerful|anthropic/claude-opus-5.5|Claude Opus 5.5 (\$4 / \$20); uncached through OpenRouter"
    "openrouter|powerful|anthropic/claude-sonnet-5.5|Claude Sonnet 5.5 (\$2 / \$10); uncached through OpenRouter"
    "openrouter|powerful|deepseek/deepseek-v4-pro|DeepSeek V4 Pro (\$1.60 / \$3.20)"
    "openrouter|judge|google/gemini-3.1-flash-lite|Gemini 3.1 Flash Lite (\$0.25 / \$1.50); a different vendor from the agents"
    "openrouter|judge|openai/gpt-4o|GPT-4o (\$2.50 / \$10)"
    "bedrock|fast|global.anthropic.claude-haiku-4-5-20251001-v1:0|Claude Haiku 4.5, global routing"
    "bedrock|fast|us.anthropic.claude-haiku-4-5-20251001-v1:0|Claude Haiku 4.5, US only"
    "bedrock|fast|eu.anthropic.claude-haiku-4-5-20251001-v1:0|Claude Haiku 4.5, EU only"
    "bedrock|standard|global.anthropic.claude-sonnet-4-6|Claude Sonnet 4.6, global routing"
    "bedrock|standard|us.anthropic.claude-sonnet-4-6|Claude Sonnet 4.6, US only"
    "bedrock|standard|eu.anthropic.claude-sonnet-4-6|Claude Sonnet 4.6, EU only"
    "bedrock|powerful|global.anthropic.claude-sonnet-4-6|Claude Sonnet 4.6, global routing"
    "bedrock|powerful|us.anthropic.claude-sonnet-4-6|Claude Sonnet 4.6, US only"
    "bedrock|powerful|eu.anthropic.claude-sonnet-4-6|Claude Sonnet 4.6, EU only"
    "bedrock|judge|global.anthropic.claude-haiku-4-5-20251001-v1:0|Claude Haiku 4.5, global routing"
    "bedrock|judge|us.anthropic.claude-haiku-4-5-20251001-v1:0|Claude Haiku 4.5, US only"
    "bedrock|judge|eu.anthropic.claude-haiku-4-5-20251001-v1:0|Claude Haiku 4.5, EU only"
)

# Echo "model|label" lines offered for provider $1 and slot $2, recommended first.
# Bedrock's us. and eu. profiles serve only regions in that geography, so once a
# region is known (PROVIDER_AWS_REGION) the other geography's are left out.
model_choices() {
    local provider="$1" slot="$2" entry model
    for entry in "${INSTALL_MODEL_CHOICES[@]}"; do
        [[ "$entry" == "$provider|$slot|"* ]] || continue
        entry="${entry#"$provider|$slot|"}"
        model="${entry%%|*}"
        if [[ "$provider" == bedrock && -n "$PROVIDER_AWS_REGION" ]]; then
            case "$model" in
                us.*) [[ "$PROVIDER_AWS_REGION" == us-* ]] || continue ;;
                eu.*) [[ "$PROVIDER_AWS_REGION" == eu-* ]] || continue ;;
            esac
        fi
        printf '%s\n' "$entry"
    done
    return 0
}

# Echo the model for menu answer $3 among provider $1's slot $2 choices: empty or
# out of range is the recommended (first) one. Echoes nothing when the provider
# has no choices for the slot.
model_for_choice() {
    local provider="$1" slot="$2" answer="$3" line first="" i=0
    [[ "$answer" =~ ^[0-9]+$ ]] || answer=1
    while IFS= read -r line; do
        i=$((i + 1))
        [[ -n "$first" ]] || first="${line%%|*}"
        if [[ $i -eq $answer ]]; then printf '%s' "${line%%|*}"; return 0; fi
    done < <(model_choices "$provider" "$slot")
    printf '%s' "$first"
}

# Echo how many models provider $1 offers for slot $2.
model_choice_count() {
    local line n=0
    while IFS= read -r line; do n=$((n + 1)); done < <(model_choices "$1" "$2")
    echo "$n"
}

# What each slot is for, shown in the model menus.
slot_description() {
    case "$1" in
        fast)     echo "fast tier: short tasks, classifiers, fact extraction and voice" ;;
        standard) echo "standard tier: most conversations and specialist work" ;;
        powerful) echo "powerful tier: the hardest tasks" ;;
        judge)    echo "judges: review outbound messages before they are sent" ;;
    esac
}

# Set by choose_models: the model for each slot.
MODEL_FAST=""
MODEL_STANDARD=""
MODEL_POWERFUL=""
MODEL_JUDGE=""

# Show the recommended models for provider $1 and let the operator keep them
# (Enter) or pick per slot. Runs in the caller's shell so it can set MODEL_*.
choose_models() {
    local provider="$1" slot ans line i model
    {
        echo ""
        echo "Recommended models for $provider:"
        for slot in fast standard powerful judge; do
            printf '  %-9s %s\n' "$slot" "$(model_for_choice "$provider" "$slot" 1)"
        done
        echo "You can change these later in config/local.yaml."
    } >&2
    read -rp "Use these? [Y/n]: " ans || ans=""
    for slot in fast standard powerful judge; do
        model="$(model_for_choice "$provider" "$slot" 1)"
        if [[ "$ans" =~ ^[Nn] && "$(model_choice_count "$provider" "$slot")" -gt 1 ]]; then
            {
                echo ""
                echo "Model for the $(slot_description "$slot"):"
                i=0
                while IFS= read -r line; do
                    i=$((i + 1))
                    printf '  %d  %s\n' "$i" "${line%%|*}"
                    printf '     %s\n' "${line#*|}"
                done < <(model_choices "$provider" "$slot")
            } >&2
            local c
            read -rp "Choice [1]: " c || c=""
            model="$(model_for_choice "$provider" "$slot" "$c")"
        fi
        case "$slot" in
            fast) MODEL_FAST="$model" ;;
            standard) MODEL_STANDARD="$model" ;;
            powerful) MODEL_POWERFUL="$model" ;;
            judge) MODEL_JUDGE="$model" ;;
        esac
    done
}

# Header of an installer-created config/local.yaml.
LOCAL_CONFIG_HEADER="# Curia deployment overrides, deep-merged over config/default.yaml at startup.
# Restart Curia after editing: docker compose restart curia
# Reference: https://docs.meetcuria.com/references/configuration"

# docker-compose.yml mounts config/local.yaml into the curia container and refuses
# to start when the file is missing. Create it (header only) when absent.
ensure_local_config() {
    local file="$1"
    [[ -f "$file" ]] && return 0
    mkdir -p "$(dirname "$file")"
    printf '%s\n' "$LOCAL_CONFIG_HEADER" > "$file"
    # The container runs as uid 1001, not the host user: under a 077 umask it
    # couldn't read the file. It holds no secrets.
    chmod 644 "$file"
}

# The installer's models block in local.yaml sits between these lines, so a
# rerun can replace it without touching anything the operator added.
MODEL_BLOCK_BEGIN="# >>> models chosen at install"
MODEL_BLOCK_END="# <<< models chosen at install"

# Returns 0 when local.yaml $1 has anything besides comments and blank lines.
local_config_has_settings() {
    grep -qvE '^[[:space:]]*(#|$)' "$1" 2>/dev/null
}

# Echo the local.yaml block for provider $1 and the four models $2..$5
# (fast, standard, powerful, judge). Model ids are quoted: Bedrock ids hold a ':'.
model_config_block() {
    local provider="$1" fast="$2" standard="$3" powerful="$4" judge="$5"
    cat <<EOF
$MODEL_BLOCK_BEGIN
# Models for $provider. Each must be in Curia's model registry; startup names
# the setting when one isn't.
model_routing:
  tiers:
    fast:
      model: "$fast"
    standard:
      model: "$standard"
    powerful:
      model: "$powerful"
filter:
  llmJudge:
    model: "$judge"
escalation:
  judge:
    model: "$judge"
$MODEL_BLOCK_END
EOF
}

# Echo local.yaml $1 without the installer's models block (between the markers)
# and the blank line written before it.
without_model_block() {
    awk -v b="$MODEL_BLOCK_BEGIN" -v e="$MODEL_BLOCK_END" '
      $0 == b { skip = 1; held = 0; next }
      skip { if ($0 == e) skip = 0; next }
      held { print ""; held = 0 }
      $0 == "" { held = 1; next }
      { print }
      END { if (held) print "" }' "$1"
}

# Make local.yaml $1 match provider $2 with models $3..$6 (fast, standard,
# powerful, judge). The block an earlier run wrote is replaced. For anthropic it
# is only removed: config/default.yaml's models are Anthropic's. Settings the
# operator added are left alone; if any remain and a block is needed, appending
# could repeat one of their keys, so the block is printed for them to merge by
# hand and this returns 1.
write_model_config() {
    local file="$1" provider="$2" tmp
    ensure_local_config "$file"
    # A begin marker with no end would drop the rest of the file: leave it to the operator.
    if grep -qxF "$MODEL_BLOCK_BEGIN" "$file" && ! grep -qxF "$MODEL_BLOCK_END" "$file"; then
        warn "$file has a '$MODEL_BLOCK_BEGIN' line but no '$MODEL_BLOCK_END' line."
        hint "Fix or remove that block by hand, then run the installer again."
        return 1
    fi
    tmp="$(mktemp)" || return 1
    without_model_block "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
    # Decide before touching the file: returning 1 leaves it exactly as it was.
    if [[ "$provider" != anthropic ]] && local_config_has_settings "$tmp"; then
        rm -f "$tmp"
        warn "$file already has settings, so the installer did not add the models to it."
        hint "Merge this into it, replacing any block between the '# >>>' and '# <<<' lines."
        hint "Without it Curia won't start: its default models are Anthropic's."
        model_config_block "${@:2}" | sed 's/^/     /' >&2
        return 1
    fi
    if [[ "$provider" != anthropic ]]; then
        { printf '\n'; model_config_block "${@:2}"; } >> "$tmp"
    fi
    # cat, not mv: keeps the file's mode, which the container user must be able to read.
    cat "$tmp" > "$file"
    rm -f "$tmp"
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
    # Every expansion of _flags is guarded too: under `set -u`, bash 3.2 (macOS) treats
    # "${empty[@]}" as unbound, which install.sh (no COMPOSE_FLAGS) hit on every run.
    local -a _flags=("${COMPOSE_FLAGS[@]+"${COMPOSE_FLAGS[@]}"}")

    info "Waiting for Postgres to be ready..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id ps_err
        # Distinguish "container not started yet" (empty output, exit 0) from docker failures.
        if ! ps_err=$(docker compose --project-directory "$REPO_ROOT" ${_flags[@]+"${_flags[@]}"} ps -q postgres 2>&1); then
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
    # Every expansion of _flags is guarded too: under `set -u`, bash 3.2 (macOS) treats
    # "${empty[@]}" as unbound, which install.sh (no COMPOSE_FLAGS) hit on every run.
    local -a _flags=("${COMPOSE_FLAGS[@]+"${COMPOSE_FLAGS[@]}"}")

    info "Waiting for Curia to become healthy (up to ${max_wait}s)..."
    while [[ $elapsed -lt $max_wait ]]; do
        local container_id ps_err
        if ! ps_err=$(docker compose --project-directory "$REPO_ROOT" ${_flags[@]+"${_flags[@]}"} ps -q curia 2>&1); then
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

# Prints the final summary box with the Setup page address and bootstrap secret.
#   $1 = WEB_APP_BOOTSTRAP_SECRET (plain hex, no formatting; empty on resume)
#   $2 = base URL people open Curia on. Empty: http://localhost:$HTTP_PORT (3000).
print_summary() {
    local secret="$1" base="${2:-}"
    local W=70  # inner box width; wide enough for a 64-char hex secret + padding
    local border url
    border=$(printf '═%.0s' $(seq 1 $W))

    [[ -n "$base" ]] || base="http://localhost:${HTTP_PORT:-3000}"
    url="${base%/}/setup"

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

# Prints what to do after the installer finishes: finish on the Setup page (at
# the address print_summary showed), the docs guide, whether voice is on and,
# for installs reached from other machines with voice on, the call ports (and a
# proxy's forwarding rules).
#   print_next_steps <topology: domain | proxy | local> <voice: on | off>
print_next_steps() {
    local topology="$1" voice="${2:-on}"
    echo "Finish setting up Curia in your browser at the address above."
    echo "Guide: https://docs.meetcuria.com/get-started/check-your-setup"
    echo "When every step is done, choose Start onboarding."
    echo ""
    if [[ "$voice" != on ]]; then
        echo "Voice (LiveKit): off. See docs/dev/voice-setup.md to turn it on."
        echo ""
        return 0
    fi
    echo "Voice (LiveKit): on."
    case "$topology" in
        domain|proxy) echo "Open these ports for calls: 7881/tcp, 7882/udp" ;;
    esac
    if [[ "$topology" == proxy ]]; then
        echo "Your proxy must forward / to port 3000 and /rtc* to 127.0.0.1:7880 on this host."
    fi
    echo ""
}
