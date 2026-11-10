#!/usr/bin/env bash
# docker/browser-entrypoint.sh — start Chrome for Curia to attach to over CDP (#2541).
#
# Runs Xvfb with a window manager and panel (#2221), Chrome headful on it with the
# persistent profile in /profile, and a forwarder that exposes Chrome's DevTools port to
# the compose network. If any of them exits, so does this script, and Docker's restart
# policy brings the whole set back; Curia reconnects on its own.
#
# Environment (all optional; docker-compose.yml passes them through):
#   BROWSER_LOCALE     BCP 47 locale, e.g. en-CA. Default en-US.
#   BROWSER_LANGUAGES  Comma-separated navigator.languages list; the locale is put first.
#   BROWSER_PROXY      Egress proxy, e.g. http://proxy:8888 or socks5://proxy:1080. No
#                      credentials: Chrome's --proxy-server cannot carry them.
#   TZ                 IANA timezone Chrome reports, e.g. America/Toronto.
set -euo pipefail

# --- DevTools peer gate --------------------------------------------------------------
# DevTools has no authentication, and not publishing the port is not enough: on Linux any
# user on the Docker host can connect to a container's bridge IP, arriving from the
# network's gateway address, and a routed LAN client arrives from outside the subnet.
# socat runs this script with --devtools-gate for each connection. Only loopback and a
# peer inside this container's own subnet, other than the gateway, reach Chrome: on the
# shipped compose file, Curia (the network's only other member) and the healthcheck.

# /proc/net/route stores IPv4 addresses as little-endian hex.
le_hex_to_int() {
  local h="$1"
  echo $(( (16#${h:6:2} << 24) | (16#${h:4:2} << 16) | (16#${h:2:2} << 8) | 16#${h:0:2} ))
}

devtools_peer_allowed() {
  local peer="$1" route_file="${ROUTE_FILE:-/proc/net/route}"
  [[ "$peer" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  # Loopback is this container itself (the healthcheck); it can reach Chrome's port anyway.
  [[ "${BASH_REMATCH[1]}" == 127 ]] && return 0
  local p=$(( (10#${BASH_REMATCH[1]} << 24) | (10#${BASH_REMATCH[2]} << 16) | (10#${BASH_REMATCH[3]} << 8) | 10#${BASH_REMATCH[4]} ))
  local iface dest gw flags rest mask in_subnet=1 is_gateway=1
  while read -r iface dest gw flags _ _ _ mask rest; do
    [[ "$iface" == Iface ]] && continue
    if [[ "$dest" == 00000000 ]]; then
      (( p == $(le_hex_to_int "$gw") )) && is_gateway=0
    elif [[ "$gw" == 00000000 ]]; then
      (( (p & $(le_hex_to_int "$mask")) == $(le_hex_to_int "$dest") )) && in_subnet=0
    fi
  done < "$route_file"
  (( in_subnet == 0 && is_gateway != 0 ))
}

case "${1:-}" in
  --devtools-peer-allowed)  # for tests
    devtools_peer_allowed "$2"; exit $? ;;
  --devtools-gate)
    if devtools_peer_allowed "${SOCAT_PEERADDR:-}"; then
      exec socat - "TCP:127.0.0.1:9223"
    fi
    echo "browser-entrypoint: refused a DevTools connection from ${SOCAT_PEERADDR:-unknown}" >&2
    exit 1 ;;
esac
# --------------------------------------------------------------------------------------

readonly SCREEN=1920x1080x24      # SCREEN_SIZE in src/browser/browser-service.ts
readonly WINDOW=1440,900          # WINDOW_SIZE in src/browser/browser-service.ts
readonly DEVTOOLS_PORT=9222       # what Curia connects to
readonly CHROME_PORT=9223         # Chrome's own, loopback only
readonly PROFILE=/profile

locale="${BROWSER_LOCALE:-en-US}"
if [[ ! "$locale" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "browser-entrypoint: BROWSER_LOCALE must be a language tag such as en-CA, got: $locale" >&2
  exit 1
fi
languages="$locale"
if [[ -n "${BROWSER_LANGUAGES:-}" ]]; then
  if [[ ! "$BROWSER_LANGUAGES" =~ ^[A-Za-z0-9,-]+$ ]]; then
    echo "browser-entrypoint: BROWSER_LANGUAGES must be comma-separated language tags, got: $BROWSER_LANGUAGES" >&2
    exit 1
  fi
  IFS=',' read -r -a extra <<< "$BROWSER_LANGUAGES"
  for lang in "${extra[@]}"; do
    [[ -n "$lang" && "$lang" != "$locale" ]] && languages+=",$lang"
  done
fi

# Fail closed on the proxy: it exists to keep the datacenter IP hidden, so a value Chrome
# would ignore or misread must stop the container rather than egress directly.
proxy_args=()
if [[ -n "${BROWSER_PROXY:-}" ]]; then
  if [[ "$BROWSER_PROXY" == *@* ]]; then
    echo "browser-entrypoint: BROWSER_PROXY cannot carry credentials; use a proxy that allows this host without them" >&2
    exit 1
  fi
  if [[ ! "$BROWSER_PROXY" =~ ^(https?|socks5)://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
    echo "browser-entrypoint: BROWSER_PROXY must look like http://host:port or socks5://host:port, got: $BROWSER_PROXY" >&2
    exit 1
  fi
  proxy_args+=("--proxy-server=${BROWSER_PROXY%/}" '--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
  if [[ "$BROWSER_PROXY" == socks5://* ]]; then
    # As Playwright does for SOCKS: resolve names through the proxy, never locally.
    proxy_host="${BROWSER_PROXY#socks5://}"; proxy_host="${proxy_host%%[:/]*}"
    proxy_args+=("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${proxy_host}")
  fi
fi

# A profile lock names the container that held it, and this container gets a new
# hostname on every recreate, so Chrome would read any lock as "in use on another
# computer". This container is the profile's only user, so any lock here is stale.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"

export DISPLAY=:99
Xvfb :99 -screen 0 "$SCREEN" -nolisten tcp &
for _ in $(seq 50); do
  [[ -S /tmp/.X11-unix/X99 ]] && break
  sleep 0.1
done
if [[ ! -S /tmp/.X11-unix/X99 ]]; then
  echo "browser-entrypoint: Xvfb did not start" >&2
  exit 1
fi
openbox --sm-disable &
tint2 >/dev/null 2>&1 &

# Chrome serves DevTools on loopback only (it ignores --remote-debugging-address when
# headful), so socat forwards the compose network's port to it, through the peer gate at
# the top of this script. Chrome answers only when the Host header is an IP or
# localhost; Curia connects by IP for that reason.
socat "TCP-LISTEN:${DEVTOOLS_PORT},fork,reuseaddr" "EXEC:$0 --devtools-gate" &

# The flags Patchright passes when it launches Chromium itself (chromiumSwitches in
# patchright-core), so a container session looks like an in-process one;
# tests/unit/browser/browser-entrypoint.test.ts checks they stay in step. Then the ones
# BrowserService.launchPersistentContext adds. Chrome's sandbox stays on, under
# docker/seccomp-chrome.json.
#
# LANG sets the ICU (Intl) locale, which on Linux ignores --lang.
LANG="${locale//-/_}.UTF-8" /ms-playwright/chrome \
  --disable-field-trial-config \
  --disable-background-networking \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-breakpad \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-edgeupdater \
  --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,AvoidCorsURLLoaderRestartOnRedirect,Translate,AutoDeElevate,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion \
  --enable-features=CDPScreenshotNewSurface \
  --disable-hang-monitor \
  --disable-prompt-on-repost \
  --disable-renderer-backgrounding \
  --disable-updater-scheduler \
  --force-color-profile=srgb \
  --no-first-run \
  --password-store=basic \
  --use-mock-keychain \
  --no-service-autorun \
  --export-tagged-pdf \
  --disable-search-engine-choice-screen \
  --edge-skip-compat-layer-relaunch \
  --disable-infobars \
  --disable-sync \
  --disable-blink-features=AutomationControlled \
  "--window-size=${WINDOW}" \
  "--lang=${locale}" \
  "--accept-lang=${languages}" \
  "${proxy_args[@]}" \
  "--user-data-dir=${PROFILE}" \
  "--remote-debugging-port=${CHROME_PORT}" \
  about:blank &
chrome_pid=$!

# On docker stop, let Chrome shut down cleanly so it writes out cookies and the rest of
# the profile. Without this only bash gets the signal, and the processes it leaves are
# killed outright when the container's init exits. SIGINT, not SIGTERM: Chrome treats
# SIGTERM as a fast exit and drops cookies set in the last ~30s (measured on 156).
shutdown() {
  kill -INT "$chrome_pid" 2>/dev/null
  wait "$chrome_pid" 2>/dev/null
  kill -TERM $(jobs -p) 2>/dev/null
  exit 0
}
trap shutdown TERM INT

# Exit with the first process to stop; the restart policy restarts the set.
set +e
wait -n
status=$?
echo "browser-entrypoint: a browser process exited (status $status); stopping the container" >&2
kill -TERM $(jobs -p) 2>/dev/null
exit "$status"
