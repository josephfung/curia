# Installer: HTTPS-first topology and voice on by default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh `install.sh` run recommends HTTPS, starts LiveKit on generated keys, seeds the vault to match, routes `/rtc*` through Caddy, and leaves an install whose Setup Voice step can be completed, with working call audio on every topology.

**Architecture:** Shell installers write LiveKit settings into `.env` (approach A: compose fallback stays `--dev`); a keyless `docker/livekit.yaml` ships in the bundle; `seed-vault.ts` gains a write-if-absent group; the voice runtime joins rooms over the internal signaling URL; the Setup Voice check probes LiveKit.

**Tech Stack:** bash (installers, `tests/setup/test-setup-functions.sh`), Docker Compose, Caddy 2, TypeScript/Node 26, vitest, `livekit-server-sdk` 2.19, `@livekit/rtc-node`.

**Spec:** `docs/wip/2026-11-21-installer-https-voice-design.md` (issue #2357, absorbs #2689).

## Global Constraints

- Branch `feat/2357-installer-https-voice`, worktree `worktrees/curia-feat-2357-installer-https-voice`. Commit with `-s` (DCO); no `Co-Authored-By` trailer.
- Seeded `channel.voice.livekit_url` is a **base** address, never ending in `/rtc`: `wss://<domain>`, `wss://<host>` / `ws://<host>` (proxy address), `ws://localhost:7880` (local, proxy-Enter, `setup.sh`).
- Values already in the vault for `channel.voice.livekit_url`, `channel.voice.livekit_api_key`, `channel.voice.livekit_api_secret` are never overwritten.
- An operator's existing `LIVEKIT_COMMAND`, `LIVEKIT_KEYS` or `COMPOSE_PROFILES` (shell or `.env`) is never overwritten; `voice` may be appended to an existing `COMPOSE_PROFILES`.
- `docker-compose.yml`'s livekit `command:` fallback stays `${LIVEKIT_COMMAND:---dev --bind 0.0.0.0}`; its `profiles: [voice]` stays.
- Upgrade path (`existing_install`) changes nothing about LiveKit: no `.env` LiveKit writes, no seeding; only a note when voice is off.
- Generated key: `API` + 12 alphanumerics. Secret: 64 hex chars (`gen_secret_hex`). `.env` form: `LIVEKIT_KEYS="<key>: <secret>"`.
- Setup docs link: `https://docs.meetcuria.com/get-started/check-your-setup`. Setup page path: `/setup`.
- RTC ports to open (domain and proxy): `7881/tcp`, `7882/udp`. Proxy forwarding: `/` → `3000`, `/rtc*` → `7880`.
- Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts`; `pnpm test:shell` before every commit touching shell.
- No paid test runs (no `pnpm scenarios`).

## Review Focus

1. **An interrupted fresh install re-run** (no `SETUP_COMPLETE`) must reuse the `LIVEKIT_KEYS` already in `.env`, so the running LiveKit and the vault agree → Task 3 test `ensure_livekit_env keeps existing LIVEKIT_KEYS`.
2. **A proxy address with a trailing slash, a port, or a path** (`https://h/`, `https://h:8443`, `https://h/curia`): first two accepted and normalized, path rejected → Task 4 tests on `normalize_origin`.
3. **An `.env` that already has `COMPOSE_PROFILES=signal`** (curia-deploy-style operator): result `signal,voice`, never replaced → Task 3 test.
4. **LiveKit reachable but keys wrong** (operator rotated `LIVEKIT_KEYS` by hand): Voice check says the keys were rejected, not "not running" → Task 7 test `rejected`.
5. **`setup.sh` full reset with the Postgres volume kept**: `LIVEKIT_KEYS` carried over → Task 6 test.

---

### Task 0: Spike — local call audio between the host browser and a container (throwaway)

No production code. Finds the LiveKit settings that give **both** a browser on the host and a client inside a compose container two-way audio, with LiveKit started from the shipped compose service. Do not commit spike code; record the result in the design doc.

**Files:**
- Scratch only: `/Users/josephfung/Projects/curia/scratch/2357-livekit-spike/` (outside the repo).
- Modify after: `docs/wip/2026-11-21-installer-https-voice-design.md` (append "Spike result").

- [ ] **Step 1:** Bring up only LiveKit from the worktree's compose file with generated keys: `LIVEKIT_KEYS="APIspike0001: <64 hex>"`, the mount and `LIVEKIT_KEYS` passthrough added to a scratch copy of `docker-compose.yml`, and `LIVEKIT_COMMAND="--config /etc/livekit.yaml --node-ip 127.0.0.1"`.
- [ ] **Step 2:** Write two throwaway clients that join one room, each publishing a sine tone and checking that it receives the other's audio frames (non-silent) within 15 s:
  - **Host browser:** Playwright Chromium (preinstalled; `require('playwright')`) loading a page with `livekit-client` 2.23 connecting to `ws://localhost:7880`.
  - **Container:** a Node script using `@livekit/rtc-node` (the library `room-session.ts` uses), run with `docker compose run` on the default compose network, connecting to `ws://livekit:7880`.
  Tokens are minted with `livekit-server-sdk` `AccessToken`.
- [ ] **Step 3:** Try configurations in order until both ends hear each other; record each outcome:
  1. `--node-ip 127.0.0.1` alone.
  2. node IP 127.0.0.1 plus LiveKit's interface candidates kept (`rtc.ips.includes` / `rtc.interfaces` in a scratch `livekit.yaml`).
  3. `use_external_ip: false` with no node IP.
  4. Container client via `host.docker.internal` (`extra_hosts: host.docker.internal:host-gateway` on curia) with node IP 127.0.0.1.
  5. LiveKit's embedded TURN (`turn.enabled`, TCP/TLS on a published port) as the container's path.
  Run on macOS Docker Desktop (the try-out case); note whether the winner depends on Linux vs Docker Desktop.
- [ ] **Step 4:** If one works: append "Spike result" to the design doc with the exact `LIVEKIT_COMMAND`, any `livekit.yaml`/compose additions, and the platforms verified. Tasks 1 and 3 use those exact values in place of `--node-ip 127.0.0.1` wherever this plan names it. **If none works: stop and report to the maintainer before Task 1.**
- [ ] **Step 5:** Tear the spike stack down (`docker compose -p <spike project> down -v`). Commit the design-doc note only.

```bash
git add docs/wip/2026-11-21-installer-https-voice-design.md
git commit -s -m "docs(wip): record local LiveKit audio spike result (#2357)"
```

---

### Task 1: Compose, `livekit.yaml` and Caddyfile

**Files:**
- Modify: `docker-compose.yml:41-66` (livekit service), `docker-compose.tls.yml:1-7` (header comment), `docker/livekit.yaml`, `deploy/Caddyfile`, `.env.example:66-83`
- Test: `tests/unit/deploy/compose-livekit.test.ts` (create)

**Interfaces:**
- Produces: compose `livekit` service mounts `./docker/livekit.yaml:/etc/livekit.yaml:ro` and sets `environment: LIVEKIT_KEYS: ${LIVEKIT_KEYS:-}`; `docker/livekit.yaml` has no `keys:` block; Caddyfile serves `/rtc*` from `livekit:7880`.

- [ ] **Step 1: Write the failing test** `tests/unit/deploy/compose-livekit.test.ts` (parse with `js-yaml`, read files from repo root via `import.meta.dirname`):
  - `livekit service mounts the shipped config read-only` → `volumes` contains `./docker/livekit.yaml:/etc/livekit.yaml:ro`.
  - `livekit passes LIVEKIT_KEYS through` → `environment.LIVEKIT_KEYS === '${LIVEKIT_KEYS:-}'`.
  - `livekit keeps the --dev fallback and the voice profile` → `command === '${LIVEKIT_COMMAND:---dev --bind 0.0.0.0}'`, `profiles` equals `['voice']`.
  - `shipped livekit.yaml carries no keys` → parsed object has no `keys`; `rtc.use_external_ip === true`, `rtc.udp_port === 7882`, `rtc.tcp_port === 7881`, `room.empty_timeout === 30`.
  - `Caddyfile routes /rtc* to livekit before the catch-all` → text matches `/handle \/rtc\* \{\s*reverse_proxy livekit:7880\s*\}/` and the index of that match is before the index of `reverse_proxy curia:3000`, which sits inside a bare `handle {` block.
- [ ] **Step 2:** Run `pnpm -C <worktree> exec vitest run tests/unit/deploy/compose-livekit.test.ts` → FAIL.
- [ ] **Step 3:** Make the edits. Update comments that say Caddy does not proxy LiveKit (`docker-compose.yml` livekit ports comment, `docker-compose.tls.yml` header) to say the shipped Caddyfile routes `/rtc*` and media ports still need opening. `.env.example`: document `COMPOSE_PROFILES=voice`, `LIVEKIT_KEYS`, and that the installer writes `LIVEKIT_COMMAND="--config /etc/livekit.yaml"` (keep them commented). Add the spike's additions if Task 0 required any compose change.
- [ ] **Step 4:** Run the test → PASS. Run `docker run --rm -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" -e DOMAIN=example.com caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile` → `Valid configuration`. Run `docker compose -f docker-compose.yml --profile voice config --quiet` → exit 0.
- [ ] **Step 5: Commit** `feat(install): ship keyless livekit.yaml, pass LIVEKIT_KEYS, route /rtc* in Caddy (#2357)`.

---

### Task 2: Seed the LiveKit vault values only when absent

**Files:**
- Modify: `scripts/seed-vault.ts`
- Test: `tests/integration/seed-vault.test.ts`

**Interfaces:**
- Produces: `export const SEED_IF_ABSENT_NAMES = ['channel.voice.livekit_url', 'channel.voice.livekit_api_key', 'channel.voice.livekit_api_secret'] as const;` read from env vars `SEED_LIVEKIT_URL`, `SEED_LIVEKIT_API_KEY`, `SEED_LIVEKIT_API_SECRET` (via `seedEnvVar`, added to `SEED_ENV_VARS`). `seedVault(...)` returns `{ seeded: string[]; skipped: string[]; kept: string[] }`. `parseSeedOnly` accepts these names.

- [ ] **Step 1: Write failing tests** in the existing `describeIf('seedVault')` block:
  - `writes the LiveKit values when the vault has none` → env with the three `SEED_LIVEKIT_*`; after `seedVault`, `secrets.get('channel.voice.livekit_url') === 'wss://curia.example.com'` etc., and `seeded` contains all three.
  - `never overwrites LiveKit values already in the vault` → pre-`set` the three to `old-*`; seed with new values; values remain `old-*`; `kept` equals the three names; `seeded` contains none of them.
  - `still upserts ordinary secrets` → `api_token` pre-set `old`, env `API_TOKEN=new` → `new`.
  - `parseSeedOnly accepts channel.voice.livekit_url`.
- [ ] **Step 2:** Run `pnpm -C <worktree> exec vitest run tests/integration/seed-vault.test.ts` (needs `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`; use the throwaway-DB recipe) → FAIL.
- [ ] **Step 3:** Implement: a second loop over `SEED_IF_ABSENT_NAMES` honoring `options.only`; trimmed empty → `skipped`; `await secrets.get(name) !== null` → `kept` with `log.info({ name }, 'Keeping existing vault value')`; else `set` → `seeded`. Update the file header comment.
- [ ] **Step 4:** Run tests → PASS; `pnpm -C <worktree> run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(seed-vault): seed LiveKit values only when the vault has none (#2357)`.

---

### Task 3: Shared LiveKit `.env` helpers (setup-common.sh)

**Files:**
- Modify: `scripts/setup-common.sh` (move `set_env_var` and `env_value` here from `install.sh` unchanged; add helpers below), `install.sh` (delete the moved definitions)
- Test: `tests/setup/test-setup-functions.sh` (new section `=== setup-common: livekit helpers ===`)

**Interfaces:**
- Produces (all in `setup-common.sh`):
  - `gen_livekit_keys` → stdout `API<12 alnum>: <64 hex>`.
  - `livekit_seed_keys <keys_value> <command>` → stdout `<key> <secret>` (one space), return 0; order: non-empty `LIVEKIT_KEYS` value (`k: s`, tolerate quotes/extra spaces) → `--keys "k: s"` / `--keys='k: s'` in the command → `--dev` or empty command → `devkey secret` → otherwise return 1, no output.
  - `livekit_command_for <local|public>` → `--config /etc/livekit.yaml --node-ip 127.0.0.1` for `local` (or the Task 0 value), `--config /etc/livekit.yaml` for `public`.
  - `ensure_livekit_env <env_file> <local|public>` → writes `COMPOSE_PROFILES` (unset → `voice`; set without `voice` → `<old>,voice`), `LIVEKIT_KEYS` (only when unset in shell and `.env`; value quoted), `LIVEKIT_COMMAND` (only when unset in shell and `.env`). Shell-set values are judged with `compose_var`-style lookup (shell first, then `.env`); move `compose_var` too if needed.

- [ ] **Step 1: Write failing shell tests** (temp `.env` files, existing `_assert_var` helper):
  - `gen_livekit_keys format` → matches `^API[A-Za-z0-9]{12}: [0-9a-f]{64}$`; two calls differ.
  - `livekit_seed_keys from LIVEKIT_KEYS` → `"APIabc: s3cr3t"` → `APIabc s3cr3t`; with surrounding `"` quotes → same.
  - `livekit_seed_keys from --keys` → keys empty, command `--config /x --keys "APIk: sec"` → `APIk sec`.
  - `livekit_seed_keys from --dev` → `devkey secret`; empty command → `devkey secret`.
  - `livekit_seed_keys unknown` → keys empty, command `--config /etc/livekit.yaml` → rc 1, empty output.
  - `ensure_livekit_env fresh` → `.env` from `.env.example` copy; after `local`: `COMPOSE_PROFILES=voice`, `LIVEKIT_KEYS` matches the gen format, `LIVEKIT_COMMAND` equals `livekit_command_for local`.
  - `ensure_livekit_env keeps existing LIVEKIT_KEYS` → pre-set `LIVEKIT_KEYS="APIold: oldsecret"`; after: unchanged.
  - `ensure_livekit_env keeps operator LIVEKIT_COMMAND` → pre-set `LIVEKIT_COMMAND=--config /mine.yaml` → unchanged; shell-exported `LIVEKIT_COMMAND` also prevents the write.
  - `ensure_livekit_env appends voice` → `COMPOSE_PROFILES=signal` → `signal,voice`; `COMPOSE_PROFILES=voice,x` → unchanged.
- [ ] **Step 2:** `pnpm -C <worktree> test:shell` → new cases FAIL, existing pass.
- [ ] **Step 3:** Implement; keep bash 3.2-safe (macOS), no `xargs`, no GNU-only flags.
- [ ] **Step 4:** `pnpm test:shell` → all PASS; `shellcheck scripts/setup-common.sh install.sh` clean if shellcheck is installed.
- [ ] **Step 5: Commit** `feat(install): shared LiveKit .env helpers (#2357)`.

---

### Task 4: install.sh — topology menu, proxy address, port guard

**Files:**
- Modify: `install.sh` (`choose_topology`, new helpers, `fresh_install` topology `case`)
- Test: `tests/setup/test-setup-functions.sh` (section `=== install.sh: topology ===`)

**Interfaces:**
- Produces:
  - `topology_for_choice <answer>` → `domain` for `1`/empty/anything unknown, `proxy` for `2`, `local` for `3`.
  - `normalize_origin <value>` → stdout `scheme://host[:port]` (lowercased scheme, trailing `/` stripped), return 0; return 1 for no `http(s)://`, whitespace, a path beyond `/`, query/fragment, empty host.
  - `livekit_browser_url <topology> <domain_or_origin>` → `domain`+`d` → `wss://d`; `proxy`+`https://h[:p]` → `wss://h[:p]`; `proxy`+`http://h[:p]` → `ws://h[:p]`; `proxy`+empty → `ws://localhost:7880`; `local` → `ws://localhost:7880`.
  - `port_listening <port>` → 0 when `127.0.0.1:<port>` accepts a TCP connection (bash `/dev/tcp`, 1 s bound); not unit-tested.
  - `prompt_proxy_origin` (interactive) → stdout the normalized origin or empty for Enter; re-asks on invalid; warns on `http://` that the phone app needs https.
  - Shell globals set by `fresh_install` for later tasks: `TOPOLOGY` (`domain|proxy|local`), `PROXY_ORIGIN` (may be empty).

- [ ] **Step 1: Write failing tests:**
  - `topology_for_choice` → `""`→`domain`, `1`→`domain`, `2`→`proxy`, `3`→`local`, `x`→`domain`.
  - `normalize_origin accepts` → `https://curia.example.com/` → `https://curia.example.com`; `HTTPS://h.example.com:8443` → `https://h.example.com:8443`; `http://10.0.0.5:3000` → same.
  - `normalize_origin rejects` → `curia.example.com`, `https://h.example.com/curia`, `https://h .com`, `https://`, `https://h.com?x=1` → rc 1.
  - `livekit_browser_url` → each mapping above; assert no result ends in `/rtc`.
- [ ] **Step 2:** `pnpm test:shell` → FAIL.
- [ ] **Step 3:** Implement. `choose_topology` prints exactly the menu from the design doc ("How will people reach Curia?" … "Not sure? Choose 1."), reads `Choice [1]:`, returns `topology_for_choice`. In `fresh_install`: `domain` → after reading the domain, `port_listening 80 || port_listening 443` → `warn` "Something is already using port 80 or 443 on this machine." + `hint` "If nginx, Traefik or similar already serves HTTPS here, re-run and choose option 2." (no prompt). `proxy` → `PROXY_ORIGIN="$(prompt_proxy_origin)"`; non-empty → `set_env_var "$env" APP_ORIGIN "$PROXY_ORIGIN"` unless `APP_ORIGIN` already non-empty. Keep existing `HTTP_BIND` behaviour per topology.
- [ ] **Step 4:** `pnpm test:shell` → PASS.
- [ ] **Step 5: Commit** `feat(install): HTTPS-first topology menu and proxy address question (#2357)`.

---

### Task 5: install.sh — LiveKit on, seeding, bundle fetch, closing message, upgrade note

**Files:**
- Modify: `install.sh` (`fetch_bundle`, `fresh_install`, `existing_install`), `scripts/setup-common.sh` (`print_next_steps`), `.github/workflows/release.yml:137-210`
- Test: `tests/setup/test-setup-functions.sh` (sections `=== print_next_steps ===`, `=== fetch_bundle livekit.yaml ===`, `=== note_voice_off ===`)

**Interfaces:**
- Consumes: Task 3 helpers; Task 4 `TOPOLOGY`, `PROXY_ORIGIN`, `livekit_browser_url`; Task 2 env vars `SEED_LIVEKIT_URL|API_KEY|API_SECRET`.
- Produces:
  - `print_next_steps <url> <topology>` (setup-common) → prints `Finish setting up Curia in your browser: <url>/setup`, `Guide: https://docs.meetcuria.com/get-started/check-your-setup`, then "When every step is done, choose Start onboarding."; for `domain`/`proxy` also `Open these ports for calls: 7881/tcp, 7882/udp`; for `proxy` also `Your proxy must forward / to port 3000 and /rtc* to port 7880.`
  - `note_voice_off <env>` (install.sh) → warns "Voice (LiveKit) is off on this install." + docs hint, only when `compose_var COMPOSE_PROFILES` lacks `voice` and `service_running livekit` is false.

- [ ] **Step 1: Write failing tests:**
  - `print_next_steps domain` → output contains `https://c.example.com/setup`, the docs URL, `7881/tcp, 7882/udp`, not `/rtc* to port 7880`.
  - `print_next_steps proxy` → contains the forwarding line.
  - `print_next_steps local` → contains `http://localhost:3000/setup`, not `7881/tcp`.
  - `fetch_bundle fetches livekit.yaml when compose mounts it` → stub `fetch_asset` to record calls; compose file containing `docker/livekit.yaml` → `docker/livekit.yaml:livekit.yaml` requested; a compose without it → not requested; existing file → not requested.
  - `note_voice_off` → stubbed `service_running` false + `COMPOSE_PROFILES` unset → output contains `Voice (LiveKit) is off`; `COMPOSE_PROFILES=voice` → silent; `service_running` true → silent.
- [ ] **Step 2:** `pnpm test:shell` → FAIL.
- [ ] **Step 3:** Implement:
  - `fetch_bundle`: after the seccomp block, same pattern for `docker/livekit.yaml` keyed on `grep -q 'docker/livekit\.yaml' docker-compose.yml`.
  - `fresh_install`, after the topology `case` and before Postgres: `ensure_livekit_env "$env" <local for local or proxy-with-empty-origin, else public>`; compute `lk_url="$(livekit_browser_url "$TOPOLOGY" "${DOMAIN:-$PROXY_ORIGIN}")"`; `read -r lk_key lk_secret < <(livekit_seed_keys "$(compose_var "$env" LIVEKIT_KEYS)" "$(compose_var "$env" LIVEKIT_COMMAND)")`; on rc 1 → `warn` that the keys must be entered under Settings → Channels → Voice and pass only the URL.
  - Seed container: add `-e "SEED_LIVEKIT_URL=$lk_url"` and, when known, `-e "SEED_LIVEKIT_API_KEY=$lk_key" -e "SEED_LIVEKIT_API_SECRET=$lk_secret"`.
  - After `print_summary`, call `print_next_steps "$url" "$TOPOLOGY"` (url as `print_summary` computes it; factor that into `summary_url` in setup-common if needed).
  - `existing_install`: after `note_missing_browser`, `note_voice_off "$env"`; then `print_next_steps` with topology inferred (`uses_tls_overlay` → `domain`; else `APP_ORIGIN` non-empty → `proxy`; else `local`).
  - `release.yml`: copy `docker/livekit.yaml` → `bundle/livekit.yaml`, add to `FILES`, the checksum list and the verify step, guarded by `[ -f docker/livekit.yaml ]` like seccomp.
- [ ] **Step 4:** `pnpm test:shell` → PASS. `bash -n install.sh` clean.
- [ ] **Step 5: Commit** `feat(install): start LiveKit with generated keys and seed the vault (#2357)`.

---

### Task 6: scripts/setup.sh — LiveKit default, seeding, full-reset key carry-over

**Files:**
- Modify: `scripts/setup.sh` (`handle_existing_env` option 3, `write_env`, `run_infra`)
- Test: `tests/setup/test-setup-functions.sh` (extend `=== write_env ===`, `=== handle_existing_env ===`)

**Interfaces:**
- Consumes: Task 3 helpers, Task 2 env vars, Task 5 `print_next_steps`.
- Produces: global `PRESERVED_LIVEKIT_KEYS` (set by option 3, like `PRESERVED_ENCRYPTION_KEY`).

- [ ] **Step 1: Write failing tests:**
  - `write_env writes LiveKit defaults` → `.env` has `COMPOSE_PROFILES=voice`, a generated `LIVEKIT_KEYS`, `LIVEKIT_COMMAND` = `livekit_command_for local`.
  - `full reset keeps LIVEKIT_KEYS` → existing `.env` with `LIVEKIT_KEYS="APIkeep: keepsecret"`; drive option 3 with `yes` (existing test pattern); then `write_env` → `.env` still has `APIkeep: keepsecret`.
- [ ] **Step 2:** `pnpm test:shell` → FAIL.
- [ ] **Step 3:** Implement: `write_env` calls `ensure_livekit_env "$ENV_FILE" local` after the sed, writing `PRESERVED_LIVEKIT_KEYS` first when set. In `run_infra` full mode add `SEED_LIVEKIT_URL=ws://localhost:7880` and the keys from `livekit_seed_keys` to `seed_secret_env`. End with `print_next_steps "http://localhost:${HTTP_PORT:-3000}" local`. Resume and option 1 unchanged.
- [ ] **Step 4:** `pnpm test:shell` → PASS.
- [ ] **Step 5: Commit** `feat(setup): LiveKit on by default for source installs (#2357)`.

---

### Task 7: Voice check probes LiveKit

**Files:**
- Create: `src/setup/livekit-probe.ts`
- Modify: `src/setup/checklist.ts` (`SetupCheckDeps`, `checkVoice`), `src/index.ts:3285-3320` (wire the dep)
- Test: `tests/unit/setup/livekit-probe.test.ts` (create), `tests/unit/setup/checklist.test.ts`

**Interfaces:**
- Produces:
  - `export type LiveKitProbeResult = 'ok' | 'no_keys' | 'unreachable' | 'rejected';`
  - `export async function probeLiveKit(deps: { getSecret: (name: string) => Promise<string | null>; managementUrl: string; logger: Logger; listRooms?: typeof listVoiceRooms }): Promise<LiveKitProbeResult>` — reads `channel.voice.livekit_api_key` / `_api_secret`; either missing → `no_keys`; `listRooms` resolves → `ok`; rejects with an error whose `status` is 401 or 403 → `rejected`; any other rejection → `unreachable`. Every rejection is logged at `debug` with `{ err, managementUrl }`.
  - `SetupCheckDeps.livekitProbe: () => Promise<LiveKitProbeResult>`.

- [ ] **Step 1: Write failing tests.**
  `livekit-probe.test.ts` (inject `listRooms`):
  - `no_keys when the secret is missing` → `getSecret` returns null for `_api_secret`; `listRooms` not called.
  - `ok when listRooms resolves`; the stub receives `livekitManagementUrl: 'http://livekit:7880'` and the vault key/secret.
  - `rejected on 401` → reject with `Object.assign(new Error('unauthorized'), { status: 401 })`.
  - `unreachable on a connection error` → reject with `Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })`.
  `checklist.test.ts` (add `livekitProbe: async () => 'ok'` to `deps()` defaults):
  - `voice reads LiveKit not running when the probe is unreachable, even with every channel running` → `voice` task pending, `detail` contains `LiveKit isn't running` and `docker compose up -d livekit`.
  - `voice reads rejected keys` → detail contains `rejected`.
  - `voice reads missing LiveKit keys` → probe `no_keys` → detail contains `LiveKit's keys`.
  - `voice probe applies to the Signal route too` → `voiceRoute: 'signal'`, probe `unreachable` → pending with the LiveKit detail.
  - `voice is restart_required when LiveKit answers and the channel is saved but not started` → probe `ok`, `channelStatus` voice → `restart_required` → `restart_required: true`.
  - `no route chosen → probe not called`.
- [ ] **Step 2:** `pnpm -C <worktree> exec vitest run tests/unit/setup/` → FAIL.
- [ ] **Step 3:** Implement. In `checkVoice`, after the route guard and before `channelResult`: map `no_keys` → "LiveKit's keys aren't saved. They come with Curia's install; re-run the installer or enter them under Settings → Channels → Voice."; `unreachable` → "LiveKit isn't running. On the server, run: docker compose up -d livekit"; `rejected` → "LiveKit rejected the saved keys. They must match LIVEKIT_KEYS in the install's .env." Wire in `index.ts`: `livekitProbe: () => probeLiveKit({ getSecret: (n) => secretsService.get(n), managementUrl: config.voiceLivekitManagementUrl, logger })`. Probe timeout: pass a 3 s `requestTimeout` (extend `listVoiceRooms` with an optional `requestTimeoutSec`, default 5).
- [ ] **Step 4:** Tests PASS; `pnpm -C <worktree> run typecheck` clean.
- [ ] **Step 5: Commit** `feat(setup): Voice check confirms LiveKit answers (#2357)`.

---

### Task 8: Voice runtime joins over the internal signaling URL

**Files:**
- Modify: `src/channels/voice/livekit/token.ts` (add `toLiveKitWsUrl`), `src/index.ts:2545-2554` (VoiceRuntime `livekitUrl`), `docs/adr/037-voice-channel-livekit-duplex.md` (dated note)
- Test: `tests/unit/channels/voice/livekit/token.test.ts` (create or extend)

**Interfaces:**
- Produces: `export function toLiveKitWsUrl(livekitManagementUrl: string): string` — `https:` → `wss:`, `http:` → `ws:`, `ws(s):` unchanged; the inverse of `toLiveKitHttpUrl`.

- [ ] **Step 1: Write failing tests:** `http://livekit:7880` → `ws://livekit:7880`; `https://lk.example.com` → `wss://lk.example.com`; `ws://x:1` unchanged; round-trip with `toLiveKitHttpUrl`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; in `index.ts` set `const voiceLivekitUrl = toLiveKitWsUrl(config.voiceLivekitManagementUrl);` with a comment that the browser URL (`config.voiceLivekitUrl`) stays on `VoiceAdapter` only. Leave `VoiceAdapter`'s `livekitUrl: config.voiceLivekitUrl` unchanged. ADR-037: a dated "2026-11 amendment" paragraph: server-side join uses the internal URL; browser URL is browser-only.
- [ ] **Step 4:** Tests PASS; `pnpm -C <worktree> exec vitest run tests/unit/channels/voice/` PASS; typecheck clean.
- [ ] **Step 5: Commit** `fix(voice): join rooms over the internal LiveKit URL (#2357)`.

---

### Task 9: Docs, changelog, end-to-end checks

**Files:**
- Modify: `docs/dev/voice-setup.md`
- Create: `changes/feat-2357-installer-https-voice.md`
- curia-docs (separate worktree `worktrees/curia-docs-2357-installer-https-voice`, separate PR): install page and voice page.

- [ ] **Step 1:** `docs/dev/voice-setup.md`: LiveKit on by default with generated keys; the `/rtc*` Caddy route (replace "shipped Caddyfile proxies only Curia"); base `wss://<domain>` URL; local settings from Task 0; how an upgraded install turns voice on (fetch the new `docker-compose.yml`, `deploy/Caddyfile`, `docker/livekit.yaml`; set `COMPOSE_PROFILES`, `LIVEKIT_KEYS`, `LIVEKIT_COMMAND`; enter the vault values). Keep `--dev` warnings.
- [ ] **Step 2:** Changelog fragment, each bullet ≤15 words after the em-dash:
  - Added: `**Installer voice** — fresh installs start LiveKit with generated keys and seed its vault values. (#2357)`
  - Changed: `**Installer topology** — HTTPS is the recommended default; proxy installs give their public address. (#2357)`
  - Changed: `**Setup Voice check** — reports LiveKit not running or rejecting keys instead of done. (#2357)`
  - Fixed: `**Voice calls** — Curia joins rooms over the internal LiveKit address, so local calls work. (#2357)`
  Run `pnpm -C <worktree> exec vitest run tests/unit/changelog-fragments.test.ts` → PASS.
- [ ] **Step 3:** Local end-to-end: a fresh `install.sh` run (`CURIA_REF=<pushed branch>` or the raw files copied into a scratch install dir, image `:edge` built from the branch if needed) choosing option 3 on a throwaway project name and port; confirm `.env` has the three LiveKit values, the vault has the three keys (`docker compose run --rm curia ... seed-vault` verify or a `psql` count, never printing values), `GET /api/setup/checklist` Voice detail is the restart/vendor-key message rather than "LiveKit isn't running", and `docker compose stop livekit` flips it to "LiveKit isn't running". A console call with two-way audio needs Deepgram and Cartesia keys: ask the maintainer before using real keys (billed).
- [ ] **Step 4:** Full checks: `pnpm -C <worktree> run typecheck`, `pnpm -C <worktree> run lint`, `pnpm -C <worktree> test:shell`, unit tests for touched dirs. Integration suite on a pristine DB (shared-DB flakiness is known).
- [ ] **Step 5:** curia-docs PR: install page (menu, proxy address question, closing message, ports) and voice page (comes with the install, base URL, upgrade steps).
- [ ] **Step 6: Commit** `docs: voice on by default in the installer (#2357)`.
- [ ] **Step 7:** Before the PR: review against `docs/dev/review-checklist.md`; run code review, silent-failure hunt and security review agents with `docs/dev/reviewing.md`. Open the PR with the `no-loop` label and `Closes #2357`; record the HTTPS manual check (production-shaped call over `wss://<domain>`, `/twirp/*` 404 from outside, Voice `restart_required` → done) on the issue when done, and flag the internal-URL join change for curia-deploy.
