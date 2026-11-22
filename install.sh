#!/usr/bin/env bash
# install.sh — interactive, image-based Curia installer for operators.
#
# Usage:
#   # Download first, then review, then run:
#   curl -fsSL https://github.com/josephfung/curia/releases/latest/download/install.sh -o install.sh
#   bash install.sh
#
#   A release's install.sh installs that release by default (its own tag is
#   stamped into CURIA_INSTALLER_VERSION below when the release is built).
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
#   2. Fetches the matching release's setup-common.sh on every run, checked
#      against that release's SHA256SUMS before it replaces the copy on disk,
#      and its docker-compose.yml, TLS overlay, .env.example, and Caddyfile next
#      to install.sh (if not already present).
#   3. Creates .env from the example, generating secrets for any placeholder values.
#   4. Prompts for an Anthropic API key (format-validated, 3 retries).
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
#
# CURIA_INSTALLER_VERSION is the release this install.sh came from. The repo copy
# leaves it empty; the release workflow stamps the tag into the published copy, so
# a downloaded install.sh installs its own release unless CURIA_VERSION (or
# CURIA_REF) says otherwise. Keep the line exactly as it is: release.yml matches it.
CURIA_INSTALLER_VERSION=""
CURIA_VERSION="${CURIA_VERSION:-${CURIA_INSTALLER_VERSION:-latest}}"

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

# Returns 0 if $1 looks like a Curia source checkout:
#   - has a .git entry (a directory in a clone, a file in a git worktree)
#   - has a src/ directory (Curia's TypeScript sources live here)
#   - has a package.json whose "name" field is "curia"
# Returns 1 otherwise. Used to warn operators who accidentally ran install.sh
# inside a developer clone and offer them the right path, and to leave a clone's
# own scripts/setup-common.sh alone (unit-tested via tests/setup/test-setup-functions.sh).
detect_source_checkout() {
  local d="$1"
  [[ -e "$d/.git" && -d "$d/src" ]] || return 1
  [[ -f "$d/package.json" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"curia"' "$d/package.json"
}

# Echo the SHA-256 of file $1, or return 1 when the host has no tool for it.
sha256_of() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then out="$(sha256sum "$1")" || return 1
  elif command -v shasum >/dev/null 2>&1; then out="$(shasum -a 256 "$1")" || return 1
  else return 1; fi
  printf '%s' "${out%% *}"
}

# Why the setup-common.sh on disk was kept instead of refreshed ("" = refreshed or
# a source checkout). Read by the helper check below, so a stale kept copy is not
# blamed on CURIA_VERSION.
SETUP_COMMON_KEPT_REASON=""

# Keep the setup-common.sh already in $1 after a refresh failed for reason $2,
# with a warning, or stop when there is none. $3 = what to say about the cause.
keep_setup_common_or_stop() {
  local dest="$1" reason="$2" detail="$3"
  if [[ -f "$dest" ]]; then
    printf 'warning: %s; using the copy already in %s.\n' "$detail" "${dest%/*}" >&2
    SETUP_COMMON_KEPT_REASON="$reason"
    return 0
  fi
  printf 'error: %s, and install.sh needs it.\n' "$detail" >&2
  printf 'hint:  check the network and CURIA_VERSION, then re-run install.sh.\n' >&2
  exit 1
}

# Refresh scripts/setup-common.sh from the resolved release/ref. In release mode
# the download goes to a temporary file and is checked against that release's
# SHA256SUMS before it replaces the copy on disk: a mismatch stops the install
# with the old copy untouched. When SHA256SUMS can't be fetched or there is no
# sha256 tool, the existing copy is kept (with a warning), or with none the
# install stops. Raw modes (edge, CURIA_REF) publish no SHA256SUMS: downloaded
# as before, unchecked.
refresh_setup_common() {
  local dest="$SCRIPT_DIR/scripts/setup-common.sh" url tmp sums want got
  url="$(bundle_asset_url scripts/setup-common.sh setup-common.sh)"
  mkdir -p "$SCRIPT_DIR/scripts"
  if [[ "$ASSET_MODE" != release ]]; then
    download_to "$url" "$dest" && return 0
    keep_setup_common_or_stop "$dest" "download failed" "could not download setup-common.sh from $url"
    return 0
  fi
  tmp="$(mktemp "$dest.new.XXXXXX")" || { keep_setup_common_or_stop "$dest" "download failed" "could not create a temporary file in ${dest%/*}"; return 0; }
  sums="$(mktemp "$dest.sums.XXXXXX")" || { rm -f "$tmp"; keep_setup_common_or_stop "$dest" "download failed" "could not create a temporary file in ${dest%/*}"; return 0; }
  if ! download_to "$url" "$tmp"; then
    rm -f "$tmp" "$sums"
    keep_setup_common_or_stop "$dest" "download failed" "could not download setup-common.sh from $url"
    return 0
  fi
  if ! download_to "${ASSET_BASE}/SHA256SUMS" "$sums"; then
    rm -f "$tmp" "$sums"
    keep_setup_common_or_stop "$dest" "could not be verified" \
      "could not download ${ASSET_BASE}/SHA256SUMS to check setup-common.sh against"
    return 0
  fi
  want="$(awk '$2 == "setup-common.sh" || $2 == "*setup-common.sh" { print $1; exit }' "$sums")"
  rm -f "$sums"
  if [[ -z "$want" ]]; then
    rm -f "$tmp"
    keep_setup_common_or_stop "$dest" "could not be verified" \
      "${ASSET_BASE}/SHA256SUMS lists no setup-common.sh to check the download against"
    return 0
  fi
  if ! got="$(sha256_of "$tmp")"; then
    rm -f "$tmp"
    keep_setup_common_or_stop "$dest" "could not be verified" \
      "no sha256sum or shasum on this host to check setup-common.sh with"
    return 0
  fi
  if [[ "$got" != "$want" ]]; then
    rm -f "$tmp"
    printf 'error: the downloaded setup-common.sh does not match %s/SHA256SUMS.\n' "$ASSET_BASE" >&2
    printf 'hint:  nothing was replaced. Re-run install.sh; if this persists, report it:\n' >&2
    printf 'hint:  https://github.com/josephfung/curia/issues\n' >&2
    exit 1
  fi
  mv -f "$tmp" "$dest"
}

# install.sh needs the shared helpers in scripts/setup-common.sh, and the two
# must come from the same release: an install made by an older release keeps an
# older setup-common.sh that lacks helpers this script calls. So outside a source
# checkout, refresh it from the resolved release/ref on every run.
# NOTE: this runs before setup-common.sh is sourced (no error/hint helpers yet)
# and before INSTALL_DIR is set below, so it prints inline and uses $SCRIPT_DIR.
if ! detect_source_checkout "$SCRIPT_DIR"; then
  refresh_setup_common
fi
# shellcheck source=/dev/null
source "$SCRIPT_DIR/scripts/setup-common.sh"

# An older release's setup-common.sh (a pinned CURIA_VERSION from before these
# helpers existed) cannot run this installer. Plain printf: the error/hint
# helpers just sourced may be that release's.
for _helper in compose_var env_value env_decode_value set_env_var ensure_livekit_env livekit_seed_keys \
    livekit_command_for livekit_host_port rendered_livekit rendered_livekit_seed_keys rendered_livekit_http_port \
    require_livekit_host_port note_livekit_signaling_unpublished rendered_published_port curia_host_port \
    resolve_curia_port_for_messages print_next_steps \
    note_livekit_values_kept; do
  if [[ "$(type -t "$_helper")" != function ]]; then
    if [[ -n "$SETUP_COMMON_KEPT_REASON" ]]; then
      # The refresh failed and the copy kept from an earlier run is too old.
      printf 'error: setup-common.sh was not refreshed (%s), and the copy kept in %s/scripts is stale (it has no %s).\n' \
        "$SETUP_COMMON_KEPT_REASON" "$SCRIPT_DIR" "$_helper" >&2
      printf 'hint:  re-run install.sh when the network is back.\n' >&2
      exit 1
    fi
    printf 'error: CURIA_VERSION=%s predates this installer (its setup-common.sh has no %s).\n' \
      "$CURIA_VERSION" "$_helper" >&2
    printf "hint:  download that release's own installer and run it instead: %s\n" \
      "$(bundle_asset_url install.sh install.sh)" >&2
    exit 1
  fi
done
unset _helper

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

# Echo the command Compose starts livekit with when LIVEKIT_COMMAND (shell, then
# .env $1) is empty: the TLS overlay's fail-closed fallback, the keyless shipped
# config (owner decision on #2705), or else empty, which is the base file's --dev.
effective_livekit_command() {
  local cmd
  cmd="$(compose_var "$1" LIVEKIT_COMMAND)"
  if [[ -z "$cmd" ]] && uses_tls_overlay "$(compose_var "$1" COMPOSE_FILE)"; then
    cmd="$(livekit_command_for public)"
  fi
  printf '%s' "$cmd"
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

# Warn when LiveKit signaling is public while the running container uses the
# --dev credentials. Public means 7880 published beyond loopback ($2,
# `docker port` format), or the TLS overlay is active with livekit running:
# the shipped Caddyfile routes /rtc* to livekit:7880 over the compose network,
# whatever 7880's host binding. The running container's command is checked,
# not .env: one that was not recreated keeps its old command. Falls back to
# LIVEKIT_COMMAND (shell, then .env; effective_livekit_command) when the
# container cannot be inspected.
# Fresh and upgrade paths both call this, after check_livekit_bind.
warn_public_livekit_dev() {
  local env="$1" bindings="$2" cmd via=""
  if [[ -n "$bindings" ]] && ! bindings_are_loopback "$bindings"; then
    via="port"
  elif uses_tls_overlay "$(compose_var "$env" COMPOSE_FILE)" \
    && { [[ -n "$bindings" ]] || service_running livekit; }; then
    via="caddy"
  fi
  [[ -n "$via" ]] || return 0
  cmd="$(live_command livekit)"
  [[ -n "$cmd" ]] || cmd="$(effective_livekit_command "$env")"
  livekit_command_is_dev "$cmd" || return 0
  echo "" >&2
  if [[ "$via" == port ]]; then
    warn "LiveKit signaling is public ($(echo "$bindings" | tr '\n' ' ')) and runs --dev credentials (devkey/secret)."
    hint "Anyone who can reach 7880 can mint LiveKit tokens without Curia's auth."
  else
    warn "HTTPS install: LiveKit runs --dev credentials (devkey/secret), and the shipped Caddyfile routes /rtc* to it."
    hint "Anyone who can reach this domain can then mint LiveKit tokens without Curia's auth."
  fi
  hint "Set LIVEKIT_COMMAND to a real config with your own keys (docs/dev/voice-setup.md)"
  hint "and recreate it: docker compose --project-directory \"$INSTALL_DIR\" --profile voice up -d livekit"
  if [[ "$via" == port ]]; then
    hint "or remove LIVEKIT_HTTP_BIND from .env to keep signaling on loopback."
  fi
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

# Echo the voice state the closing steps describe: off (the voice profile is not
# enabled and livekit is not running), dev (LiveKit runs --dev's public
# devkey/secret), or on (real keys). The running container's command is checked
# first, as warn_public_livekit_dev does: one that was not recreated keeps its old
# command. Falls back to effective_livekit_command (empty = the base file's --dev;
# the TLS overlay's fallback is the keyless shipped config).
livekit_next_steps_state() {
  local env="$1" profiles cmd
  profiles="$(compose_var "$env" COMPOSE_PROFILES)"
  if [[ ",${profiles}," != *,voice,* ]] && ! service_running livekit; then
    printf off; return 0
  fi
  cmd="$(live_command livekit)"
  [[ -n "$cmd" ]] || cmd="$(effective_livekit_command "$env")"
  if livekit_command_is_dev "$cmd"; then printf dev; else printf on; fi
}

# Returns 0 when `docker compose up -d` will start livekit (rendered_livekit).
# When Compose can't render the config, falls back to the voice profile (shell,
# then .env); require_livekit_real_keys then says the check read .env.
livekit_will_start() {
  if rendered_livekit; then
    [[ "$RENDERED_LIVEKIT_ACTIVE" == 1 ]] && return 0
    return 1
  fi
  [[ ",$(compose_var "$1" COMPOSE_PROFILES)," == *,voice,* ]]
}

# Fresh install, before Postgres starts. The HTTPS topology, and a proxy with a
# public address, put LiveKit signaling on the internet (the shipped Caddyfile
# routes /rtc* to it; a proxy is told to). --dev's devkey/secret are public, so
# anyone could then mint LiveKit tokens: stop rather than install that. An
# empty command is the compose default: --dev, or the keyless shipped config
# under the TLS overlay (effective_livekit_command). Reads TOPOLOGY and PROXY_ORIGIN.
# On any topology, the installer's own --config commands (livekit_command_for,
# the shipped keyless configs) need LIVEKIT_KEYS: empty, e.g. set empty in the
# shell, LiveKit would crash-loop. An operator's own --config may keep its keys
# in that file, which the installer can't read: fresh_install then seeds the
# URL only and says where to enter the keys.
# The command itself is never printed: it may carry --keys.
require_livekit_real_keys() {
  local env="$1" cmd rendered=1
  if rendered_livekit; then
    # Compose will not start livekit at all: nothing is exposed or crash-loops.
    [[ "$RENDERED_LIVEKIT_ACTIVE" == 1 ]] || return 0
    cmd="$RENDERED_LIVEKIT_COMMAND"
  else
    rendered=0
    echo "" >&2
    warn "Could not render this install's compose config, so the LiveKit check read .env and the shell instead."
    cmd="$(effective_livekit_command "$env")"
  fi
  if [[ "$cmd" == "$(livekit_command_for local)" || "$cmd" == "$(livekit_command_for public)" ]] \
    && [[ -z "$(compose_var "$env" LIVEKIT_KEYS)" ]]; then
    echo "" >&2
    error "LiveKit runs from the shipped config, which has no keys, but LIVEKIT_KEYS is empty."
    hint "Set LIVEKIT_KEYS=\"<key>: <secret>\", or unset it in your shell to let the installer generate one."
    hint "Then re-run install.sh. Postgres was not started."
    exit 1
  fi
  case "$TOPOLOGY" in
    domain) ;;
    proxy) [[ -n "$PROXY_ORIGIN" ]] || return 0 ;;
    *) return 0 ;;
  esac
  if [[ $rendered -eq 1 && -z "$cmd" ]]; then
    # A rendered service with no command: the installer can't tell what it runs.
    echo "" >&2
    error "Compose starts a livekit service with no command, so this public install can't rule out --dev credentials."
    hint_livekit_real_keys
    exit 1
  fi
  livekit_command_is_dev "$cmd" || return 0
  echo "" >&2
  error "LiveKit would run with --dev credentials (devkey/secret), which this public install would expose."
  hint_livekit_real_keys
  exit 1
}

# How to give LiveKit real keys, after require_livekit_real_keys stops.
hint_livekit_real_keys() {
  hint "Set real keys: unset LIVEKIT_COMMAND (in your shell and .env) to let the installer generate them,"
  hint "or set LIVEKIT_COMMAND=--config /etc/livekit.yaml with your own LIVEKIT_KEYS=\"<key>: <secret>\"."
  hint "A command written into docker-compose.yml itself has to be changed there."
  hint "Then re-run install.sh. Postgres was not started."
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
  cmd="$(effective_livekit_command "$env")"
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
    warn "HTTPS install: Curia's port ${HTTP_PORT:-3000} is now published on 127.0.0.1 only (HTTP_BIND, #2408)."
    hint "Curia stays reachable through Caddy on 443. Anything that hit <host>:${HTTP_PORT:-3000}"
    hint "directly (e.g. an uptime probe) stops working; point it at https://$(env_value "$env" DOMAIN)."
    hint "To keep port ${HTTP_PORT:-3000} public, set HTTP_BIND= (empty) in .env and re-run."
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
    hint "not http://<host>:${HTTP_PORT:-3000}. To use another origin, set APP_ORIGIN in .env and re-run."
  fi
}

# Returns 0 when the install's docker-compose.yml bind-mounts docker/$1 (e.g.
# livekit.yaml) on a line that is not a comment. Compose files from v0.42 to
# v0.45 name ./docker/livekit.yaml:/etc/livekit.yaml in a comment only, and
# those releases ship no such file.
compose_mounts_config() {
  local re="docker/${1//./\\.}:"
  grep -qE "^[^#]*${re}" "$INSTALL_DIR/docker-compose.yml" 2>/dev/null
}

# Fresh install, after the topology is chosen. If LIVEKIT_COMMAND in .env is
# exactly what an earlier, interrupted run wrote for the other topology
# (livekit_command_for local|public), switch it to $2's. A shell value, or any
# other value (the operator's), is left alone. The vault's LiveKit URL is only
# written when absent, so one an earlier run seeded is kept: say where to fix it.
retarget_livekit_command() {
  local env="$1" mode="$2" cur want other
  [[ -z "${LIVEKIT_COMMAND+set}" ]] || return 0
  cur="$(env_value "$env" LIVEKIT_COMMAND)"
  want="$(livekit_command_for "$mode")"
  if [[ "$mode" == local ]]; then other="$(livekit_command_for public)"; else other="$(livekit_command_for local)"; fi
  [[ "$cur" == "$other" ]] || return 0
  set_env_var "$env" LIVEKIT_COMMAND "$want"
  echo "" >&2
  warn "LIVEKIT_COMMAND now matches the reach you chose this time (an earlier run used the other one)."
  hint "If that earlier run already saved LiveKit's URL for Curia, it is kept: check it"
  hint "under Settings → Channels → Voice after setup."
}

# Remove every uncommented KEY= assignment from env file $1 (commented
# placeholders stay).
unset_env_var() {
  local env="$1" key="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^[[:space:]]*${key}=" "$env" > "$tmp" || true
  mv "$tmp" "$env"
}

# fresh_install records each reach (topology) value it writes to .env on a
# "# installer-topology: KEY=VALUE" line, plus the topology itself, so a rerun
# of an interrupted install can tell its own values from the operator's.
TOPOLOGY_MARK='# installer-topology: '

# Record KEY=VALUE ($2, $3) in env file $1 as written by this run's topology.
record_topology_var() {
  printf '%s%s=%s\n' "$TOPOLOGY_MARK" "$2" "$3" >> "$1"
}

# Set KEY=VALUE in env file $1 and record it as this topology's. The record
# goes first: a run stopped between the two steps then leaves a record without
# the value, which reset_topology_vars skips (the value doesn't match), never a
# value without its record, which a retry with another topology would keep.
set_topology_var() {
  record_topology_var "$1" "$2" "$3"
  set_env_var "$1" "$2" "$3"
}

# Like set_topology_var, but only when KEY is not assigned at all: an
# assignment still in .env after reset_topology_vars is the operator's (never,
# or no longer, what an earlier run wrote), and so is one in the shell. Either
# is kept even when empty: HTTP_BIND= means "every interface", as
# ensure_https_http_bind already reads it on upgrades.
set_topology_default() {
  local env="$1" key="$2"
  [[ -z "${!key+set}" ]] || return 0
  grep -qE "^[[:space:]]*${key}=" "$env" 2>/dev/null && return 0
  set_topology_var "$env" "$key" "$3"
}

# Fresh install, after the topology's values are written to .env and before
# anything starts. Compose prefers a shell value over .env for what it
# interpolates, so an exported reach value silently replaces what was just
# written. Of the values the topology branch writes:
#   - COMPOSE_FILE (which files run): stop when the shell's breaks the chosen
#     topology: without the TLS overlay on the domain topology (Caddy never
#     starts), or with it on another topology (Caddy takes 80/443 there).
#   - DOMAIN (Caddy's certificate): fresh_install assigns DOMAIN=<the domain
#     entered>, which also updates an exported DOMAIN, so Compose gets that one.
#   - HTTP_BIND (port 3000): the shell's is the operator's choice and is
#     respected (set_topology_default), as on the upgrade path.
#   - APP_ORIGIN reaches Curia through env_file only; the shell can't override it.
check_shell_reach_values() {
  local topology="$1" env="$2"
  if [[ -n "${COMPOSE_FILE+set}" ]]; then
    if [[ "$topology" == domain ]] && ! uses_tls_overlay "$COMPOSE_FILE"; then
      echo "" >&2
      error "COMPOSE_FILE is exported in your shell without docker-compose.tls.yml, so Compose would ignore .env's and never start Caddy for HTTPS."
      hint "Add docker-compose.tls.yml to the exported COMPOSE_FILE (e.g. docker-compose.yml:docker-compose.tls.yml),"
      hint "or unset COMPOSE_FILE in your shell, then re-run install.sh. Postgres was not started."
      exit 1
    fi
  fi
  # Caddy on a topology without HTTPS: the TLS overlay in the COMPOSE_FILE Compose
  # uses, from the shell or from .env (an operator's value a retry kept).
  local cf
  cf="$(compose_var "$env" COMPOSE_FILE)"
  if [[ "$topology" != domain ]] && uses_tls_overlay "$cf"; then
    local where=".env"
    [[ -z "${COMPOSE_FILE+set}" ]] || where="your shell (exported)"
    echo "" >&2
    error "COMPOSE_FILE in $where includes docker-compose.tls.yml, which starts Caddy on ports 80 and 443, but you chose a topology without it."
    hint "Remove docker-compose.tls.yml from COMPOSE_FILE there (or unset an exported one),"
    hint "then re-run install.sh (or choose option 1 for HTTPS). Postgres was not started."
    exit 1
  fi
  return 0
}

# A retry that leaves the HTTPS topology (the earlier, interrupted run recorded
# domain): that run may have started Caddy, and `up -d` without the overlay
# would leave it running as an orphan on 80/443. Remove only this project's
# caddy service container (rm -sf names the service; volumes and other
# containers are untouched). The overlay is named explicitly, since .env no
# longer lists it. When removal fails, stop before Postgres starts; the domain
# topology record ($1 = env file) is still there, so the next retry tries again.
retire_previous_caddy() {
  local env="$1" overlay="$INSTALL_DIR/docker-compose.tls.yml"
  [[ -f "$overlay" ]] || return 0
  if docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" -f "$overlay" \
      rm -sf caddy >/dev/null 2>&1; then
    return 0
  fi
  # The domain topology record is still in .env (set_topology_record has not
  # run yet), so the next retry tries this removal again.
  echo "" >&2
  error "Could not remove the Caddy container an earlier HTTPS run started; it would keep ports 80 and 443."
  hint "Remove it by hand, then re-run install.sh. Postgres was not started:"
  hint "  docker compose --project-directory \"$INSTALL_DIR\" -f \"$INSTALL_DIR/docker-compose.yml\" -f \"$overlay\" rm -sf caddy"
  exit 1
}

# Domain topology: COMPOSE_FILE must include the TLS overlay. Empty: the
# installer's value, recorded. An operator's value is kept, with the overlay
# appended when missing; that append is recorded as TLS_APPENDED, so a retry
# with another topology removes only the overlay entry, never their files.
ensure_tls_compose_file() {
  local env="$1" cur want sep="${COMPOSE_PATH_SEPARATOR:-:}"
  cur="$(env_value "$env" COMPOSE_FILE)"
  if [[ -z "$cur" ]]; then
    set_topology_var "$env" COMPOSE_FILE "docker-compose.yml:docker-compose.tls.yml"
    return 0
  fi
  uses_tls_overlay "$cur" && return 0
  want="${cur}${sep}docker-compose.tls.yml"
  # Recorded before it is written, as in set_topology_var.
  record_topology_var "$env" TLS_APPENDED "$want"
  set_env_var "$env" COMPOSE_FILE "$want"
}

# Fresh install, once the topology is chosen and before its values are written:
# an earlier, interrupted run may have written another topology's values (e.g.
# COMPOSE_FILE with the TLS overlay, then a local retry would still start Caddy
# on 80/443). Remove each value that run recorded and that still holds what it
# wrote; one changed since is the operator's and is kept, as is anything set in
# the shell. Drops the records, and echoes the earlier run's topology (empty
# when there was none).
reset_topology_vars() {
  local env="$1" line key val prior=""
  grep -q "^${TOPOLOGY_MARK}" "$env" 2>/dev/null || return 0
  while IFS= read -r line; do
    line="${line#"$TOPOLOGY_MARK"}"; key="${line%%=*}"; val="${line#*=}"
    if [[ "$key" == TOPOLOGY ]]; then prior="$val"; continue; fi
    if [[ "$key" == TLS_APPENDED ]]; then
      # Only the overlay entry this run appended to the operator's COMPOSE_FILE.
      if [[ "$(env_value "$env" COMPOSE_FILE)" == "$val" ]]; then
        set_env_var "$env" COMPOSE_FILE "${val%"${COMPOSE_PATH_SEPARATOR:-:}"docker-compose.tls.yml}"
      fi
      continue
    fi
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    if [[ "$(env_value "$env" "$key")" == "$val" ]]; then unset_env_var "$env" "$key"; fi
  done < <(grep "^${TOPOLOGY_MARK}" "$env")
  # The values are reverted; their records go. The topology record stays until
  # set_topology_record replaces it, after any cleanup it implies has succeeded
  # (retire_previous_caddy), so an interrupted run leaves it for the next retry.
  drop_topology_records "$env" keep-topology
  printf '%s' "$prior"
}

# Remove the topology records from env file $1 (a finished install needs none).
# With $2 = keep-topology, the TOPOLOGY record(s) stay.
drop_topology_records() {
  local tmp
  tmp="$(mktemp)"
  if [[ "${2:-}" == keep-topology ]]; then
    awk -v m="$TOPOLOGY_MARK" 'index($0, m) == 1 && index($0, m "TOPOLOGY=") != 1 { next } { print }' "$1" > "$tmp"
  else
    grep -v "^${TOPOLOGY_MARK}" "$1" > "$tmp" || true
  fi
  mv "$tmp" "$1"
}

# Record $2 as this run's topology in env file $1, replacing the earlier run's.
# The new record is appended before the old ones are removed, so no interrupt
# leaves the file without one; reset_topology_vars reads the last.
set_topology_record() {
  local tmp
  record_topology_var "$1" TOPOLOGY "$2"
  tmp="$(mktemp)"
  awk -v m="${TOPOLOGY_MARK}TOPOLOGY=" '
    { line[NR] = $0; if (index($0, m) == 1) last = NR }
    END { for (i = 1; i <= NR; i++) if (index(line[i], m) != 1 || i == last) print line[i] }' "$1" > "$tmp"
  mv "$tmp" "$1"
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

# Echo the name of this install's Postgres volume as Compose resolves it: the
# rendered config's volumes.pgdata.name, which already reflects a top-level
# `name:` in the compose file, COMPOSE_PROJECT_NAME and a volume `name:`. When
# Compose can't render the config, <project>_pgdata derived the way Compose does
# (compose_project_name).
pgdata_volume_name() {
  local env="$1" cfg name=""
  # Captured first, not piped: awk stopping early must not fail the docker side.
  if cfg="$(docker compose --project-directory "$INSTALL_DIR" config 2>/dev/null)"; then
    name="$(awk '
      /^[^[:space:]#]/ { top = $0; in_vol = 0 }
      top ~ /^volumes:/ && /^  [^[:space:]]/ { in_vol = ($0 ~ /^  pgdata:/) }
      in_vol && /^    name:/ { sub(/^    name:[[:space:]]*/, ""); gsub(/["\047]/, ""); print; exit }' <<< "$cfg")"
  fi
  [[ -n "$name" ]] || name="$(compose_project_name "$env")_pgdata"
  printf '%s' "$name"
}

# Whether this install's Postgres volume exists, i.e. Postgres was already
# initialised with whatever DB_PASSWORD was then in .env. Returns 0 when it
# exists, 1 when Docker says there is no such volume, and 2 when the lookup
# failed for any other reason (Docker unreachable): unknown is not absent.
pgdata_volume_exists() {
  local err
  err="$(docker volume inspect "$(pgdata_volume_name "$1")" 2>&1 >/dev/null)" && return 0
  case "$err" in
    *[Nn]"o such volume"*) return 1 ;;
  esac
  return 2
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
  # and livekit.local.yaml are separate files.
  # Only a real mount counts: older compose files name it in a comment.
  local lk
  for lk in livekit.yaml livekit.local.yaml; do
    if compose_mounts_config "$lk" \
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
    echo "     similar in front. Curia listens on its HTTP port (3000 by default) behind it."
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
# a path beyond "/", a query or fragment, an empty host, or a host outside
# [A-Za-z0-9.-] (userinfo, quotes, $, backticks; IPv6 literals included) or a
# port that is not a number from 1 to 65535. The value lands in .env and the vault.
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
  [[ "$rest" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || return 1
  # A port must be 1-65535 (browsers refuse anything else); leading zeros are
  # dropped so the setup link and the LiveKit URL carry the plain number.
  if [[ "$rest" == *:* ]]; then
    local port="${rest##*:}"
    port="${port#"${port%%[!0]*}"}"
    [[ -n "$port" && ${#port} -le 5 ]] || return 1
    (( port <= 65535 )) || return 1
    rest="${rest%:*}:$port"
  fi
  printf '%s://%s' "$scheme" "$rest"
}

# Browser-facing LiveKit base URL (never ending in /rtc: livekit-client appends it).
#   livekit_browser_url <topology> <domain_or_origin> [livekit host port]
# Installs reached only from this machine use ws://localhost:<port>, the host
# port signaling is published on (livekit_host_port; 7880 by default).
livekit_browser_url() {
  local topology="$1" value="${2:-}" port="${3:-7880}"
  case "$topology" in
    domain) printf 'wss://%s' "$value" ;;
    proxy)
      case "$value" in
        https://*) printf 'wss://%s' "${value#https://}" ;;
        http://*)  printf 'ws://%s' "${value#http://}" ;;
        *)         printf 'ws://localhost:%s' "$port" ;;
      esac ;;
    *) printf 'ws://localhost:%s' "$port" ;;
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
      hint "Calls then use LiveKit on localhost; this is for testing only."
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

  # Two phases. First every decision that writes .env (secrets aside): the
  # topology and its values, then LiveKit's. Then, once .env and COMPOSE_FILE
  # are final, one resolution point reads everything that depends on the
  # rendered compose (the Postgres volume, Curia's and LiveKit's published
  # ports, LiveKit's command and keys, whether livekit runs) and runs the
  # preflight checks, before anything starts. Nothing rendered is read earlier.

  # Only generate a new encryption key if the current value is the template
  # placeholder or entirely absent/empty. A key that already exists must be
  # preserved — regenerating it makes any existing encrypted vault rows unreadable.
  # A key already there means an earlier run of this install got this far, so the
  # vault may already hold values seed-vault keeps (the LiveKit ones).
  local rerun=1
  if grep -qE '^SECRET_ENCRYPTION_KEY=(replace-with|[[:space:]]*$)' "$env" 2>/dev/null \
      || ! grep -qE '^SECRET_ENCRYPTION_KEY=' "$env" 2>/dev/null; then
    rerun=0
    local secret_key
    secret_key="$(gen_secret_b64)"
    set_env_var "$env" SECRET_ENCRYPTION_KEY "$secret_key"
  fi

  # Pin the app image tag to the resolved CURIA_VERSION (latest / vX.Y.Z / edge),
  # so the config files and the image both come from the same release. This runs
  # only on fresh install, so a re-run never clobbers an operator's hand-pinned
  # tag. CURIA_POSTGRES_TAG is intentionally left at its default (pg16) — the
  # postgres image is versioned by PG major, not app version.
  if [[ -n "$CURIA_IMAGE_TAG_RESOLVED" ]]; then
    set_env_var "$env" CURIA_IMAGE_TAG "$CURIA_IMAGE_TAG_RESOLVED"
  fi

  # Prompt for the Anthropic key (format-validated, 3 retries). Not written to
  # .env — passed as a transient env var to the vault-seed container only.
  local anthropic
  anthropic="$(prompt_anthropic_key)"

  # Prompt for topology only on a fresh install (no COMPOSE_FILE/DOMAIN yet).
  # TOPOLOGY and PROXY_ORIGIN are read by later steps (LiveKit seeding).
  TOPOLOGY="$(choose_topology)"
  PROXY_ORIGIN=""
  # A rerun of an interrupted install starts from this choice, not the last one's.
  # The earlier run's topology record outlives the reset until the cleanup it
  # implies (its Caddy) has succeeded; only then is this run's recorded.
  local prior_topology
  prior_topology="$(reset_topology_vars "$env")"
  if [[ -n "$prior_topology" && "$prior_topology" != "$TOPOLOGY" ]]; then
    echo "" >&2
    warn "An earlier, interrupted run chose another way to reach Curia; its settings were replaced by this choice."
    [[ "$prior_topology" != domain ]] || retire_previous_caddy "$env"
  fi
  set_topology_record "$env" "$TOPOLOGY"
  case "$TOPOLOGY" in
    domain)
      # Require a non-empty domain — the TLS overlay and the summary URL are
      # both useless without one, and Caddy cannot request a certificate.
      local dom=""
      while [[ -z "$dom" ]]; do
        read -rp "Domain (e.g. curia.example.com): " dom
        [[ -n "$dom" ]] || error "A domain is required for the HTTPS topology."
      done
      set_topology_var "$env" DOMAIN "$dom"
      # An operator's COMPOSE_FILE (e.g. their own overlay added after an
      # interrupted run) is kept, with the TLS overlay added when missing.
      ensure_tls_compose_file "$env"
      # Caddy reaches curia:3000 over the compose network; keep :3000 off the
      # public interface so traffic can't bypass TLS. An operator's own
      # HTTP_BIND is kept, as on the upgrade path (ensure_https_http_bind).
      set_topology_default "$env" HTTP_BIND 127.0.0.1
      # Public origin for console links, Secure cookies and CORS. Recorded only
      # when this run filled it: a value already there is the operator's.
      # Recorded before ensure_https_app_origin writes it, as in set_topology_var;
      # when that writes nothing (a domain it can't turn into an origin), the
      # record matches no value and a retry skips it.
      if [[ -z "$(env_value "$env" APP_ORIGIN)" ]]; then
        record_topology_var "$env" APP_ORIGIN "https://$dom"
        ensure_https_app_origin "$env"
      fi
      # Kept as a shell variable for the LiveKit URL and the closing address below.
      DOMAIN="$dom"
      # A rerun of an interrupted install finds its own Caddy on 80/443.
      if { port_listening 80 || port_listening 443; } && ! service_running caddy; then
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
      # Evaluation on this machine: http://localhost:3000 only (an operator's
      # own HTTP_BIND is kept).
      set_topology_default "$env" HTTP_BIND 127.0.0.1
      ;;
    *)
      # proxy: base compose only, HTTP on :3000 on every interface.
      PROXY_ORIGIN="$(prompt_proxy_origin)"
      if [[ -n "$PROXY_ORIGIN" && -z "$(env_value "$env" APP_ORIGIN)" ]]; then
        set_topology_var "$env" APP_ORIGIN "$PROXY_ORIGIN"
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

  # Only a release whose compose file mounts LiveKit's config (the one the
  # chosen command reads) can run it; an older one (a pinned CURIA_VERSION)
  # would crash-loop LiveKit on a missing file, so voice stays off there.
  local lk_on=1
  compose_mounts_config livekit.yaml || lk_on=0
  [[ "$lk_mode" != local ]] || compose_mounts_config livekit.local.yaml || lk_on=0

  # LiveKit's .env values (still the first phase: nothing rendered is read here).
  if [[ $lk_on -eq 1 ]]; then
    retarget_livekit_command "$env" "$lk_mode"
    ensure_livekit_env "$env" "$lk_mode"
  fi

  # ---- Reach and LiveKit settings (.env, COMPOSE_FILE) are final from here: ----
  # ---- the one resolution point for everything read from the rendered compose. ----

  # An exported reach value that breaks the chosen topology stops here.
  check_shell_reach_values "$TOPOLOGY" "$env"

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
  # interrupted, initialised it with that password, so changing .env alone would
  # lock the installer out of it.
  # A failed volume lookup stops here, before DB_PASSWORD is written: replacing
  # the password of a volume that does exist would lock the installer out of it.
  # The volume is the one the final compose renders (after the topology's files).
  db_pass="$(env_value "$env" DB_PASSWORD)"
  case "$db_pass" in
    ""|replace-*) db_pass="$(gen_secret_hex)" ;;
    your-db-password)
      local vol_rc=0
      pgdata_volume_exists "$env" || vol_rc=$?
      case "$vol_rc" in
        0)
          warn "Keeping DB_PASSWORD=your-db-password, the weak default from .env.example:"
          hint "this install's Postgres volume was already set up with it." ;;
        1) db_pass="$(gen_secret_hex)" ;;
        *)
          error "Could not check whether this install's Postgres volume already exists (Docker did not answer)."
          hint "DB_PASSWORD was left as it is, since the volume may already use it."
          hint "Re-run install.sh once Docker is available. Nothing was started."
          exit 1 ;;
      esac ;;
  esac
  api_token="$(gen_secret_hex)"
  boot_secret="$(gen_secret_hex)"

  set_env_var "$env" DB_USER curia
  set_env_var "$env" DB_PASSWORD "$db_pass"
  # Note: the compose `curia` service overrides DATABASE_URL in its environment:
  # block (pointing at the internal postgres hostname). This .env value is used
  # by the migration runner (docker compose run --rm curia), not by the app container.
  set_env_var "$env" DATABASE_URL "postgres://curia:${db_pass}@postgres:5432/curia"

  # Curia's host port, for every message that names it (the closing address and
  # a proxy's forwarding rule), from the final compose.
  resolve_curia_port_for_messages "$env"

  # Seed the Voice channel's vault values to match what LiveKit runs on. The
  # keys are passed to the seed container only, like the other secrets, and
  # are never printed. seed-vault never replaces values already in the vault.
  # lk_seed holds -e NAME flags only; the values travel in the environment.
  local lk_url="" lk_key="" lk_secret="" lk_pair="" lk_rc=0
  local -a lk_seed=()
  if [[ $lk_on -eq 1 ]]; then
    require_livekit_real_keys "$env"

    # The port Compose publishes signaling on, for the URL saved below; an
    # unknowable one stops here, before anything starts or is seeded.
    require_livekit_host_port "$env"
    # Compose publishes no host port for signaling: a browser on this machine
    # can't reach it, so a localhost URL would be a guess. Save none, and say so.
    # Domain installs reach LiveKit through Caddy on the compose network.
    if [[ -n "$LIVEKIT_HOST_PORT" || "$lk_mode" != local ]]; then
      lk_url="$(livekit_browser_url "$TOPOLOGY" "$lk_value" "$LIVEKIT_HOST_PORT")"
      lk_seed=(-e SEED_LIVEKIT_URL)
    fi
    if [[ -z "$LIVEKIT_HOST_PORT" && "$TOPOLOGY" != domain ]]; then
      if [[ "$lk_mode" == local ]]; then note_livekit_signaling_unpublished local; else note_livekit_signaling_unpublished proxy; fi
    fi
    # The keys the service Compose renders runs on (a compose override's own
    # --keys or LIVEKIT_KEYS included); .env and the shell when it can't render.
    if rendered_livekit && [[ "$RENDERED_LIVEKIT_ACTIVE" == 1 ]]; then
      lk_pair="$(rendered_livekit_seed_keys)" || lk_rc=$?
    else
      lk_pair="$(livekit_seed_keys "$(compose_var "$env" LIVEKIT_KEYS)" "$(effective_livekit_command "$env")")" || lk_rc=$?
    fi
    if [[ $lk_rc -eq 0 ]]; then
      lk_key="${lk_pair%% *}"; lk_secret="${lk_pair#* }"
      lk_seed+=(-e SEED_LIVEKIT_API_KEY -e SEED_LIVEKIT_API_SECRET)
    else
      warn "Could not tell which keys LiveKit's command uses, so they were not saved for Curia."
      hint "Enter the LiveKit API key and secret under Settings → Channels → Voice after setup."
    fi
  elif livekit_will_start "$env"; then
    # Compose starts this compose file's livekit service as it stands (the voice
    # profile is on, or the service has no profile), whatever the installer can
    # provision: the same --dev check, on the rendered command, before anything starts.
    require_livekit_real_keys "$env"
    echo "" >&2
    warn "This release's docker-compose.yml does not mount LiveKit's config, so the installer"
    hint "left LiveKit as your compose file and .env set it up, and saved nothing for Curia."
    hint "Enter LiveKit's URL and keys under Settings → Channels → Voice, or see docs/dev/voice-setup.md:"
    hint "  https://github.com/josephfung/curia/blob/main/docs/dev/voice-setup.md#turn-voice-on-for-an-existing-install"
  else
    echo "" >&2
    warn "Voice (LiveKit) is off: this release's docker-compose.yml does not mount LiveKit's config."
    hint "To turn it on later, see the steps for an existing install in docs/dev/voice-setup.md:"
    hint "  https://github.com/josephfung/curia/blob/main/docs/dev/voice-setup.md#turn-voice-on-for-an-existing-install"
  fi

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
  # passed as transient env vars so they never land on disk in plaintext, and by
  # name (-e NAME): the values are exported into a subshell for docker to read,
  # never put on its command line, where `ps` would show them.
  # SEED_VAULT_VERIFY=1 makes seed-vault confirm required rows exist and exit
  # non-zero if any are missing — so a partial seed fails loudly here rather
  # than booting a half-configured instance with auth disabled.
  info "Seeding secrets vault (in-container)..."
  if ! (
    export ANTHROPIC_API_KEY="$anthropic" API_TOKEN="$api_token" WEB_APP_BOOTSTRAP_SECRET="$boot_secret" \
      SEED_LIVEKIT_URL="$lk_url" SEED_LIVEKIT_API_KEY="$lk_key" SEED_LIVEKIT_API_SECRET="$lk_secret"
    docker compose --project-directory "$INSTALL_DIR" run --rm \
      -e ANTHROPIC_API_KEY -e API_TOKEN -e WEB_APP_BOOTSTRAP_SECRET \
      ${lk_seed[@]+"${lk_seed[@]}"} \
      -e SEED_VAULT_VERIFY=1 \
      curia ./node_modules/.bin/tsx scripts/seed-vault.ts
  ); then
    error "Vault seeding failed."
    hint "Check Docker logs: docker compose --project-directory \"$INSTALL_DIR\" logs curia"
    exit 1
  fi
  # seed-vault keeps LiveKit values an earlier run saved, even when this run
  # offered others (e.g. a corrected domain), and only its log says so.
  if [[ $rerun -eq 1 && $lk_on -eq 1 ]]; then note_livekit_values_kept; fi

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
  # this marker and takes the upgrade path instead of rotating secrets. The
  # topology records only serve a rerun of an unfinished install, so they go
  # once the marker is written, never before.
  printf '\n# SETUP_COMPLETE\n' >> "$env"
  drop_topology_records "$env"

  # livekit_next_steps_state reads off when the voice profile is off and
  # livekit is not running, so an install the installer left voice off on says so.
  print_summary "$boot_secret" "$(setup_base_url "$TOPOLOGY" "$lk_value")"
  # LIVEKIT_HOST_PORT is set (possibly empty: nothing published) when LiveKit
  # was set up above; otherwise ask, with an unknown port read as 7880 (advice only).
  local lk_port lk_port_rc=0
  if [[ -n "${LIVEKIT_HOST_PORT+set}" ]]; then
    lk_port="$LIVEKIT_HOST_PORT"
  else
    lk_port="$(livekit_host_port "$env")" || lk_port_rc=$?
    case "$lk_port_rc" in 0) ;; 2) lk_port="" ;; *) lk_port=7880 ;; esac
  fi
  print_next_steps "$TOPOLOGY" "$(livekit_next_steps_state "$env")" "$PROXY_ORIGIN" "$lk_port"
}

# ---------------------------------------------------------------------------
# Existing-install path: upgrade / restart without rotating any secret.
# ---------------------------------------------------------------------------
existing_install() {
  local env="$1"
  info "Existing install detected — running in upgrade/restart mode."
  info "No secrets will be regenerated."
  # Curia's host port, for every message that names it (the hints below, the
  # closing address and a proxy's forwarding rule).
  resolve_curia_port_for_messages "$env"

  ensure_https_http_bind "$env"
  ensure_https_app_origin "$env" note

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
  # (anthropic_api_key, api_token, web_app_bootstrap_secret) are present and
  # decryptable. If any are missing the re-run fails loudly — the operator
  # should run a fresh install from a clean install dir in that case.
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


  # The topology this install looks like: the TLS overlay is the HTTPS
  # topology, an APP_ORIGIN without it is a user's own proxy, and anything
  # else is local. It picks the address and the closing steps.
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
  # Only advice here (nothing is seeded on upgrades): an unknowable port reads as 7880.
  # Empty when Compose publishes no host port for signaling (rc 2).
  local lk_port lk_port_rc=0
  lk_port="$(livekit_host_port "$env")" || lk_port_rc=$?
  case "$lk_port_rc" in 0) ;; 2) lk_port="" ;; *) lk_port=7880 ;; esac
  print_next_steps "$topology" "$(livekit_next_steps_state "$env")" "$origin" "$lk_port"
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
