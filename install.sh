#!/usr/bin/env bash
# install.sh — interactive, image-based Curia installer for operators.
#
# Usage:
#   # Download first, then review, then run:
#   curl -fsSL https://github.com/josephfung/curia/releases/latest/download/install.sh -o install.sh
#   bash install.sh
#
#   # Pin a specific release (config files AND image both come from it):
#   CURIA_VERSION=v0.41.0 bash install.sh
#   # Track the bleeding edge (main-branch config + :edge image; advanced/testing):
#   CURIA_VERSION=edge bash install.sh
#
# Note: piping curl directly to bash (curl … | bash) does NOT work — this
# script uses interactive `read` prompts that require a real TTY, not piped
# stdin. Always download the script first, then run it.
#
# Requirements: Docker (with the compose plugin) + curl only.
# No Node, pnpm, or openssl is required on the host — everything runs inside
# the published container image.
#
# What this script does:
#   1. Checks for Docker + compose + curl.
#   2. Fetches the matching release's docker-compose.yml, TLS overlay,
#      .env.example, and Caddyfile next to install.sh (if not already present).
#   3. Creates .env from the example, generating secrets for any placeholder values.
#   4. Asks which model provider to use (Anthropic by default, OpenRouter or
#      AWS Bedrock), prompts for its credentials (format-validated, 3 retries)
#      and, for OpenRouter or Bedrock, which models to use. Those models go in
#      config/local.yaml, which docker-compose.yml mounts into the container.
#   5. Asks how people will reach Curia: your domain with HTTPS set up for you
#      (default), your domain behind HTTPS you already run, or just this computer.
#   6. Starts Postgres, runs migrations and vault-seed *inside* the pulled image
#      (tsx direct — no corepack/pnpm on the host), then brings the full stack up.
#   7. Prints a summary box with the bootstrap secret the operator needs to sign in.
#
# Re-running on an existing install:
#   The script detects a completed install (SETUP_COMPLETE marker in .env) and
#   takes a non-rotating upgrade path: no secrets are regenerated, migrations are
#   re-applied idempotently, and seed-vault runs in verify-only mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CURIA_VERSION selects a release. From it we derive BOTH where the config files
# come from AND which app image tag is written to .env — so config and image
# always come from the same release (no per-release edits to this script).
#   latest  (default) -> newest release assets       + image tag "latest"
#   vX.Y.Z / X.Y.Z    -> that release's assets        + image tag "vX.Y.Z"
#   edge              -> config from raw main branch  + image tag "edge"
# Advanced override: CURIA_REF=<git-ref> forces the raw path for the config
# fetch (does NOT set an image tag; .env.example's default applies).
CURIA_VERSION="${CURIA_VERSION:-latest}"

GH_RELEASES="https://github.com/josephfung/curia/releases"
RAW_REPO="https://raw.githubusercontent.com/josephfung/curia"

# Populated by resolve_version. Declared up-front for `set -u` safety.
ASSET_MODE=""               # "release" (flat asset names) | "raw" (repo paths)
ASSET_BASE=""               # release-asset base URL (release mode)
RAW_BASE=""                 # raw repo base URL (raw mode)
CURIA_IMAGE_TAG_RESOLVED="" # image tag to write on fresh install ("" = leave .env.example default)

# Map CURIA_VERSION (and the CURIA_REF override) onto the config source + image
# tag. Pure string logic — runs before setup-common.sh is sourced, so it must
# not use the error/hint helpers; it prints its own errors inline.
resolve_version() {
  # Advanced escape hatch: an explicit CURIA_REF wins and forces raw mode.
  if [[ -n "${CURIA_REF:-}" ]]; then
    ASSET_MODE="raw"
    RAW_BASE="${RAW_REPO}/${CURIA_REF}"
    CURIA_IMAGE_TAG_RESOLVED=""
    return 0
  fi

  local v="$CURIA_VERSION"
  case "$v" in
    latest)
      ASSET_MODE="release"
      ASSET_BASE="${GH_RELEASES}/latest/download"
      CURIA_IMAGE_TAG_RESOLVED="latest"
      ;;
    edge)
      ASSET_MODE="raw"
      RAW_BASE="${RAW_REPO}/main"
      CURIA_IMAGE_TAG_RESOLVED="edge"
      ;;
    v[0-9]*|[0-9]*)
      # Normalize a bare "0.41.0" to "v0.41.0".
      case "$v" in v*) ;; *) v="v$v" ;; esac
      # Validate the tag shape (same regex the release workflow enforces).
      if ! printf '%s' "$v" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$'; then
        printf 'error: invalid CURIA_VERSION: %s\n' "$CURIA_VERSION" >&2
        printf 'hint:  use "latest", "edge", or a release tag like v0.41.0 (see %s)\n' "$GH_RELEASES" >&2
        exit 1
      fi
      ASSET_MODE="release"
      ASSET_BASE="${GH_RELEASES}/download/${v}"
      CURIA_IMAGE_TAG_RESOLVED="$v"
      ;;
    *)
      printf 'error: invalid CURIA_VERSION: %s\n' "$CURIA_VERSION" >&2
      printf 'hint:  use "latest", "edge", or a release tag like v0.41.0\n' >&2
      exit 1
      ;;
  esac
}

resolve_version

# Fetch a bundled file, mapping its local path to the flat release-asset name in
# release mode, or using the repo-relative path in raw mode.
#   $1 = local path (e.g. scripts/setup-common.sh), $2 = flat asset name (e.g. setup-common.sh)
fetch_asset() {
  local local_path="$1" asset="$2"
  download_to "$(bundle_asset_url "$local_path" "$asset")" "$INSTALL_DIR/$local_path"
}

# Download $1 to $2 through a temporary file, moved into place only once complete.
# A transfer that fails part-way would otherwise leave a truncated file that every
# later run treats as present and skips. On failure nothing is left at $2 (a file
# already there stays as it was) and the status is non-zero. The temporary file is
# unique to this transfer (mktemp, beside $2 so the mv is an atomic rename), so two
# runs fetching the same asset at once never write to or remove each other's file.
download_to() {
  local url="$1" dest="$2" tmp
  tmp="$(mktemp "$dest.part.XXXXXX")" || return 1
  # mktemp creates the file 0600; give it the mode curl -o would have (0666 & ~umask).
  chmod "$(printf '%o' $(( 0666 & ~0$(umask) )))" "$tmp"
  if curl -fsSL "$url" -o "$tmp"; then
    mv -f "$tmp" "$dest"
  else
    rm -f "$tmp"
    return 1
  fi
}

# URL of a bundled file for this release/ref (same arguments as fetch_asset).
bundle_asset_url() {
  local local_path="$1" asset="$2"
  if [[ "$ASSET_MODE" == "release" ]]; then
    printf '%s' "${ASSET_BASE}/${asset}"
  else
    printf '%s' "${RAW_BASE}/${local_path}"
  fi
}

# setup-common.sh may not be present when install.sh is fetched standalone.
# Fetch it from the matching release/ref if missing, then source it to get the
# shared output helpers and wait_* functions. NOTE: this runs before INSTALL_DIR
# is set below, so it targets $SCRIPT_DIR directly rather than via fetch_asset.
if [[ ! -f "$SCRIPT_DIR/scripts/setup-common.sh" ]]; then
  mkdir -p "$SCRIPT_DIR/scripts"
  if [[ "$ASSET_MODE" == "release" ]]; then
    download_to "${ASSET_BASE}/setup-common.sh" "$SCRIPT_DIR/scripts/setup-common.sh"
  else
    download_to "${RAW_BASE}/scripts/setup-common.sh" "$SCRIPT_DIR/scripts/setup-common.sh"
  fi
fi
# shellcheck source=/dev/null
source "$SCRIPT_DIR/scripts/setup-common.sh"

# An install made by an older release keeps that release's setup-common.sh,
# which lacks the helpers this installer calls (#2357). Fetch this release's
# copy over it once; if that still lacks them (a CURIA_VERSION older than this
# installer), stop and point at that release's own install.sh.
if ! declare -F ensure_livekit_env >/dev/null; then
  download_to "$(bundle_asset_url scripts/setup-common.sh setup-common.sh)" "$SCRIPT_DIR/scripts/setup-common.sh" || true
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/scripts/setup-common.sh"
  if ! declare -F ensure_livekit_env >/dev/null; then
    printf 'error: scripts/setup-common.sh is older than this installer (CURIA_VERSION=%s).\n' "$CURIA_VERSION" >&2
    printf "hint:  run that release's own installer instead: %s\n" "$(bundle_asset_url install.sh install.sh)" >&2
    exit 1
  fi
fi

# setup-common.sh's wait_for_postgres / wait_for_curia look up the compose
# project via $REPO_ROOT. For the image-based install, the install dir IS the
# project root (docker-compose.yml lives alongside install.sh).
INSTALL_DIR="$SCRIPT_DIR"
REPO_ROOT="$INSTALL_DIR"

# No extra compose file flags for the operator path (the dev overlay is not
# used here). COMPOSE_FLAGS is read by wait_for_postgres/wait_for_curia.
COMPOSE_FLAGS=()

# ---------------------------------------------------------------------------
# Pure helpers (unit-tested via tests/setup/test-setup-functions.sh)
# ---------------------------------------------------------------------------

# Returns 0 if $1 looks like a Curia source checkout:
#   - has a .git directory (it's a git repo)
#   - has a src/ directory (Curia's TypeScript sources live here)
#   - has a package.json whose "name" field is "curia"
# Returns 1 otherwise. Used to warn operators who accidentally ran install.sh
# inside a developer clone and offer them the right path.
detect_source_checkout() {
  local d="$1"
  [[ -d "$d/.git" && -d "$d/src" ]] || return 1
  [[ -f "$d/package.json" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"curia"' "$d/package.json"
}

# Returns 0 (true) only if the install at env file $1 is fully COMPLETE — i.e.
# a prior fresh install ran all the way through migrations, vault seeding, a
# healthy container, and wrote the SETUP_COMPLETE marker as its last step.
#
# A "real DB_PASSWORD but no marker" state is deliberately NOT treated as
# complete: it means a fresh install was interrupted after writing DB creds but
# before the vault was seeded. That state must route back through fresh_install
# (which preserves the existing DB password so the Postgres volume still
# authenticates) so the missing vault secrets still get generated and seeded.
# Routing it to the verify-only upgrade path would leave it stuck with an
# unseeded vault. See fresh_install's DB-password preservation below.
install_is_complete() {
  local env="$1"
  grep -q "^# SETUP_COMPLETE" "$env" 2>/dev/null
}

# Returns 0 when a value ($1) holds a ${...} reference that env_value leaves
# unresolved, so a check keyed on it can't tell what Compose will use.
is_unresolved() {
  # shellcheck disable=SC2016  # a literal ${, not an expansion
  [[ "$1" == *'${'* ]]
}

# Returns 0 when a *_BIND value ($1) names a loopback address. Empty is not
# loopback here; callers decide what an unset value means.
bind_value_is_loopback() {
  case "$1" in
    127.*|::1|"[::1]"|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

# Returns 0 when a COMPOSE_FILE value ($1) includes the Caddy TLS overlay, the
# direct signal that Caddy fronts curia:3000 (DOMAIN alone can be set by hand
# behind an operator's own proxy).
uses_tls_overlay() {
  local entry entries=()
  # Entries are separated by COMPOSE_PATH_SEPARATOR (':' by default). Only an
  # entry whose file name IS the shipped overlay counts, not one that merely
  # contains it (docker-compose.tls.yml.bak, my-docker-compose.tls.yml).
  IFS="${COMPOSE_PATH_SEPARATOR:-:}" read -r -a entries <<< "$1"
  for entry in "${entries[@]+"${entries[@]}"}"; do
    [[ "${entry##*/}" == docker-compose.tls.yml ]] && return 0
  done
  return 1
}

# Returns 0 when every host binding in `docker port` output ($1, one
# "<host>:<port>" per line, e.g. "0.0.0.0:5432" / "[::]:5432" /
# "127.0.0.1:5432") is a loopback address. Empty output (nothing published)
# counts as loopback. Judging Docker's live bindings rather than the compose
# text covers hand-edited files, overrides and COMPOSE_FILE overlays alike.
bindings_are_loopback() {
  local line host
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    host="${line%:*}"
    case "$host" in
      127.*|"[::1]") ;;
      *) return 1 ;;
    esac
  done <<< "$1"
  return 0
}

# Returns 0 when the live bindings ($2, `docker port` format) honour a
# non-loopback *_BIND value ($1). :: asks for every interface, so any binding
# honours it. 0.0.0.0 is every IPv4 interface, so it is honoured by any IPv4
# binding but not by an IPv6 one ([::]). A specific address is honoured only
# when every binding is on that address (or loopback). Empty output (nothing
# published) honours anything. An old compose file that ignores the variable
# publishes 0.0.0.0/[::], which neither 0.0.0.0 nor a specific address honours.
bindings_honour_bind() {
  local want="$1" line host
  case "$want" in ::|"[::]") return 0 ;; esac
  want="${want#[}"; want="${want%]}"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    host="${line%:*}"; host="${host#[}"; host="${host%]}"
    [[ "$host" == "$want" ]] && continue
    bind_value_is_loopback "$host" && continue
    [[ "$want" == 0.0.0.0 && "$host" != *:* ]] && continue
    return 1
  done <<< "$2"
  return 0
}

# Returns 0 when a LiveKit command line ($1) runs the --dev credentials. An
# empty command means the shipped default, which is --dev.
livekit_command_is_dev() {
  [[ -z "$1" || "$1" == *--dev* ]]
}

# ---------------------------------------------------------------------------
# Non-interactive helpers (not unit-tested; rely on Docker or filesystem state)
# ---------------------------------------------------------------------------

# Echo the host bindings of a running compose service's container port, one
# per line (`docker port` format). Echoes nothing when the container is not
# running or the port is not published: `docker port` exits 1 with "no public
# port" for an unpublished port, which is the "nothing exposed" answer. Any
# other failure is unknown, not unpublished: it is warned about and returns 2,
# so a caller that must not guess (check_postgres_exposure) can ask instead.
# Callers capture it with `|| rc=$?`, since `set -e` would abort on a bare
# assignment.
published_bindings() {
  local service="$1" port="$2" cid out
  if ! cid="$(docker compose --project-directory "$INSTALL_DIR" ps -q "$service")"; then
    warn "Could not look up the $service container; skipping its port exposure check."
    return 2
  fi
  [[ -n "$cid" ]] || return 0
  if out="$(docker port "$cid" "${port}/tcp" 2>&1)"; then
    printf '%s\n' "$out"
    return 0
  fi
  case "$out" in
    *"no public port"*|*"No public port"*) return 0 ;;
  esac
  warn "Could not read the $service container's published ports ($out); skipping its port exposure check."
  return 2
}

# Returns 0 when a compose service has a running container. Distinguishes a
# running service that publishes nothing from one that is not running at all,
# which published_bindings alone reports the same way (empty output).
service_running() {
  local cid
  cid="$(docker compose --project-directory "$INSTALL_DIR" ps -q "$1" 2>/dev/null)" || return 1
  [[ -n "$cid" ]]
}

# Echo the command a running compose service's container was created with, or
# nothing when it is not running or cannot be inspected. A container that was
# not recreated keeps its old command whatever .env now says.
live_command() {
  local service="$1" cid
  cid="$(docker compose --project-directory "$INSTALL_DIR" ps -q "$service" 2>/dev/null)" || return 0
  [[ -n "$cid" ]] || return 0
  docker inspect -f '{{join .Config.Cmd " "}}' "$cid" 2>/dev/null || return 0
}

# Run right after Postgres starts, on both the fresh and upgrade paths:
# fetch_bundle never overwrites an existing docker-compose.yml, so an older or
# hand-edited one can still publish Postgres on every interface (#2408). Asks
# before continuing. POSTGRES_BIND (shell first, then .env, as Compose reads
# it) is the intent: unset or loopback must be loopback live; a non-loopback
# value is a deliberate remote opt-in, and the live bindings must still be on
# that address (an old compose file ignores the variable and publishes on
# every interface instead).
check_postgres_exposure() {
  local env="$1" want bindings shown ans rc=0
  want="$(compose_var "$env" POSTGRES_BIND)"
  bindings="$(published_bindings postgres 5432)" || rc=$?
  shown="$(echo "$bindings" | tr '\n' ' ')"
  if [[ $rc -ne 0 ]]; then
    # Unknown is not loopback: ask rather than continue on a guess.
    echo "" >&2
    warn "Could not read which addresses Postgres is published on, so it may be exposed (#2408)."
  elif [[ -n "$want" ]] && ! bind_value_is_loopback "$want"; then
    bindings_honour_bind "$want" "$bindings" && return 0
    echo "" >&2
    warn "POSTGRES_BIND=$want is set, but Postgres is published on: ${shown}(#2408)"
    hint "This docker-compose.yml ignores POSTGRES_BIND, or an override (COMPOSE_FILE) publishes 5432."
  else
    bindings_are_loopback "$bindings" && return 0
    echo "" >&2
    warn "Postgres is published beyond loopback: ${shown}(#2408)"
  fi
  hint "Docker's published ports bypass host firewalls such as ufw."
  hint "Fix: in $INSTALL_DIR/docker-compose.yml (or the override that publishes 5432),"
  hint "change the postgres ports: entry to"
  hint "  - \"\${POSTGRES_BIND:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432\""
  hint "then re-run install.sh, which recreates the container."
  hint "Current file for reference: $(bundle_asset_url docker-compose.yml docker-compose.yml)"
  hint "To keep remote access on purpose, set a non-loopback POSTGRES_BIND in .env instead."
  if [[ $rc -eq 0 ]]; then
    warn "Postgres is running and exposed now. Continuing keeps it exposed after this run."
  else
    hint "Check by hand: docker compose --project-directory \"$INSTALL_DIR\" port postgres 5432"
  fi
  read -rp "Continue anyway? [y/N]: " ans || ans=""
  if [[ ! "$ans" =~ ^[Yy] ]]; then
    info "Stopped. Postgres is still running, with its ports as they were."
    info "To stop it until you have made the change: docker compose --project-directory \"$INSTALL_DIR\" stop postgres"
    info "Then re-run install.sh."
    exit 1
  fi
}

# Run after the full stack starts. Only checks when HTTP_BIND (shell first, then
# .env, as Compose reads it) asks for loopback (local/HTTPS topologies): an
# older compose file without the HTTP_BIND variable ignores it and still
# publishes :3000 everywhere. The stack is already up, so this warns rather
# than asks.
check_http_exposure() {
  local env="$1" want bindings
  want="$(compose_var "$env" HTTP_BIND)"
  if is_unresolved "$want"; then
    echo "" >&2
    warn "HTTP_BIND=$want uses a \${...} reference the installer does not resolve, so port 3000's exposure was not checked."
    hint "Check by hand: docker compose --project-directory \"$INSTALL_DIR\" port curia 3000"
    return 0
  fi
  bind_value_is_loopback "$want" || return 0
  bindings="$(published_bindings curia 3000)" || return 0   # unknown: already warned
  bindings_are_loopback "$bindings" && return 0

  echo "" >&2
  warn "Curia's port 3000 is still published beyond loopback: $(echo "$bindings" | tr '\n' ' ')(#2408)"
  hint "HTTP_BIND=$want is set, but docker-compose.yml ignores it or an override (COMPOSE_FILE) publishes 3000."
  hint "Fix: in $INSTALL_DIR/docker-compose.yml (or that override), change the curia ports: entry to"
  hint "  - \"\${HTTP_BIND:-}:\${HTTP_PORT:-3000}:3000\""
  hint "then run: docker compose --project-directory \"$INSTALL_DIR\" up -d curia"
}

# Warn when LiveKit signaling (7880) is published beyond loopback ($2,
# `docker port` format) while the running container uses the --dev
# credentials. The running container's command is checked, not .env: one that
# was not recreated keeps its old command. Falls back to LIVEKIT_COMMAND
# (shell, then .env) when the container cannot be inspected. Fresh and upgrade
# paths both call this, after check_livekit_bind.
warn_public_livekit_dev() {
  local env="$1" bindings="$2" cmd
  [[ -n "$bindings" ]] || return 0
  bindings_are_loopback "$bindings" && return 0
  cmd="$(live_command livekit)"
  [[ -n "$cmd" ]] || cmd="$(compose_var "$env" LIVEKIT_COMMAND)"
  livekit_command_is_dev "$cmd" || return 0
  echo "" >&2
  warn "LiveKit signaling is public ($(echo "$bindings" | tr '\n' ' ')) and runs --dev credentials (devkey/secret)."
  hint "Anyone who can reach 7880 can mint LiveKit tokens without Curia's auth."
  hint "Set LIVEKIT_COMMAND to a real config with your own keys (docs/dev/voice-setup.md)"
  hint "and recreate it: docker compose --project-directory \"$INSTALL_DIR\" --profile voice up -d livekit"
  hint "or remove LIVEKIT_HTTP_BIND from .env to keep signaling on loopback."
}

# Upgrade path: the installer never turns voice on for an existing install
# (#2357), so say when it is off and where the steps are. Silent when the voice
# profile is enabled (shell first, then .env, as Compose reads it) or livekit
# runs anyway.
note_voice_off() {
  local env="$1" profiles
  profiles="$(compose_var "$env" COMPOSE_PROFILES)"
  [[ ",${profiles}," != *,voice,* ]] || return 0
  service_running livekit && return 0
  echo "" >&2
  warn "Voice (LiveKit) is off on this install."
  hint "New installs turn it on; upgrades leave it as it was. To turn it on here, see"
  hint "the steps for an existing install in docs/dev/voice-setup.md:"
  hint "  https://github.com/josephfung/curia/blob/main/docs/dev/voice-setup.md#turn-voice-on-for-an-existing-install"
}

# Fresh install, before Postgres starts. The HTTPS topology, and a proxy with a
# public address, put LiveKit signaling on the internet (the shipped Caddyfile
# routes /rtc* to it; a proxy is told to). --dev's devkey/secret are public, so
# anyone could then mint LiveKit tokens: stop rather than install that. An
# empty command is the compose default, --dev. Reads TOPOLOGY and PROXY_ORIGIN.
# The command itself is never printed: it may carry --keys.
require_livekit_real_keys() {
  local env="$1"
  case "$TOPOLOGY" in
    domain) ;;
    proxy) [[ -n "$PROXY_ORIGIN" ]] || return 0 ;;
    *) return 0 ;;
  esac
  livekit_command_is_dev "$(compose_var "$env" LIVEKIT_COMMAND)" || return 0
  echo "" >&2
  error "LIVEKIT_COMMAND runs LiveKit with --dev credentials (devkey/secret), which this public install would expose."
  hint "Set real keys: unset LIVEKIT_COMMAND (in your shell and .env) to let the installer generate them,"
  hint "or set LIVEKIT_COMMAND=--config /etc/livekit.yaml with your own LIVEKIT_KEYS=\"<key>: <secret>\"."
  hint "Then re-run install.sh. Postgres was not started."
  exit 1
}

# Since #2408 LiveKit signaling (7880) is published on loopback unless
# LIVEKIT_HTTP_BIND says otherwise. Warn when the live binding ($2) disagrees
# with that intent, as check_postgres_exposure does. Fresh and upgrade paths
# both call this: a resumed install keeps a running livekit, because `up -d`
# leaves a profiled service alone unless the voice profile is active.
#   - Non-loopback LIVEKIT_HTTP_BIND, a deliberate public opt-in: warn while it
#     has not landed (still on loopback, so remote browsers can't connect) or
#     while the live address differs (an old compose file ignores the variable).
#   - Unset or loopback intent, but still beyond loopback: the change has not
#     landed. Say how to apply it before the operator's next restart breaks
#     browsers that use ws://<host>:7880 directly. A loopback
#     LIVEKIT_HTTP_BIND does not silence this.
check_livekit_bind() {
  local env="$1" bindings="$2" want shown
  want="$(compose_var "$env" LIVEKIT_HTTP_BIND)"
  if [[ -z "$bindings" ]]; then
    # Nothing published: voice not running, or (an override) running without
    # 7880. Only the second matters, and only when public access was asked for.
    if [[ -n "$want" ]] && ! bind_value_is_loopback "$want" && service_running livekit; then
      echo "" >&2
      warn "LIVEKIT_HTTP_BIND=$want is set, but the running livekit container publishes no port 7880 (#2408)."
      hint "Remote browsers can't reach signaling. Check the livekit ports: entry in docker-compose.yml"
      hint "and any override (COMPOSE_FILE), then: docker compose --project-directory \"$INSTALL_DIR\" --profile voice up -d livekit"
    fi
    return 0
  fi
  if is_unresolved "$want"; then
    echo "" >&2
    warn "LIVEKIT_HTTP_BIND=$want uses a \${...} reference the installer does not resolve, so signaling's exposure was not checked."
    hint "Check by hand: docker compose --project-directory \"$INSTALL_DIR\" --profile voice port livekit 7880"
    return 0
  fi
  shown="$(echo "$bindings" | tr '\n' ' ')"

  if [[ -n "$want" ]] && ! bind_value_is_loopback "$want"; then
    if bindings_are_loopback "$bindings"; then
      echo "" >&2
      warn "LIVEKIT_HTTP_BIND=$want is set, but LiveKit signaling (7880) is still on loopback: ${shown}(#2408)"
      hint "Remote browsers can't reach it yet. Apply it:"
      hint "  docker compose --project-directory \"$INSTALL_DIR\" --profile voice up -d livekit"
    elif ! bindings_honour_bind "$want" "$bindings"; then
      echo "" >&2
      warn "LIVEKIT_HTTP_BIND=$want is set, but LiveKit signaling (7880) is published on: ${shown}(#2408)"
      hint "docker-compose.yml ignores LIVEKIT_HTTP_BIND, or an override (COMPOSE_FILE) publishes 7880."
      hint "Make the livekit signaling ports: entry read"
      hint "  - \"\${LIVEKIT_HTTP_BIND:-127.0.0.1}:\${LIVEKIT_HTTP_PORT:-7880}:7880\""
      hint "then recreate it: docker compose --project-directory \"$INSTALL_DIR\" --profile voice up -d livekit"
    fi
    return 0
  fi

  bindings_are_loopback "$bindings" && return 0
  echo "" >&2
  warn "LiveKit signaling (7880) is still published beyond loopback: ${shown}(#2408)"
  hint "This release binds it to 127.0.0.1. Check that docker-compose.yml's livekit"
  hint "signaling entry reads - \"\${LIVEKIT_HTTP_BIND:-127.0.0.1}:\${LIVEKIT_HTTP_PORT:-7880}:7880\","
  hint "then recreate it to apply:"
  hint "  docker compose --project-directory \"$INSTALL_DIR\" --profile voice up -d livekit"
  hint "If browsers use ws://<host>:7880 directly, first set LIVEKIT_HTTP_BIND in .env"
  hint "(real keys only, never --dev) or front 127.0.0.1:7880 with a TLS proxy."
  hint "See docs/dev/voice-setup.md."
}

# Run after either path's stack starts: the bind check, then the --dev check.
check_livekit_exposure() {
  local env="$1" bindings
  bindings="$(published_bindings livekit 7880)" || return 0   # unknown: already warned
  check_livekit_bind "$env" "$bindings"
  warn_public_livekit_dev "$env" "$bindings"
}

# Upgrade path only, after check_livekit_exposure. Loopback live with the intent
# unset: browsers that connected to ws://<host>:7880 directly have lost
# signaling; say why, and that LIVEKIT_HTTP_BIND=127.0.0.1 (proxied or local)
# silences it.
note_livekit_signaling() {
  local env="$1" bindings
  bindings="$(published_bindings livekit 7880)" || return 0
  [[ -n "$bindings" ]] || return 0   # voice not running
  bindings_are_loopback "$bindings" || return 0
  [[ -z "$(compose_var "$env" LIVEKIT_HTTP_BIND)" ]] || return 0
  # Installs whose LiveKit the installer set up (#2357) are loopback on purpose:
  # browsers reach signaling through Caddy's /rtc* route or ws://localhost:7880.
  local cmd
  cmd="$(compose_var "$env" LIVEKIT_COMMAND)"
  [[ "$cmd" == "$(livekit_command_for local)" || "$cmd" == "$(livekit_command_for public)" ]] && return 0
  echo "" >&2
  warn "LiveKit signaling (7880) is published on loopback only (#2408)."
  hint "Browsers can no longer reach ws://<host>:7880 directly. If your Voice"
  hint "channel's LiveKit URL points there, front 127.0.0.1:7880 with a TLS proxy"
  hint "on this host, or set LIVEKIT_HTTP_BIND in .env (real keys only, never --dev)."
  hint "Already proxied, or local only? Set LIVEKIT_HTTP_BIND=127.0.0.1 in .env to silence this."
  hint "See docs/dev/voice-setup.md."
}

# Service names under the top-level services: key of the compose file on stdin.
# Indented names elsewhere (a `browser` network, a `browser_profile` volume) are
# not services, so a plain grep for "  browser:" would be fooled.
compose_file_services() {
  awk '/^[^[:space:]#]/ { in_services = ($0 ~ /^services:/) }
       in_services && /^  [A-Za-z0-9._-]+:/ { sub(/^  /, ""); sub(/:.*/, ""); print }'
}

# Service names in the install's effective compose config (COMPOSE_FILE overlays
# included). Non-zero when Compose can't render it.
compose_services() {
  docker compose --project-directory "$INSTALL_DIR" config --services 2>/dev/null
}

# Both paths, after the stack starts. install.sh never replaces an existing
# docker-compose.yml, so an install made before the browser container shipped
# (#2541) keeps a file without the `browser` service, and the web-browser skill
# stays unavailable. Say so, and how to add it, when the release being installed
# has the service. Silent when the install already has it, when BROWSER_CDP_URL
# points at a browser the operator runs some other way, when the release predates
# the service (a pinned older CURIA_VERSION), and when either side can't be read:
# this is advice, never a reason to stop the install.
note_missing_browser() {
  local env="$1" services ref ref_services
  services="$(compose_services)" || return 0
  grep -qx 'browser' <<< "$services" && return 0
  [[ -z "$(compose_var "$env" BROWSER_CDP_URL)" ]] || return 0
  ref="$(mktemp)" || return 0
  if ! download_to "$(bundle_asset_url docker-compose.yml docker-compose.yml)" "$ref"; then
    rm -f "$ref"
    return 0
  fi
  ref_services="$(compose_file_services < "$ref")"
  rm -f "$ref"
  grep -qx 'browser' <<< "$ref_services" || return 0
  echo "" >&2
  warn "This install's docker-compose.yml has no browser service, so the web-browser skill is unavailable."
  hint "install.sh never replaces an existing docker-compose.yml. To add the browser, follow"
  hint "  https://docs.meetcuria.com/integrations/web-browser#upgrading-from-an-older-install"
  hint "copying from this release's file:"
  hint "  $(bundle_asset_url docker-compose.yml docker-compose.yml)"
  hint "Then re-run install.sh: it fetches the seccomp profile the browser service needs."
}

# Upgrade path: HTTPS (Caddy overlay) installs from before #2408 have no
# HTTP_BIND; add it so :3000 leaves the public interface (Caddy uses the
# compose network). Keyed on the overlay in COMPOSE_FILE rather than DOMAIN,
# which an operator may set by hand behind their own proxy. Local and proxy
# installs look alike in .env, so those are left as they are. An explicit
# HTTP_BIND= (even empty, in .env or the shell) is respected and never rewritten.
ensure_https_http_bind() {
  local env="$1"
  # COMPOSE_FILE from the shell first, as Compose reads it. An HTTP_BIND set in
  # the shell (even empty) wins over .env for Compose, so it is respected too.
  [[ -z "${HTTP_BIND+set}" ]] || return 0
  if uses_tls_overlay "$(compose_var "$env" COMPOSE_FILE)" && ! grep -qE '^HTTP_BIND=' "$env" 2>/dev/null; then
    set_env_var "$env" HTTP_BIND 127.0.0.1
    echo "" >&2
    warn "HTTPS install: port 3000 is now published on 127.0.0.1 only (HTTP_BIND, #2408)."
    hint "Curia stays reachable through Caddy on 443. Anything that hit <host>:3000"
    hint "directly (e.g. an uptime probe) stops working; point it at https://$(env_value "$env" DOMAIN)."
    hint "To keep :3000 public, set HTTP_BIND= (empty) in .env and re-run."
  fi
}

# HTTPS (Caddy overlay) installs need APP_ORIGIN=https://<DOMAIN>: without it
# the app builds console links on localhost, sends session cookies without
# Secure and turns CORS off (#2368). The curia container never sees DOMAIN, so
# the installer is the only place the value can come from. Fills a missing or
# empty APP_ORIGIN only; a nonempty value is the operator's and is kept. Needs
# the TLS overlay (as ensure_https_http_bind) and a usable DOMAIN in .env.
# Pass "note" as $2 on the upgrade path to tell the operator what changed.
ensure_https_app_origin() {
  local env="$1" mode="${2:-}" dom
  uses_tls_overlay "$(compose_var "$env" COMPOSE_FILE)" || return 0
  dom="$(env_value "$env" DOMAIN)"
  # A ${...} reference or a value with blanks can't be turned into an origin.
  [[ -n "$dom" ]] && ! is_unresolved "$dom" && [[ "$dom" != *[[:space:]]* ]] || return 0
  [[ -z "$(env_value "$env" APP_ORIGIN)" ]] || return 0
  set_env_var "$env" APP_ORIGIN "https://$dom"
  if [[ "$mode" == note ]]; then
    echo "" >&2
    warn "HTTPS install: APP_ORIGIN is now https://$dom (#2368)."
    hint "Session cookies are now Secure: sign in to the console at https://$dom,"
    hint "not http://<host>:3000. To use another origin, set APP_ORIGIN in .env and re-run."
  fi
}

# Echo this install's Compose project name the way Compose derives it:
# COMPOSE_PROJECT_NAME (shell, then .env), else the install dir's basename;
# lowercased, characters outside [a-z0-9_-] dropped, leading - and _ trimmed.
compose_project_name() {
  local env="$1" name
  name="$(compose_var "$env" COMPOSE_PROJECT_NAME)"
  [[ -n "$name" ]] || name="${INSTALL_DIR%/}"; name="${name##*/}"
  name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -cd 'a-z0-9_-')"
  while [[ "$name" == [-_]* ]]; do name="${name#?}"; done
  printf '%s' "$name"
}

# Returns 0 when this install's Postgres volume (<project>_pgdata) exists, i.e.
# Postgres was already initialised with whatever DB_PASSWORD was then in .env.
pgdata_volume_exists() {
  docker volume inspect "$(compose_project_name "$1")_pgdata" >/dev/null 2>&1
}

# Returns 0 when the install's docker-compose.yml mounts config/local.yaml (on a
# line that isn't a comment).
compose_mounts_local_config() {
  grep -qE '^[^#]*config/local\.yaml' "$INSTALL_DIR/docker-compose.yml" 2>/dev/null
}

# Echo "on" when the voice profile is enabled (shell, then .env), else "off".
voice_state() {
  if [[ ",$(compose_var "$1" COMPOSE_PROFILES)," == *,voice,* ]]; then echo on; else echo off; fi
}

# Validate prereqs: Docker daemon up, compose plugin present, curl available.
# The operator path deliberately does NOT require Node, pnpm, or openssl.
check_prereqs() {
  docker info &>/dev/null || {
    error "Docker not found or not running."
    hint "Install Docker Desktop: https://docs.docker.com/get-docker/"
    exit 1
  }
  docker compose version &>/dev/null || {
    error "docker compose plugin is missing."
    hint "Make sure you have Docker 20.10+ with the Compose plugin."
    exit 1
  }
  command -v curl &>/dev/null || {
    error "curl is required but not found."
    exit 1
  }
}

# Fetch the compose bundle (base compose file, TLS overlay, env template,
# Caddyfile, the browser container's seccomp profile and LiveKit's configs) into the install dir,
# skipping files that are already present.
# This lets an operator re-run install.sh safely without clobbering hand-edits.
fetch_bundle() {
  # local-path : flat-release-asset-name. GitHub release assets cannot contain
  # "/", so deploy/Caddyfile publishes as "Caddyfile", and cannot start with a
  # "." (GitHub mangles a leading-dot asset name), so .env.example publishes as
  # "env.example". docker/seccomp-chrome.json publishes as "seccomp-chrome.json"
  # (docker-compose.yml reads it from docker/). docker-compose.* map 1:1. In raw mode the asset name is
  # ignored and the local path is used verbatim (see fetch_asset).
  local pair local_path asset
  for pair in \
    "docker-compose.yml:docker-compose.yml" \
    "docker-compose.tls.yml:docker-compose.tls.yml" \
    ".env.example:env.example" \
    "deploy/Caddyfile:Caddyfile"; do
    local_path="${pair%%:*}"
    asset="${pair#*:}"
    if [[ ! -f "$INSTALL_DIR/$local_path" ]]; then
      mkdir -p "$INSTALL_DIR/$(dirname "$local_path")"
      info "Fetching $local_path ..."
      fetch_asset "$local_path" "$asset"
    fi
  done
  # The seccomp profile exists only in releases whose compose file mounts it. A pinned
  # older CURIA_VERSION has neither, so fetch it only when the compose file just
  # fetched (or already present) asks for it; for those releases it stays mandatory.
  local seccomp="docker/seccomp-chrome.json"
  if grep -q 'seccomp-chrome\.json' "$INSTALL_DIR/docker-compose.yml" \
    && [[ ! -f "$INSTALL_DIR/$seccomp" ]]; then
    mkdir -p "$INSTALL_DIR/docker"
    info "Fetching $seccomp ..."
    fetch_asset "$seccomp" "seccomp-chrome.json"
  fi
  # LiveKit's configs, the same way: only releases whose compose file mounts
  # them (#2357) ship them. Each is keyed on its own mount, since livekit.yaml
  # and livekit.local.yaml are separate files. Only a non-comment line counts:
  # older compose files name ./docker/livekit.yaml in a comment.
  local lk
  for lk in livekit.yaml livekit.local.yaml; do
    if grep -qE "^[^#]*docker/${lk//./\\.}:" "$INSTALL_DIR/docker-compose.yml" \
      && [[ ! -f "$INSTALL_DIR/docker/$lk" ]]; then
      mkdir -p "$INSTALL_DIR/docker"
      info "Fetching docker/$lk ..."
      fetch_asset "docker/$lk" "$lk"
    fi
  done
}

# Create .env from the template if it does not exist yet, then return its path.
# Never overwrites an existing .env — idempotent.
resolve_env_file() {
  local env="$INSTALL_DIR/.env"
  if [[ ! -f "$env" ]]; then
    cp "$INSTALL_DIR/.env.example" "$env"
  fi
  printf '%s' "$env"
}

# Map a menu answer to a topology name: 1/empty/unknown -> domain, 2 -> proxy,
# 3 -> local. HTTPS is the default, so anything unrecognised lands on domain.
topology_for_choice() {
  case "$1" in
    2) echo "proxy" ;;
    3) echo "local" ;;
    *) echo "domain" ;;
  esac
}

# Prompt for deployment topology. Echoes one of: domain | proxy | local.
# Runs interactively; not unit-tested (requires a TTY and user input).
choose_topology() {
  {
    echo ""
    echo "How will people reach Curia?"
    echo "  1  My domain, with HTTPS set up for me   (recommended)"
    echo "     Curia gets its own certificate. Needs a domain pointing at this"
    echo "     server and ports 80 and 443 open."
    echo "  2  My domain, behind HTTPS I already run"
    echo "     For servers that already have nginx, Traefik, Cloudflare Tunnel or"
    echo "     similar in front. Curia listens on port 3000 behind it."
    echo "  3  Just this computer, to try it out"
    echo "     No phone app; onboarding then needs Signal or SMS."
    echo "Not sure? Choose 1."
  } >&2
  local c
  read -rp "Choice [1]: " c
  topology_for_choice "$c"
}

# Normalize a proxy address to scheme://host[:port]. Lowercases the scheme and
# drops one trailing slash. Returns 1 for anything else: no http(s):// scheme,
# whitespace, a path beyond "/", a query or fragment, or an empty host.
normalize_origin() {
  local v="$1" scheme rest
  case "$v" in
    [Hh][Tt][Tt][Pp][Ss]://*) scheme="https"; rest="${v#????????}" ;;
    [Hh][Tt][Tt][Pp]://*)     scheme="http";  rest="${v#???????}" ;;
    *) return 1 ;;
  esac
  rest="${rest%/}"
  [[ -n "$rest" ]] || return 1
  case "$rest" in
    *[[:space:]]*|*/*|*\?*|*\#*) return 1 ;;
  esac
  printf '%s://%s' "$scheme" "$rest"
}

# Browser-facing LiveKit base URL (never ending in /rtc: livekit-client appends it).
#   livekit_browser_url <topology> <domain_or_origin>
livekit_browser_url() {
  local topology="$1" value="${2:-}"
  case "$topology" in
    domain) printf 'wss://%s' "$value" ;;
    proxy)
      case "$value" in
        https://*) printf 'wss://%s' "${value#https://}" ;;
        http://*)  printf 'ws://%s' "${value#http://}" ;;
        *)         printf 'ws://localhost:7880' ;;
      esac ;;
    *) printf 'ws://localhost:7880' ;;
  esac
}

# Base URL people open Curia on, for the closing message (no trailing slash).
#   setup_base_url <topology> <domain_or_origin>
# domain -> https://<domain>; proxy -> its public origin; otherwise, or when
# the value is empty, http://localhost:$HTTP_PORT (3000 by default).
setup_base_url() {
  local topology="$1" value="${2:-}"
  if [[ -n "$value" ]]; then
    case "$topology" in
      domain) printf 'https://%s' "$value"; return 0 ;;
      proxy)  printf '%s' "${value%/}"; return 0 ;;
    esac
  fi
  printf 'http://localhost:%s' "${HTTP_PORT:-3000}"
}

# 0 when something accepts a TCP connection on 127.0.0.1:<port> (1 s bound).
port_listening() {
  local port="$1"
  ( exec 3<>"/dev/tcp/127.0.0.1/$port" ) 2>/dev/null &
  local pid=$! i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null; return $?; }
    sleep 0.1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  return 1
}

# Ask for the public address a user's own proxy serves Curia on. Echoes the
# normalized origin, or nothing for Enter (localhost testing). Re-asks on invalid.
prompt_proxy_origin() {
  local ans norm
  echo "" >&2
  while true; do
    echo "Public address your proxy serves Curia on (e.g. https://curia.example.com)." >&2
    read -rp "Press Enter to keep localhost for testing: " ans
    if [[ -z "$ans" ]]; then
      hint "Using ws://localhost:7880 for calls; this is for testing only."
      return 0
    fi
    if norm="$(normalize_origin "$ans")"; then
      if [[ "$norm" == http://* ]]; then
        warn "The phone app needs https. $norm will work for the browser only."
      fi
      printf '%s' "$norm"
      return 0
    fi
    warn "Enter the address as https://host or https://host:port, with no path."
  done
}

# ---------------------------------------------------------------------------
# Fresh-install path: generate secrets, prompt for keys, seed vault, mark done.
# ---------------------------------------------------------------------------
fresh_install() {
  local env="$1"

  # Generate all secrets for this install. None of these are written to .env
  # in plaintext (DB creds are the exception — they must be in .env for the
  # postgres container and migration runner to consume them). api_token and
  # boot_secret are passed only as transient env vars to the seed-vault container.
  local db_pass api_token boot_secret
  # Preserve an existing real DB password. This path also handles a partial
  # install (DB creds written on a prior interrupted run but the vault never
  # seeded): the Postgres volume was already initialised with that password, so
  # regenerating it would break authentication. Only generate when the value is
  # absent or a shipped placeholder. .env.example's your-db-password is one too,
  # except when this project's Postgres volume already exists: an older install,
  # interrupted, initialised it with that password.
  db_pass="$(env_value "$env" DB_PASSWORD)"
  case "$db_pass" in
    ""|replace-*) db_pass="$(gen_secret_hex)" ;;
    your-db-password)
      if pgdata_volume_exists "$env"; then
        warn "Keeping DB_PASSWORD=your-db-password, the weak default from .env.example:"
        hint "this install's Postgres volume was already set up with it."
      else
        db_pass="$(gen_secret_hex)"
      fi ;;
  esac
  api_token="$(gen_secret_hex)"
  boot_secret="$(gen_secret_hex)"

  set_env_var "$env" DB_USER curia
  set_env_var "$env" DB_PASSWORD "$db_pass"
  # Note: the compose `curia` service overrides DATABASE_URL in its environment:
  # block (pointing at the internal postgres hostname). This .env value is used
  # by the migration runner (docker compose run --rm curia), not by the app container.
  set_env_var "$env" DATABASE_URL "postgres://curia:${db_pass}@postgres:5432/curia"

  # Pin the app image tag to the resolved CURIA_VERSION (latest / vX.Y.Z / edge),
  # so the config files and the image both come from the same release. This runs
  # only on fresh install, so a re-run never clobbers an operator's hand-pinned
  # tag. CURIA_POSTGRES_TAG is intentionally left at its default (pg16) — the
  # postgres image is versioned by PG major, not app version.
  if [[ -n "$CURIA_IMAGE_TAG_RESOLVED" ]]; then
    set_env_var "$env" CURIA_IMAGE_TAG "$CURIA_IMAGE_TAG_RESOLVED"
  fi

  # Only generate a new encryption key if the current value is the template
  # placeholder or entirely absent/empty. A key that already exists must be
  # preserved — regenerating it makes any existing encrypted vault rows unreadable.
  if grep -qE '^SECRET_ENCRYPTION_KEY=(replace-with|[[:space:]]*$)' "$env" 2>/dev/null \
      || ! grep -qE '^SECRET_ENCRYPTION_KEY=' "$env" 2>/dev/null; then
    local secret_key
    secret_key="$(gen_secret_b64)"
    set_env_var "$env" SECRET_ENCRYPTION_KEY "$secret_key"
  fi

  # Model provider (#2749): its credentials are format-validated (3 retries)
  # and never written to .env — they reach the vault-seed container only, as
  # transient env vars. Only Bedrock's region, not a secret, goes in .env. Models
  # for OpenRouter or Bedrock go in config/local.yaml, which docker-compose.yml
  # mounts and needs to exist before any curia container runs.
  local local_config="$INSTALL_DIR/config/local.yaml"
  choose_provider_setup
  if ! write_model_config "$local_config" "$PROVIDER" "$MODEL_FAST" "$MODEL_STANDARD" "$MODEL_POWERFUL" "$MODEL_JUDGE"; then
    hint "Then re-run install.sh. Postgres was not started."
    exit 1
  fi
  if [[ "$PROVIDER" == bedrock ]]; then
    set_env_var "$env" AWS_REGION "$PROVIDER_AWS_REGION"
  fi

  # TOPOLOGY and PROXY_ORIGIN are read by later steps (LiveKit seeding).
  # A rerun after an interrupted install keeps that run's LiveKit settings in .env.
  if [[ -n "$(env_value "$env" LIVEKIT_COMMAND)" ]]; then
    hint "An earlier run's settings in .env are kept; to reach Curia another way, edit .env or install in a new directory."
  fi
  TOPOLOGY="$(choose_topology)"
  PROXY_ORIGIN=""
  case "$TOPOLOGY" in
    domain)
      # Require a non-empty domain — the TLS overlay and the summary URL are
      # both useless without one, and Caddy cannot request a certificate.
      local dom=""
      while [[ -z "$dom" ]]; do
        read -rp "Domain (e.g. curia.example.com): " dom
        [[ -n "$dom" ]] || error "A domain is required for the HTTPS topology."
      done
      set_env_var "$env" DOMAIN "$dom"
      set_env_var "$env" COMPOSE_FILE "docker-compose.yml:docker-compose.tls.yml"
      # Caddy reaches curia:3000 over the compose network; keep :3000 off the
      # public interface so traffic can't bypass TLS.
      set_env_var "$env" HTTP_BIND 127.0.0.1
      # Public origin for console links, Secure cookies and CORS.
      ensure_https_app_origin "$env"
      # Kept as a shell variable for the LiveKit URL and the closing address below.
      DOMAIN="$dom"
      if port_listening 80 || port_listening 443; then
        warn "Something is already using port 80 or 443 on this machine."
        hint "If nginx, Traefik or similar already serves HTTPS here, re-run and choose option 2."
      fi
      # Best-effort DNS warning; never blocks the install.
      if ! getent hosts "$dom" >/dev/null 2>&1; then
        if command -v host >/dev/null 2>&1; then
          host "$dom" >/dev/null 2>&1 || \
            warn "Could not resolve $dom. Let's Encrypt requires a DNS A record pointing here + ports 80/443 open."
        else
          warn "Could not verify DNS for $dom. Make sure an A record points here and ports 80/443 are open."
        fi
      fi
      ;;
    local)
      # Evaluation on this machine: http://localhost:3000 only.
      set_env_var "$env" HTTP_BIND 127.0.0.1
      ;;
    *)
      # proxy: base compose only, HTTP on :3000 on every interface.
      PROXY_ORIGIN="$(prompt_proxy_origin)"
      if [[ -n "$PROXY_ORIGIN" && -z "$(env_value "$env" APP_ORIGIN)" ]]; then
        set_env_var "$env" APP_ORIGIN "$PROXY_ORIGIN"
      fi
      ;;
  esac

  # Voice (#2357): turn the LiveKit profile on with generated keys. Installs
  # only this machine reaches (local, or a proxy kept on localhost) pin
  # LiveKit's node IP to loopback; the rest advertise their public address.
  local lk_mode=public lk_value=""
  case "$TOPOLOGY" in
    local) lk_mode=local ;;
    proxy) [[ -n "$PROXY_ORIGIN" ]] || lk_mode=local; lk_value="$PROXY_ORIGIN" ;;
    domain) lk_value="$DOMAIN" ;;
  esac
  local -a lk_seed=()
  # Voice turns stream, and Bedrock can't (bedrock.ts), so a Bedrock install
  # leaves voice off rather than run a LiveKit that Curia won't use.
  if [[ "$PROVIDER" != bedrock ]]; then
    ensure_livekit_env "$env" "$lk_mode"
    require_livekit_real_keys "$env"

    # Seed the Voice channel's vault values to match what LiveKit runs on. The
    # keys are passed to the seed container only, like the other secrets, and
    # are never printed. seed-vault never replaces values already in the vault.
    local lk_url lk_pair="" lk_rc=0
    lk_url="$(livekit_browser_url "$TOPOLOGY" "$lk_value")"
    lk_seed=(-e "SEED_LIVEKIT_URL=$lk_url")
    lk_pair="$(livekit_seed_keys "$(compose_var "$env" LIVEKIT_KEYS)" "$(compose_var "$env" LIVEKIT_COMMAND)")" || lk_rc=$?
    if [[ $lk_rc -eq 0 ]]; then
      lk_seed+=(-e "SEED_LIVEKIT_API_KEY=${lk_pair%% *}" -e "SEED_LIVEKIT_API_SECRET=${lk_pair#* }")
    else
      warn "Could not tell which keys LiveKit's LIVEKIT_COMMAND uses, so they were not saved for Curia."
      hint "Enter the LiveKit API key and secret under Settings → Channels → Voice after setup."
    fi
  fi

  # The provider's credentials, as -e pairs for the seed container.
  local -a provider_seed=()
  local pv
  for pv in ${PROVIDER_SEED_VARS[@]+"${PROVIDER_SEED_VARS[@]}"}; do provider_seed+=(-e "$pv"); done

  # Start Postgres and wait for it to be ready before running migrations.
  info "Starting Postgres..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d postgres; then
    error "Failed to start the Postgres container."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs postgres"
    exit 1
  fi
  wait_for_postgres  # from setup-common.sh; uses $REPO_ROOT
  check_postgres_exposure "$env"

  # Run migrations inside the pulled image (tsx direct — no host pnpm needed).
  info "Applying database migrations (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" run --rm curia \
    ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
    --migrations-dir src/db/migrations --migration-file-language sql; then
    error "Database migration failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Seed the encrypted vault with the freshly generated secrets. Secrets are
  # passed as transient env vars so they never land on disk in plaintext.
  # SEED_VAULT_VERIFY=1 makes seed-vault confirm required rows exist and exit
  # non-zero if any are missing — so a partial seed fails loudly here rather
  # than booting a half-configured instance with auth disabled.
  # SEED_VAULT_REQUIRE adds the chosen provider's keys to that check.
  info "Seeding secrets vault (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" run --rm \
    ${provider_seed[@]+"${provider_seed[@]}"} \
    -e "API_TOKEN=$api_token" \
    -e "WEB_APP_BOOTSTRAP_SECRET=$boot_secret" \
    ${lk_seed[@]+"${lk_seed[@]}"} \
    -e SEED_VAULT_VERIFY=1 \
    -e "SEED_VAULT_REQUIRE=$PROVIDER_REQUIRED_SECRETS" \
    curia ./node_modules/.bin/tsx scripts/seed-vault.ts; then
    error "Vault seeding failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Bring the full stack up and wait for the app to become healthy.
  info "Starting Curia..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d; then
    error "Failed to start the Curia stack."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs"
    exit 1
  fi
  if ! wait_for_curia; then
    error "Curia did not become healthy — refusing to print a success banner."
    hint "Check logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi
  check_http_exposure "$env"
  check_livekit_exposure "$env"
  note_missing_browser "$env"

  # Mark setup as complete. On subsequent re-runs, install_is_complete() sees
  # this marker and takes the upgrade path instead of rotating secrets.
  printf '\n# SETUP_COMPLETE\n' >> "$env"

  print_summary "$boot_secret" "$(setup_base_url "$TOPOLOGY" "$lk_value")"
  print_next_steps "$TOPOLOGY" "$(voice_state "$env")"
}

# ---------------------------------------------------------------------------
# Existing-install path: upgrade / restart without rotating any secret.
# ---------------------------------------------------------------------------
existing_install() {
  local env="$1"
  info "Existing install detected — running in upgrade/restart mode."
  info "No secrets will be regenerated."

  ensure_https_http_bind "$env"
  ensure_https_app_origin "$env" note
  # A docker-compose.yml from #2749 on mounts config/local.yaml and refuses to
  # start without it. install.sh never replaces docker-compose.yml, so this
  # matters only to an operator who updated it by hand.
  if compose_mounts_local_config; then
    ensure_local_config "$INSTALL_DIR/config/local.yaml"
  fi

  # Re-apply migrations idempotently. node-pg-migrate skips already-applied
  # migrations, so this is safe on every re-run.
  info "Applying database migrations (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d postgres; then
    error "Failed to start the Postgres container."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs postgres"
    exit 1
  fi
  wait_for_postgres
  check_postgres_exposure "$env"

  if ! docker compose --project-directory "$INSTALL_DIR" run --rm curia \
    ./node_modules/.bin/tsx node_modules/node-pg-migrate/bin/node-pg-migrate.js up \
    --migrations-dir src/db/migrations --migration-file-language sql; then
    error "Database migration failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi

  # Verify-only vault seed: pass NO secret env vars so seed-vault does not
  # rotate any existing row. SEED_VAULT_VERIFY=1 confirms the required rows
  # (api_token, web_app_bootstrap_secret) are present and decryptable. If any
  # are missing the re-run fails loudly — the operator should run a fresh
  # install from a clean install dir in that case. The provider's keys aren't
  # checked here: which provider the tiers use is in config/local.yaml, and
  # boot names a tier whose provider has no key.
  info "Verifying secrets vault (in-container)..."
  if ! docker compose --project-directory "$INSTALL_DIR" run --rm \
    -e SEED_VAULT_VERIFY=1 \
    curia ./node_modules/.bin/tsx scripts/seed-vault.ts; then
    error "Vault verification failed — required secrets may be missing."
    hint "Re-run a fresh install from a clean directory if secrets were lost."
    exit 1
  fi

  info "Starting Curia..."
  if ! docker compose --project-directory "$INSTALL_DIR" up -d; then
    error "Failed to start the Curia stack."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs"
    exit 1
  fi
  if ! wait_for_curia; then
    error "Curia did not become healthy — refusing to print a success banner."
    hint "Check logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi
  check_http_exposure "$env"
  check_livekit_exposure "$env"
  note_livekit_signaling "$env"
  note_missing_browser "$env"
  note_voice_off "$env"

  # A custom HTTP_PORT from .env shapes the localhost address (setup_base_url).
  if grep -qE '^HTTP_PORT=.+' "$env" 2>/dev/null; then
    HTTP_PORT="$(grep -E '^HTTP_PORT=' "$env" | cut -d= -f2-)"
  fi

  # The topology this install looks like: the TLS overlay is the HTTPS
  # topology, an APP_ORIGIN without it is a user's own proxy, and anything
  # else is local. A rerun keeps it; to change it, edit .env or reinstall.
  local topology origin
  if uses_tls_overlay "$(compose_var "$env" COMPOSE_FILE)"; then
    topology=domain; origin="$(env_value "$env" DOMAIN)"
  else
    origin="$(env_value "$env" APP_ORIGIN)"
    if [[ -n "$origin" ]]; then topology=proxy; else topology=local; fi
  fi
  # Empty secret: print_summary then shows the "stored in the vault" branch
  # rather than a fresh secret (which we don't have on the upgrade path).
  print_summary "" "$(setup_base_url "$topology" "$origin")"
  print_next_steps "$topology" "$(voice_state "$env")"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  check_prereqs

  # If we're running from inside the Curia source tree, warn the operator and
  # offer to proceed with the image path or redirect to the developer setup.
  if detect_source_checkout "$INSTALL_DIR"; then
    echo "" >&2
    warn "This looks like the Curia source repository."
    echo "  The image-based installer works here, but most developers prefer" >&2
    echo "  the source build path which hot-reloads changes." >&2
    read -rp "Pull & run the published image (i), or use source build (s)? [i]: " m
    if [[ "${m:-i}" == "s" ]]; then
      info "Use the developer setup instead:"
      hint "  pnpm run setup"
      exit 0
    fi
  fi

  fetch_bundle

  local env
  env="$(resolve_env_file)"

  # Detect whether this is a re-run against an already-completed install.
  # If so, take the non-rotating upgrade path; otherwise run fresh install.
  if install_is_complete "$env"; then
    existing_install "$env"
  else
    fresh_install "$env"
  fi
}

# Guard: when sourced (e.g. by the test harness), only define functions above.
# When executed directly, run main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
