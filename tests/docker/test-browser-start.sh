#!/usr/bin/env bash
# Regression test for curia#2566.
#
# The `browser` service must start Chrome, with its namespace sandbox on, under the
# exact hardening docker-compose.yml gives it. Under `cap_drop: [ALL]` with nothing
# added back, Chrome's zygote exited at launch ("Zygote process exited prematurely
# (namespace sandbox)") on Linux Docker: the sandbox chroots into an empty directory
# inside its user namespace, which needs CAP_SYS_CHROOT in the container's bounding set.
#
# The test starts the service from the real compose file, not a copy of its settings,
# so a change to the file's capabilities, seccomp profile or other hardening is what
# gets tested. It then checks that:
#   1. DevTools answers GET /json/version from the `browser` network, as Curia reaches it;
#   2. chrome://sandbox reports the namespace sandbox in use, so Chrome did not start
#      only because the sandbox was turned off.
#
# By default it builds the image from this checkout. BROWSER_IMAGE_TAG=<tag> tests an
# already-pulled ghcr.io/josephfung/curia-browser:<tag> instead (e.g. edge).
#
# Requires Docker with Compose v2. Run: bash tests/docker/test-browser-start.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO=ghcr.io/josephfung/curia-browser
PROJECT="curia-browsertest-$$"
BUILT_TAG=""
if [[ -n "${BROWSER_IMAGE_TAG:-}" ]]; then
  TAG="$BROWSER_IMAGE_TAG"
else
  TAG="ci-$$"
  BUILT_TAG="$TAG"
fi
IMAGE="$REPO:$TAG"
# Chrome normally answers within a few seconds; the margin is for a slow runner.
START_TIMEOUT="${START_TIMEOUT:-90}"

# Compose loads every service's env_file even when starting one service, and the
# `curia` service names `.env`, which a CI checkout lacks. An override that resets
# that one key, in a temp directory, keeps the test from touching the checkout; the
# browser service is left exactly as docker-compose.yml defines it. Its relative
# seccomp path resolves against --project-directory, as in a real install.
WORKDIR="$(mktemp -d)"
cat > "$WORKDIR/no-env-file.yml" <<'YAML'
services:
  curia:
    env_file: !reset []
YAML

compose() {
  CURIA_IMAGE_TAG="$TAG" docker compose \
    --project-name "$PROJECT" \
    --project-directory "$REPO_ROOT" \
    --file "$REPO_ROOT/docker-compose.yml" \
    --file "$WORKDIR/no-env-file.yml" \
    "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  [[ -n "$BUILT_TAG" ]] && docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

pass() { echo "  PASS: $*"; }
fail() {
  echo "  FAIL: $*" >&2
  echo "  --- last 40 log lines (browser) ---" >&2
  compose logs --no-color --tail 40 browser >&2 || true
  exit 1
}

if [[ -n "$BUILT_TAG" ]]; then
  echo "==> Building curia-browser image (context: repo root)..."
  docker build -f "$REPO_ROOT/docker/browser.Dockerfile" -t "$IMAGE" "$REPO_ROOT" >/dev/null
fi

echo "==> Starting the browser service from docker-compose.yml ($IMAGE)..."
compose up --detach --no-deps --pull never browser >/dev/null

container="$(compose ps --all --quiet browser)"
[[ -n "$container" ]] || fail "compose did not create the browser container"
network="${PROJECT}_browser"

# The DevTools port refuses the network's gateway, which is where the Docker host
# arrives from, so the probe runs in a sibling container on the `browser` network, as
# Curia does. The browser image itself carries Node, so nothing else is pulled. Chrome
# answers only when the Host header is an IP, so the probe connects by IP.
probe_version() {
  local ip
  ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$container")"
  docker run --rm --network "$network" --read-only --cap-drop ALL \
    --entrypoint node "$IMAGE" -e '
      fetch(`http://${process.argv[1]}:9222/json/version`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .then((j) => { if (!j.Browser) process.exit(1); console.log(j.Browser); })
        .catch(() => process.exit(1));
    ' "$ip"
}

echo "==> Waiting up to ${START_TIMEOUT}s for DevTools on the browser network..."
browser_version=""
for ((i = 1; i <= START_TIMEOUT; i++)); do
  status="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$container" 2>/dev/null || echo missing)"
  case "$status" in
    exited*|dead*|missing) fail "the browser container stopped ($status): Chrome did not start (curia#2566)" ;;
    restarting*) fail "the browser container is restarting: Chrome did not start (curia#2566)" ;;
    "running 0") ;;
    running*) fail "the browser container restarted ($status): Chrome exited after starting (curia#2566)" ;;
  esac
  if browser_version="$(probe_version 2>/dev/null)"; then break; fi
  browser_version=""
  sleep 1
done
[[ -n "$browser_version" ]] || fail "DevTools did not answer /json/version within ${START_TIMEOUT}s"
pass "DevTools answered from the browser network: $browser_version"

# chrome://sandbox, read over Chrome's own loopback DevTools port from inside the
# container. On Linux it lists the layer-1 sandbox ("Namespace" when the namespace
# sandbox is in use) and ends with whether the renderer is adequately sandboxed.
echo "==> Reading chrome://sandbox..."
sandbox_text="$(docker exec "$container" node -e '
  const base = "http://127.0.0.1:9223";
  const fail = (m) => { console.error(m); process.exit(1); };
  (async () => {
    const t = await (await fetch(`${base}/json/new?chrome://sandbox`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0;
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const mine = ++id;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== mine) return;
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("websocket error")); });
    // The page fills in its table asynchronously; wait for the verdict line.
    let text = "";
    for (let i = 0; i < 50; i++) {
      const r = await call("Runtime.evaluate", { expression: "document.body ? document.body.innerText : \"\"", returnByValue: true });
      text = r.result.value || "";
      if (/sandboxed/i.test(text)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    ws.close();
    await fetch(`${base}/json/close/${t.id}`);
    console.log(text);
  })().catch((e) => fail(String(e)));
')" || fail "could not read chrome://sandbox over DevTools"

if ! grep -Eiq 'Layer 1 Sandbox[[:space:]]*Namespace' <<<"$sandbox_text"; then
  echo "$sandbox_text" >&2
  fail "chrome://sandbox does not report the namespace sandbox as layer 1"
fi
if ! grep -q 'You are adequately sandboxed' <<<"$sandbox_text"; then
  echo "$sandbox_text" >&2
  fail "chrome://sandbox does not report the renderer as adequately sandboxed"
fi
pass "chrome://sandbox: namespace sandbox in use, adequately sandboxed"

echo "ALL BROWSER IMAGE TESTS PASSED"
