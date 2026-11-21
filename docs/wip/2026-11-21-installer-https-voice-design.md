# Installer: HTTPS-first topology and voice on by default — design

Issue: #2357 (absorbs #2689). Parent design: `docs/wip/2026-10-29-onboarding-journey-design.md` §1a.
Status: approved approach (A); this document for review.

## Intent

A new operator runs `install.sh`, answers the same few questions as today, and lands on the
console's Setup page with an install that **can** finish every Setup step, Voice included. Today
two things stop that:

- HTTPS is not steered towards, but the Curia phone app (PWA, ADR-055) installs only over trusted
  HTTPS, so the Setup page's Messaging and Voice "Curia app" routes need it.
- LiveKit never starts on a vanilla install, nothing writes its keys to the vault, and the Setup
  Voice step ("LiveKit comes with Curia") therefore can never be completed, so Start onboarding
  stays locked.

The installer stays short. Everything an operator chooses (speech vendor keys, voice, routes) is
done in the browser on the Setup page (#2358).

## Goals

1. The topology menu recommends HTTPS, explains the choices in plain words, and makes "already
   run my own HTTPS" distinct from "HTTPS set up for me".
2. A fresh install starts LiveKit with generated credentials (never `devkey`/`secret`) and keeps
   it on for later `docker compose` commands in the install dir.
3. A fresh install's vault holds `channel.voice.livekit_url`, `channel.voice.livekit_api_key` and
   `channel.voice.livekit_api_secret`, matching the running LiveKit and the browser-facing URL.
4. HTTPS installs carry call signaling through Caddy's `/rtc*` route (the browser is given
   `wss://<domain>` and the client adds `/rtc`); LiveKit's `/twirp` management API stays internal.
5. Calls have two-way audio on every topology, local included.
6. The Setup Voice check goes green only when LiveKit actually answers.
7. The installer ends on the Setup page, the curia-docs Setup pages, and the ports to open.

## Non-goals

- No prompts for Deepgram, Cartesia or the voice choice. They stay in the Setup Voice step.
- No change to production (curia-deploy runs its own compose, Caddyfile and `livekit.yaml`; it is
  the reference, not a target).
- No automatic voice enablement on upgraded installs (see *Upgrades*).
- No LAN-only topology (reachable from other machines on a home network without a domain).
- Local speech (#2470) is out of scope; when it ships the vendor keys become optional in Setup.

## Anti-goals (would be a failure even if it technically works)

- Any path that exposes `--dev` credentials, or exposes LiveKit's `/twirp` API publicly.
- Overwriting LiveKit values already in the vault, or rotating an existing install's LiveKit keys.
- Breaking developer checkouts or hand-run compose stacks that rely on today's `--dev` fallback.
- A Voice check that reads done while nothing answers on LiveKit.
- Turning LiveKit on, on an upgraded install, without telling the operator.

## Constraints (from the code today)

- `fetch_bundle` (`install.sh`) never replaces an existing `docker-compose.yml`, Caddyfile or
  `.env.example`. Upgraded installs keep their old files: no `/rtc` route, no config mount.
- `seedVault` (`scripts/seed-vault.ts`) is an unconditional upsert. "Never overwrite" needs a
  new write-if-absent path.
- `docker/livekit.yaml` sets `rtc.use_external_ip: true`. On a laptop that advertises the home
  network's public IP and calls get no audio; local runs need the node IP pinned to `127.0.0.1`.
- LiveKit signaling (7880) is published on loopback by default since #2408; the existing
  exposure checks (`check_livekit_exposure`, `warn_public_livekit_dev`) stay and keep working.
- The curia container has `env_file: .env`, so it sees whatever `.env` holds. `seed-vault` runs
  in that container on both install paths.
- `scripts/setup.sh` (source checkout) has no topology question: it is always localhost.
- The Setup Voice step has no LiveKit URL field (`ChannelSteps.tsx`, `VOICE_FIELDS`), so the
  install must seed the URL for the step to be completable.
- Management calls (`listVoiceRooms`, `deleteVoiceRoom`) use `config.voiceLivekitManagementUrl`
  (default `http://livekit:7880`, overridable by `channels.voice.livekit_management_url`), never
  the browser URL.

## Approaches considered

**A. Installer writes the real LiveKit settings into `.env`; compose fallback unchanged. (Chosen.)**
The installer generates `LIVEKIT_KEYS` and sets `LIVEKIT_COMMAND="--config /etc/livekit.yaml"`
(plus `--node-ip 127.0.0.1` on local). `docker/livekit.yaml` ships in the install bundle, keyless
like production's; compose mounts it and passes `LIVEKIT_KEYS` through. Developer checkouts and
existing installs are untouched, an operator's own `LIVEKIT_COMMAND` is respected by not
overwriting it, and it mirrors production. Cost: someone running compose without the installer
still gets `--dev`, which stays loopback-only and is already warned about if it becomes public.

**B. Make the real config the compose fallback (drop `--dev`).** Safe by default however the stack
starts, but LiveKit refuses to start without keys, breaking every developer checkout and hand-run
stack. A breaking change the issue does not need. Rejected.

**C. Flags only, no config file.** One file fewer in the bundle, but room timeouts and RTC settings
crammed into an unreadable `.env` line, drifting from production's `livekit.yaml`. Rejected.

## Decided with the maintainer

### Topology menu (install.sh)

Reworded and reordered so HTTPS is the default. The distinguishing question is "does something
else already handle HTTPS here?":

```
How will people reach Curia?
  1  My domain, with HTTPS set up for me   (recommended)
     Curia gets its own certificate. Needs a domain pointing at this
     server and ports 80 and 443 open.
  2  My domain, behind HTTPS I already run
     For servers that already have nginx, Traefik, Cloudflare Tunnel or
     similar in front. Curia listens on port 3000 behind it.
  3  Just this computer, to try it out
     No phone app; onboarding then needs Signal or SMS.
Not sure? Choose 1.
Choice [1]:
```

Internal topology names stay `domain` / `proxy` / `local`; only the menu text and numbering change.

**Port guard on option 1:** when something already listens on port 80 or 443, warn and suggest
option 2 (a certificate failure is otherwise the first sign). A warning, not a new question.

### The proxy address question (option 2 only)

Option 2 asks one new question. This deliberately relaxes the issue's "asks nothing new" for
proxy installs only (domain already asks for the domain; local is always localhost):

```
Public address your proxy serves Curia on (e.g. https://curia.example.com).
Press Enter to keep localhost for testing:
```

- **An address** (`https://host[:port]`): seeds `livekit_url` as `wss://host[:port]` and sets
  `APP_ORIGIN` to the address. The closing message lists what the proxy must forward (`/` to
  3000, `/rtc*` to 7880) and the RTC ports to open.
- **`http://…`** is accepted with a warning that the phone app needs https; `livekit_url` is then
  `ws://host[:port]`.
- **Enter:** seeds `ws://localhost:7880`, leaves `APP_ORIGIN` unset, and says it is for testing.
- **Invalid** (no scheme, spaces, a path, a trailing junk) re-asks, like the domain prompt.

Filling `APP_ORIGIN` here is a deliberate extra: proxy installs never got one, which left session
cookies non-Secure and the Setup page's phone-app route blocked with "Set APP_ORIGIN…".

### Browser-facing LiveKit URL per topology

| Topology | `channel.voice.livekit_url` | `APP_ORIGIN` |
|---|---|---|
| 1 domain | `wss://<domain>` | `https://<domain>` (as today) |
| 2 proxy, address given | `wss://<host>` (`ws://` for http) | the address |
| 2 proxy, Enter | `ws://localhost:7880` | unset |
| 3 local | `ws://localhost:7880` | unset (as today) |
| `scripts/setup.sh` | `ws://localhost:7880` | unchanged |

The seeded URL is the **base** address, never with `/rtc`: `livekit-client` (2.23,
`createRtcUrl`) appends `/rtc` (and `/v1`) itself, so `wss://<domain>/rtc` would request
`/rtc/rtc/v1` and 404. `/rtc` appears only in the Caddy route and the proxy forwarding rules.
Production follows the same rule (curia-deploy `runbooks/voice-livekit-bootstrap.md`).

### LiveKit on by default, with generated keys (approach A)

On a fresh install (and `setup.sh`'s full path) the installer writes to `.env`:

- `COMPOSE_PROFILES=voice`, so `up -d` and every later `docker compose` command include LiveKit.
- `LIVEKIT_KEYS="<key>: <secret>"`, generated with the existing `/dev/urandom` helpers. Key: an
  `API`-prefixed alphanumeric id; secret: at least 32 characters (LiveKit's minimum).
- `LIVEKIT_COMMAND="--config /etc/livekit.yaml"`, plus `--node-ip 127.0.0.1` for local, proxy-Enter
  and `setup.sh`.

`docker-compose.yml`'s `livekit` service gains the `./docker/livekit.yaml:/etc/livekit.yaml:ro`
mount and `LIVEKIT_KEYS: ${LIVEKIT_KEYS:-}`; its `command:` fallback stays `--dev --bind 0.0.0.0`
and its profile stays `voice`. `docker/livekit.yaml` drops its placeholder `keys:` block (keys come
from `LIVEKIT_KEYS`, as in production) and keeps ports, `use_external_ip`, room timeouts.

**Respecting the operator's own setup.** If `LIVEKIT_COMMAND` or `LIVEKIT_KEYS` is already set
(shell or `.env`) before a fresh install, it is not overwritten. The seeded key pair must match
what LiveKit will actually run:

1. `LIVEKIT_KEYS` set → seed from it.
2. else `LIVEKIT_COMMAND` contains `--keys "<k>: <s>"` → seed from that.
3. else `LIVEKIT_COMMAND` contains `--dev` → seed `devkey`/`secret` (the operator chose it;
   the existing `--dev` exposure warnings still apply).
4. else (a custom `--config` with keys inside a file the installer can't read) → seed the URL
   only, and say the keys must be entered under Settings → Channels → Voice.

**Interrupted fresh install** (no `SETUP_COMPLETE` marker): `LIVEKIT_KEYS` already in `.env` from
the earlier run is reused, never regenerated, for the same reason `DB_PASSWORD` is.

### Seeding the vault without overwriting

`seed-vault.ts` gains a write-if-absent group for the three LiveKit names, read from transient env
vars the installer passes to the seed container (as it does for `API_TOKEN` today). Absent from
the vault → written; present → left alone and logged as kept. The existing upsert behaviour of
every other name is unchanged. Names of the env vars are the builder's call; they must not collide
with anything the curia container reads at runtime.

### Curia's own end of a call joins over the internal network

A call has two participants that join LiveKit: the caller's browser, and Curia's voice runtime
(`VoiceRuntime` → `LiveKitRoomSession`, `src/channels/voice/livekit/room-session.ts`). Today both
use `channel.voice.livekit_url`. That works where both can reach the public address (production),
but on local, proxy-Enter and `setup.sh` installs Curia runs in a container, where
`ws://localhost:7880` is the container itself, so Curia's end never joins. Decided: **local calls
must work, with audio.**

- **Signaling.** The server-side join uses an internal signaling URL derived from the existing
  `config.voiceLivekitManagementUrl` (default `http://livekit:7880` → `ws://livekit:7880`), the
  same address the room-management calls already use. `livekit_url` stays browser-only. This
  applies to every topology, production included (it removes the round trip through Caddy); it
  amends ADR-037's "management vs browser URL" split, so ADR-037 gets a note.
- **Media.** LiveKit has to advertise an address the host browser **and** the curia container can
  both reach. `--node-ip 127.0.0.1` alone serves the browser but not the container. This is the
  one unknown, so the plan **starts with a throwaway spike** on a local Docker install that finds
  a LiveKit configuration giving both ends audio (candidates: interface candidates alongside the
  node IP, `rtc.ips` includes, the TCP fallback, `host.docker.internal`). The chosen settings go
  in the local `LIVEKIT_COMMAND` / `livekit.yaml`. If no configuration works, stop and bring it
  back to the maintainer before building further; do not ship local voice that connects silently.
- **Production check.** Because the server-side join changes for production too, the manual test
  includes a production-shaped (HTTPS) call, and the PR notes the change for curia-deploy.

### Call signaling over HTTPS (shipped Caddyfile)

`deploy/Caddyfile` adds, ahead of the catch-all, a `handle /rtc*` block to `livekit:7880`; the
catch-all becomes `handle { reverse_proxy curia:3000 }`. `/twirp/*` therefore reaches Curia (404),
never LiveKit. Matches production's Caddyfile. The comments in `docker-compose.tls.yml` and
`docker-compose.yml` that say Caddy does not proxy LiveKit are updated.

### Voice check proves LiveKit is reachable

`checkVoice` (`src/setup/checklist.ts`) gets a LiveKit probe dependency, wired in `src/index.ts`
from the vault's LiveKit key and secret plus `config.voiceLivekitManagementUrl`, calling
`listVoiceRooms`. It does not depend on the voice adapter existing, so it works before the
restart. Order, once a route is chosen (both the app and Signal routes):

1. LiveKit keys missing from the vault → pending: "LiveKit's keys aren't saved…" (Setup already
   says this in its incomplete note; the check should agree).
2. Probe fails to connect → pending: "LiveKit isn't running." with a fix hint
   (`docker compose up -d livekit` in the install dir).
3. Probe rejected (401/403) → pending: "LiveKit rejected the saved keys" (they don't match
   `LIVEKIT_KEYS`).
4. Otherwise the existing channel-status logic (`restart_required` / running / Signal checks).

A probe failure is a check result, not a thrown error, so it doesn't fall into `guarded`'s generic
"Could not check this right now".

### Upgrades

The existing-install path changes nothing about LiveKit: no `COMPOSE_PROFILES`, no keys, no
seeding, no new files. When LiveKit is not running, it prints a short note that voice is off on
this install and links the docs section on turning it on (which covers the newer compose file,
Caddyfile route and `livekit.yaml`). Installs already running voice are left exactly as they are.

### Closing message

Both installers end with: the Setup page URL (`<url>/setup`), the curia-docs Setup link, "finish
Setup in the browser, then Start onboarding", and, for options 1 and 2, the RTC ports to open
(7881/tcp, 7882/udp). Option 2 also lists the proxy forwarding rules. The bootstrap-secret box
stays.

### `scripts/setup.sh`

No topology question (it is always localhost, and adding one would be a new question). Full path:
writes `COMPOSE_PROFILES`, `LIVEKIT_KEYS`, `LIVEKIT_COMMAND` (with `--node-ip 127.0.0.1`), seeds
`ws://localhost:7880` and the keys if absent, same closing message. Resume and "start the stack"
paths: unchanged. **Full reset** (option 3) carries `LIVEKIT_KEYS` over from the old `.env`, as it
already does `SECRET_ENCRYPTION_KEY`: the vault survives the reset, and write-if-absent seeding
would otherwise keep the old pair while LiveKit runs a new one (builder's-call settled in review). An existing developer `.env` without these values keeps `--dev` as today.

### Release bundle

`release.yml` adds `docker/livekit.yaml` as flat asset `livekit.yaml` to the bundle, the
checksums and the verification step. `fetch_bundle` fetches it when the compose file mounts it,
the same pattern as `seccomp-chrome.json`. A pinned older `CURIA_VERSION` without it is unaffected.

### Docs

- `docs/dev/voice-setup.md`: LiveKit on by default, generated keys, the `/rtc` route, local
  node IP, how an upgraded install turns voice on.
- `.env.example`: the new LiveKit values and `COMPOSE_PROFILES`.
- curia-docs install and voice pages (separate PR in curia-docs): the new menu, the proxy question,
  the closing message, ports.
- Changelog fragment `changes/feat-2357-installer-https-voice.md`.
- Issue #2357's text is updated to record the proxy question and `APP_ORIGIN`.

## Tests

- **Shell (`pnpm test:shell`, `tests/setup/test-setup-functions.sh`):** pure helpers for key
  generation (format, length), parsing `LIVEKIT_KEYS` and `--keys`/`--dev` out of a command, the
  proxy-address validator, origin → LiveKit URL mapping per topology, the profile/keys/command
  defaults written to `.env`, operator values not overwritten, interrupted-install key reuse.
- **Unit (vitest):** seed-vault write-if-absent (absent → written, present → kept, other names
  still upsert); `checkVoice` probe states (keys missing, unreachable, rejected, ok → falls
  through to `restart_required`/done).
- **Unit (vitest):** the server-side join uses the internal signaling URL, not `livekit_url`.
- **Manual (spike, then again at the end):** a fresh local install where a console call has
  two-way audio.
- **Manual (recorded on the issue):** a fresh HTTPS install where a console call connects over
  `wss://<domain>/rtc`, `/twirp/*` is not reachable from outside, and the Voice task reads
  `restart_required` before Apply & restart and done after it.

## Left to the builder

- Env var names for the transient seed values; exact helper names and file layout in the scripts.
- How the port-80/443 guard detects a listener (bash `/dev/tcp`, or `docker`-free equivalent).
- Probe timeout and whether to cache its result briefly so Setup page polling stays fast.
- Exact wording of hints and notes, within the shapes above.
- Whether `--node-ip` overrides `use_external_ip` in the LiveKit version shipped; verify, and pin
  the node IP another way if not (folds into the local-media spike).
- The exact local LiveKit settings, from the spike.

## Calls made by the designer (not discussed with the maintainer)

- Upgrades leave LiveKit untouched and only print a note (the issue allowed either, if said).
- The 80/443 port guard is a warning, never a question.
- `setup.sh` gets no topology question; full reset keeps `LIVEKIT_KEYS`.
- An operator's `--config` with keys inside a file → seed the URL only and say so.
- A rejected-keys state in the Voice check, separate from "not running".
- Seeded URL is the base address (no `/rtc`), matching the client library and production.

## Spike result (local call audio, 2026-11-21)

Run on macOS Docker Desktop 29.9 (x86_64), `livekit/livekit-server:v1.13.4`. Two clients joined
one room and each checked it received the other's audio: Chromium on the host (`livekit-client`
2.23 → `ws://localhost:7880`) and `@livekit/rtc-node` 1.2.1 in a compose container
(→ `ws://livekit:7880`).

| LiveKit config | node IP advertised | Browser hears container | Container hears browser |
|---|---|---|---|
| shipped `livekit.yaml` (`use_external_ip: true`) + `--node-ip 127.0.0.1` | home public IP (`--node-ip` ignored) | no (pc connection failed) | no |
| `use_external_ip: false`, no node IP | container IP 172.18.x | no | no |
| **`use_external_ip: false` + `--node-ip 127.0.0.1`** | 127.0.0.1 | **yes** | **yes** |

Findings that change the plan:

- `--node-ip` does **not** override `use_external_ip: true`; LiveKit still advertises the STUN
  address. Local installs therefore need a config file with `use_external_ip: false`.
- Decision: ship a second file, `docker/livekit.local.yaml` (identical to `livekit.yaml` but
  `use_external_ip: false`), mounted at `/etc/livekit.local.yaml`. Local `LIVEKIT_COMMAND` is
  `--config /etc/livekit.local.yaml --node-ip 127.0.0.1`; public stays
  `--config /etc/livekit.yaml`. Both files ship in the bundle.
- The container reached media although LiveKit advertised 127.0.0.1, most likely through a
  peer-reflexive pair from LiveKit's own checks to the container's address. Linux Docker was not
  tested; the mechanism does not depend on Docker Desktop, but treat Linux as unverified.
- Chromium needs the page on a secure origin (`http://localhost` counts) for the microphone; the
  console already is one.
