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
#   - If the key has uncommented assignments, the first becomes KEY=VALUE and the
#     others are dropped: Compose reads the last one, so a later duplicate would
#     otherwise win over the value written here. Commented lines are left alone.
#   - Else, if a commented placeholder (# KEY=...) exists, the first one becomes KEY=VALUE.
#   - If the key is absent, append it.
# Uses awk for a portable in-place edit that avoids sed -i portability issues
# between GNU and BSD sed. The value reaches awk through ENVIRON, not -v, which
# would turn backslashes in it into escapes.
set_env_var() {
  local env="$1" key="$2" val="$3"
  if grep -qE "^#?[[:space:]]*${key}=" "$env"; then
    local tmp
    tmp="$(mktemp)"
    _SET_ENV_VAL="$val" awk -v k="$key" '
      BEGIN { v = ENVIRON["_SET_ENV_VAL"]; live = "^[[:space:]]*" k "="; any = "^#?[[:space:]]*" k "=" }
      { line[NR] = $0 }
      $0 ~ live && !first_live { first_live = NR }
      $0 ~ any && !first_any { first_any = NR }
      END {
        target = first_live ? first_live : first_any
        for (i = 1; i <= NR; i++) {
          if (i == target) print k "=" v
          else if (!(first_live && line[i] ~ live)) print line[i]
        }
      }' "$env" > "$tmp"
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
  local env="$1" key="$2"
  env_decode_value "$({ grep -E "^${key}=" "$env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-)"
}

# Echo a raw .env value (the text after KEY=) decoded by env_value's rules above:
# quotes removed, an inline comment dropped. scripts/setup.sh exports .env with
# it, so the shell holds what Compose would read from the file.
env_decode_value() {
  local v="$1" rest q
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
# LiveKit's own precedence (v1.13 config.ValidateKeys and the keys flag):
#   - --key-file in the command: the file's keys replace every other source, and
#     the installer can't read it -> unknown;
#   - --keys "k: s" in the command: wins over LIVEKIT_KEYS, which is only that
#     flag's environment default;
#   - LIVEKIT_KEYS ("k: s", quotes and spaces tolerated);
#   - --dev (or an empty command, the compose default) -> devkey/secret.
# A --config file that names a key_file is invisible here too; the Setup Voice
# check reports keys LiveKit rejects. A pair containing $ is unknown (see below).
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
    # A $ in the pair is unknown, not guessed: Compose interpolates it (or keeps
    # it, single-quoted), and `docker compose config` may print it doubled ($$),
    # depending on the version, so the installer can't be sure what LiveKit gets.
    # Generated and usual keys are alphanumeric; the operator enters such a pair
    # under Settings → Channels → Voice.
    [[ "$k$s" != *'$'* ]] || return 1
    printf '%s %s' "$k" "$s"
    return 0
  fi
  if [[ -z "$cmd" || "$cmd" == *--dev* ]]; then
    printf 'devkey secret'
    return 0
  fi
  return 1
}

# Ask Compose what it will run for livekit, with the current .env, shell and
# profiles (run in $REPO_ROOT with COMPOSE_FLAGS, as the wait_* helpers do).
# Returns 1, with everything empty, when Compose can't render the config. Sets:
#   RENDERED_LIVEKIT_ACTIVE   1 when `config --services` lists livekit (`up -d`
#                             starts it, profiled or not), else 0;
#   RENDERED_LIVEKIT_DEFINED  1 when the livekit service renders (`config
#                             livekit` names it even while its profile is off),
#                             so the values below are what it runs once enabled;
#   RENDERED_LIVEKIT_COMMAND  the rendered command: list joined with spaces
#                             (empty when the service has none);
#   RENDERED_LIVEKIT_KEYS_FLAG  the argument after --keys (or of --keys=), kept
#                             whole, as LiveKit receives it;
#   RENDERED_LIVEKIT_KEY_FILE 1 when the command names --key-file;
#   RENDERED_LIVEKIT_ENV_KEYS the rendered environment's LIVEKIT_KEYS.
# Never prints any of them: they may carry the secret.
rendered_livekit() {
  local services out tag val
  local -a _flags=("${COMPOSE_FLAGS[@]+"${COMPOSE_FLAGS[@]}"}")
  RENDERED_LIVEKIT_ACTIVE=""; RENDERED_LIVEKIT_DEFINED=""; RENDERED_LIVEKIT_COMMAND=""
  RENDERED_LIVEKIT_KEYS_FLAG=""; RENDERED_LIVEKIT_KEY_FILE=""; RENDERED_LIVEKIT_ENV_KEYS=""
  services="$(docker compose --project-directory "$REPO_ROOT" ${_flags[@]+"${_flags[@]}"} config --services 2>/dev/null)" || return 1
  RENDERED_LIVEKIT_ACTIVE=0
  grep -qx livekit <<< "$services" && RENDERED_LIVEKIT_ACTIVE=1
  # Rendered even while the voice profile is off, so the keys an override gives
  # it are known before the operator turns voice on.
  if ! out="$(docker compose --project-directory "$REPO_ROOT" ${_flags[@]+"${_flags[@]}"} config livekit 2>/dev/null)"; then
    # Active but not renderable is a failure; inactive and absent is no service.
    [[ "$RENDERED_LIVEKIT_ACTIVE" == 0 ]] || return 1
    RENDERED_LIVEKIT_DEFINED=0
    return 0
  fi
  RENDERED_LIVEKIT_DEFINED=1
  # One "tag<TAB>value" line per finding; command items keep their boundaries.
  while IFS=$'\t' read -r tag val; do
    case "$tag" in
      cmd) RENDERED_LIVEKIT_COMMAND="${RENDERED_LIVEKIT_COMMAND:+$RENDERED_LIVEKIT_COMMAND }$val" ;;
      keys) RENDERED_LIVEKIT_KEYS_FLAG="$val" ;;
      keyfile) RENDERED_LIVEKIT_KEY_FILE=1 ;;
      env) RENDERED_LIVEKIT_ENV_KEYS="$val" ;;
    esac
  done < <(awk '
    function unq(v) {
      if (v ~ /^".*"$/) return substr(v, 2, length(v) - 2)
      if (v ~ /^\047.*\047$/) { v = substr(v, 2, length(v) - 2); gsub(/\047\047/, "\047", v); return v }
      return v
    }
    /^[^ ]/ { in_lk = 0; sect = ""; next }
    /^  [^ ]/ { in_lk = ($0 ~ /^  livekit:/); sect = ""; next }
    in_lk && /^    [^ ]/ { sect = $0; sub(/^    /, "", sect); sub(/:.*/, "", sect); next }
    in_lk && sect == "command" && /^      - / {
      v = unq(substr($0, 9)); print "cmd\t" v
      if (want_keys) { print "keys\t" v; want_keys = 0 }
      if (v == "--keys") want_keys = 1
      else if (v ~ /^--keys=/) print "keys\t" unq(substr(v, 8))
      if (v ~ /^--key-file/) print "keyfile\t1"
      next
    }
    in_lk && sect == "environment" && /^      LIVEKIT_KEYS:/ {
      v = $0; sub(/^      LIVEKIT_KEYS:[[:space:]]*/, "", v); print "env\t" unq(v); next
    }' <<< "$out")
  return 0
}

# Echo "<key> <secret>" for the keys the rendered livekit service runs on
# (rendered_livekit must have succeeded with RENDERED_LIVEKIT_DEFINED=1), or
# return 1 when they can't be known. Same precedence as livekit_seed_keys:
# --key-file, then --keys (read whole from its own argument), then LIVEKIT_KEYS
# in the rendered environment, then --dev. A service with no command is unknown.
rendered_livekit_seed_keys() {
  [[ -z "$RENDERED_LIVEKIT_KEY_FILE" ]] || return 1
  if [[ -n "$RENDERED_LIVEKIT_KEYS_FLAG" ]]; then livekit_seed_keys "$RENDERED_LIVEKIT_KEYS_FLAG" ""; return; fi
  [[ -n "$RENDERED_LIVEKIT_COMMAND" ]] || return 1
  livekit_seed_keys "$RENDERED_LIVEKIT_ENV_KEYS" "$RENDERED_LIVEKIT_COMMAND"
}

# Echo the host port Compose publishes container port $2 of service $1 on,
# read from the rendered service (`docker compose config $1`, run in
# $REPO_ROOT with COMPOSE_FLAGS, as the wait_* helpers do), so a value such as
# LIVEKIT_HTTP_PORT=${VOICE_PORT:-17880} or a hand-edited ports: entry is
# resolved by Compose itself. Handles the long form (target: $2 with its
# published: value) and the short "host:published:$2" form. Returns 1, with no
# output, when Compose can't render the service, and 2 when it renders it with
# no host port for $2 (e.g. ports: !reset []): known unpublished, not unknown.
rendered_published_port() {
  local svc="$1" target="$2" out port
  local -a _flags=("${COMPOSE_FLAGS[@]+"${COMPOSE_FLAGS[@]}"}")
  out="$(docker compose --project-directory "$REPO_ROOT" ${_flags[@]+"${_flags[@]}"} config "$svc" 2>/dev/null)" || return 1
  port="$(awk -v svc="$svc" -v target="$target" '
    function kv(s,  k, v) {
      k = s; sub(/:.*/, "", k); v = s; sub(/^[^:]*:[[:space:]]*/, "", v); gsub(/["\047]/, "", v)
      if (k == "target") tgt = v
      if (k == "published") pub = v
    }
    function flush_item() { if (tgt == target && pub != "" && !found) { print pub; found = 1 } tgt = ""; pub = "" }
    /^[^ ]/ { flush_item(); lk = 0; inp = 0; next }
    /^  [^ ]/ { flush_item(); lk = ($0 == "  " svc ":"); inp = 0; next }
    lk && /^    [^ ]/ { flush_item(); inp = ($0 ~ /^    ports:/); next }
    inp && /^      - / {
      flush_item(); rest = substr($0, 9)
      if (rest ~ /^[a-z_]+:( |$)/) { kv(rest); next }
      gsub(/["\047]/, "", rest); n = split(rest, a, ":"); t = a[n]; sub(/\/tcp$/, "", t)
      if (t == target && n >= 2) { tgt = target; pub = a[n - 1] }
      next
    }
    inp && /^        [a-z_]+:/ { kv(substr($0, 9)); next }
    END { flush_item() }' <<< "$out")"
  [[ "$port" =~ ^[0-9]+$ ]] || return 2
  printf '%s' "$port"
}

# LiveKit signaling: container port 7880 (see rendered_published_port).
rendered_livekit_http_port() { rendered_published_port livekit 7880; }

# Curia's host port for container port 3000, for operator instructions: what
# Compose renders, else HTTP_PORT (shell, then .env $1) as docker-compose.yml
# reads it ("${HTTP_PORT:-3000}:3000"): a literal number, or 3000 when empty.
# Returns 1 (unknown: an unresolved ${...} and no render) or 2 (Compose
# publishes none), with no output: callers must not print a guessed number.
curia_host_port() {
  local p rc=0
  p="$(rendered_published_port curia 3000)" || rc=$?
  if [[ $rc -eq 0 ]]; then printf '%s' "$p"; return 0; fi
  [[ $rc -ne 2 ]] || return 2
  p="$(compose_var "$1" HTTP_PORT)"
  [[ -n "$p" ]] || p=3000
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$p"
}

# Set CURIA_PORT_DISPLAY, which every message naming Curia's host port reads
# (the summary address, a proxy's forwarding rule, hints), to curia_host_port's
# answer for env file $1. When that is unknown, it is the placeholder <port>
# and one note says what it stands for, rather than a guess. A display-only
# variable: HTTP_PORT is left alone, since Compose reads it from the shell
# first and a later docker compose call must not see a placeholder.
resolve_curia_port_for_messages() {
  local rc=0 p
  p="$(curia_host_port "$1")" || rc=$?
  if [[ $rc -eq 0 ]]; then CURIA_PORT_DISPLAY="$p"; return 0; fi
  CURIA_PORT_DISPLAY="<port>"
  echo "" >&2
  if [[ $rc -eq 2 ]]; then
    warn "Compose publishes no host port for Curia's 3000; below, <port> stands for the one you publish."
  else
    warn "HTTP_PORT=$(compose_var "$1" HTTP_PORT) can't be resolved here; below, <port> is the port Compose publishes for Curia's 3000."
  fi
  hint "Check it: docker compose --project-directory \"$REPO_ROOT\" port curia 3000"
}

# Host port LiveKit signaling is published on: what Compose renders
# (rendered_livekit_http_port), else LIVEKIT_HTTP_PORT (shell, then .env $1) as
# docker-compose.yml reads it ("${LIVEKIT_HTTP_PORT:-7880}:7880"): a literal
# number, or 7880 when empty. Returns 1, with no output, when Compose can't
# render and LIVEKIT_HTTP_PORT is something else (a ${...} reference): the port
# is unknown, and callers must not guess. Returns 2 when Compose renders livekit
# with no host port for signaling: nothing on this host listens for a browser.
# A browser on this machine reaches ws://localhost:<port>.
livekit_host_port() {
  local p rc=0
  p="$(rendered_livekit_http_port)" || rc=$?
  if [[ $rc -eq 0 ]]; then printf '%s' "$p"; return 0; fi
  [[ $rc -ne 2 ]] || return 2
  p="$(compose_var "$1" LIVEKIT_HTTP_PORT)"
  [[ -n "$p" ]] || p=7880
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$p"
}

# Set LIVEKIT_HOST_PORT to livekit_host_port's answer for env file $1 (empty
# when Compose publishes no host port: callers then save no localhost URL), or
# stop when the port can't be known: saving a guessed LiveKit URL would leave
# calls unable to connect, and seeding never replaces a saved value. Run before
# anything starts or is seeded. Never prints keys.
require_livekit_host_port() {
  local rc=0
  LIVEKIT_HOST_PORT="$(livekit_host_port "$1")" || rc=$?
  [[ $rc -ne 0 ]] || return 0
  if [[ $rc -eq 2 ]]; then LIVEKIT_HOST_PORT=""; return 0; fi
  echo "" >&2
  error "LIVEKIT_HTTP_PORT=$(compose_var "$1" LIVEKIT_HTTP_PORT) can't be resolved here (Compose could not render the config), so the installer can't tell which port LiveKit is published on."
  hint "Set a literal port in .env (e.g. LIVEKIT_HTTP_PORT=17880), then re-run. Nothing was saved for LiveKit."
  exit 1
}

# Compose publishes no host port for LiveKit signaling (7880), so a browser
# can't reach it on this host. $1: local (no LiveKit URL is saved) or proxy (the
# proxy has nothing on this host to forward /rtc* to).
note_livekit_signaling_unpublished() {
  echo "" >&2
  warn "Compose publishes no host port for LiveKit signaling (7880), so a browser can't reach it on this host."
  if [[ "$1" == local ]]; then
    hint "Voice needs signaling published (the livekit ports: entry for 7880) or proxied. No LiveKit URL"
    hint "was saved for Curia: once signaling is reachable, enter it under Settings → Channels → Voice."
  else
    hint "Your proxy can't forward /rtc* to LiveKit until 7880 is published on this host (the livekit"
    hint "ports: entry); see docs/dev/voice-setup.md."
  fi
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
        set_env_var "$env" LIVEKIT_KEYS "\"$(gen_livekit_keys)\""
      else
        set_env_var "$env" LIVEKIT_COMMAND "$(livekit_command_for "$mode")"
      fi
    fi
  done
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
# This is the one address the installers print at the end; print_next_steps
# refers back to it.
#   $1 = WEB_APP_BOOTSTRAP_SECRET (plain hex, no formatting; empty on resume)
#   $2 = base URL people open Curia on (install.sh: setup_base_url), no trailing
#        slash needed. Empty: http://localhost:$HTTP_PORT (3000 by default).
print_summary() {
    local secret="$1" base="${2:-}"
    local W=70  # inner box width; wide enough for a 64-char hex secret + padding
    local border url
    border=$(printf '═%.0s' $(seq 1 $W))

    [[ -n "$base" ]] || base="http://localhost:${CURIA_PORT_DISPLAY:-${HTTP_PORT:-3000}}"
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
# the address print_summary showed), the docs guide and, for installs reached
# from other machines with voice on, the call ports (and a proxy's forwarding
# rules).
#   print_next_steps <topology: domain | proxy | local> <voice: on | dev | off> [origin]
# voice: on = LiveKit runs real keys; dev = it runs --dev's public devkey/secret,
# so a proxy must not publish /rtc* yet; off = voice is not running. origin is a
# proxy's public address: empty means a proxy kept on localhost for testing.
# A 4th argument is the host port LiveKit signaling is published on
# (livekit_host_port), 7880 when omitted; empty means Compose publishes none.
# Curia's own host port is CURIA_PORT_DISPLAY (resolve_curia_port_for_messages),
# else HTTP_PORT, else 3000, as print_summary reads it.
print_next_steps() {
    local topology="$1" voice="${2:-off}" origin="${3-}" lk_port="${4-7880}" reached=0
    local curia_port="${CURIA_PORT_DISPLAY:-${HTTP_PORT:-3000}}"
    echo "Finish setting up Curia in your browser at the address above."
    echo "Guide: https://docs.meetcuria.com/get-started/check-your-setup"
    echo "When every step is done, choose Start onboarding."
    case "$topology" in
        domain) reached=1 ;;
        proxy) [[ -z "$origin" ]] || reached=1 ;;
    esac
    if [[ $reached -eq 1 && "$voice" != off ]]; then
        echo ""
        echo "Open these ports for calls: 7881/tcp, 7882/udp"
    fi
    if [[ "$topology" == proxy && -n "$origin" ]]; then
        if [[ "$voice" == on ]]; then
            if [[ -n "$lk_port" ]]; then
                echo "Your proxy must forward / to port ${curia_port} and /rtc* to 127.0.0.1:${lk_port} on this host."
            else
                echo "Your proxy must forward / to port ${curia_port} on this host, and /rtc* to LiveKit once"
                echo "its signaling port (7880) is published here (see docs/dev/voice-setup.md)."
            fi
            echo "A proxy on another machine also needs LIVEKIT_HTTP_BIND set (see docs/dev/voice-setup.md)."
        else
            echo "Your proxy must forward / to port ${curia_port} on this host."
        fi
        if [[ "$voice" == dev ]]; then
            echo "LiveKit runs --dev credentials (devkey/secret): Don't forward /rtc* to it, or set"
            echo "LIVEKIT_HTTP_BIND, until it runs real keys (see docs/dev/voice-setup.md)."
        fi
    fi
    echo ""
}

# Rerun of an interrupted install: seed-vault keeps any LiveKit value an earlier
# run saved, even when this run offered another (e.g. a corrected domain).
note_livekit_values_kept() {
    echo "" >&2
    warn "An earlier run may have saved LiveKit settings for Curia; those are kept, not replaced."
    hint "If the address or keys changed since, check them under Settings → Channels → Voice."
}
