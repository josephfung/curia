# Voice channel setup (LiveKit console calls)

Duplex spoken conversation from the Curia web console and Signal calls.
Phase 1 uses a self-hosted LiveKit server for WebRTC transport, Deepgram for
STT, and Cartesia for TTS. Signal calling is now available (experimental).
PSTN/SIP are Phase 2.

## Prerequisites

- A Curia host reachable from the browser running the console.
- LiveKit server, either the bundled Docker Compose service or your own deploy.
- Deepgram account and API key.
- Cartesia account and API key.
- Host firewall/NAT access for LiveKit's RTC ports (and for signaling only if
  you publish it directly with `LIVEKIT_HTTP_BIND`).

## Fresh installs: LiveKit is on by default

A fresh `install.sh` run starts LiveKit for you. It generates a LiveKit key and
secret, writes `COMPOSE_PROFILES`, `LIVEKIT_KEYS` and `LIVEKIT_COMMAND` to `.env`,
and seeds the vault with `channel.voice.livekit_url`, `channel.voice.livekit_api_key`
and `channel.voice.livekit_api_secret`. You only add the Deepgram key, the Cartesia
key and a Cartesia voice id (see "Vault keys and channel enablement"). Setup's
Voice check reports "LiveKit isn't running" or a rejected key rather than done.

What the installer sets depends on the topology you pick:

| Install | `LIVEKIT_COMMAND` | Seeded `channel.voice.livekit_url` |
|---|---|---|
| Domain (HTTPS) | `--config /etc/livekit.yaml` | `wss://<domain>` |
| Behind your own proxy, with a public address | `--config /etc/livekit.yaml` | `wss://<host>` |
| Local | `--config /etc/livekit.local.yaml --node-ip 127.0.0.1` | `ws://localhost:7880` |

The seeded URL is a base address: the LiveKit client adds `/rtc` itself, so do not
append it. Local installs use `docker/livekit.local.yaml`, which sets
`use_external_ip: false`, because `--node-ip` alone does not override
`use_external_ip: true` in the public config.

On a domain install, or a proxy install that gave a public address, the installer
refuses to continue if `LIVEKIT_COMMAND` is `--dev`: the Caddy `/rtc*` route would
publish the `devkey` / `secret` credentials.

The HTTPS overlay (`docker-compose.tls.yml`) also fails closed for stacks started
by hand: with `LIVEKIT_COMMAND` unset or empty, LiveKit runs the keyless
`--config /etc/livekit.yaml` instead of the base file's `--dev` fallback, so it
refuses to start until `LIVEKIT_KEYS` holds real keys. Only the base
`docker-compose.yml` (developer checkouts, installs without the overlay) keeps
the `--dev` fallback.

Curia's own end of a call does not use that public URL. It joins over
`ws://livekit:7880`, derived from `channels.voice.livekit_management_url` (default
`http://livekit:7880`), so local calls work and traffic stays on the compose network.

## Turn voice on for an existing install

Upgrades leave LiveKit alone. When voice is off, `install.sh` prints a note
pointing here. To turn it on for an install you already have:

1. Fetch the current `docker-compose.yml`, `deploy/Caddyfile`,
   `docker/livekit.yaml` and `docker/livekit.local.yaml` from the release you run
   (release assets `docker-compose.yml`, `Caddyfile`, `livekit.yaml` and
   `livekit.local.yaml`). The Caddyfile adds the `/rtc*` route; skip it if you
   terminate TLS elsewhere. Fetch both LiveKit files even on a public install: the
   compose file mounts both, and a missing one makes Docker create an empty
   directory in its place.
2. Generate a key and secret. The key is `API` plus 12 letters or digits, the
   secret 32 random bytes in hex:

   ```bash
   echo "API$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 12)"
   openssl rand -hex 32
   ```

   Then set in `.env`:

   ```bash
   COMPOSE_PROFILES=voice
   LIVEKIT_KEYS="<api-key>: <api-secret>"
   # Domain or public proxy install:
   LIVEKIT_COMMAND="--config /etc/livekit.yaml"
   # Local install (only this machine reaches Curia) instead:
   # LIVEKIT_COMMAND="--config /etc/livekit.local.yaml --node-ip 127.0.0.1"
   ```

   `LIVEKIT_KEYS` must hold the same pair you enter in the vault. Never use `--dev`
   here (see below).
3. Start it: `docker compose up -d`.
4. In **Settings → Channels → Voice**, enter `channel.voice.livekit_url`
   (`wss://<your-domain>`, or `ws://localhost:7880` on a local install),
   `channel.voice.livekit_api_key`, `channel.voice.livekit_api_secret`, plus the
   Deepgram and Cartesia values, then restart Curia.
5. On a domain or public proxy install, open `7881/tcp` and `7882/udp` on the host
   firewall.

## Start LiveKit with Docker Compose

The root `docker-compose.yml` includes an independent `livekit` service behind
the Compose `voice` profile so plain `docker compose up` never starts it unless
`COMPOSE_PROFILES` includes `voice` (fresh installs set it).
Curia does not `depends_on` it because the voice channel is toggleable;
Postgres-only deploys still boot normally.

```bash
docker compose --profile voice up -d livekit
```

Default ports are:

| Purpose | Container | Host env override | Published on |
|---|---:|---|---|
| HTTP/WebSocket signaling | `7880/tcp` | `LIVEKIT_HTTP_PORT` | `127.0.0.1` (`LIVEKIT_HTTP_BIND` to change) |
| WebRTC TCP fallback | `7881/tcp` | `LIVEKIT_RTC_TCP_PORT` | every interface |
| WebRTC UDP media | `7882/udp` | `LIVEKIT_RTC_UDP_PORT` | every interface |

Signaling has been loopback-only by default since #2408, so `--dev` credentials
are not reachable from outside the host by default. A browser on the same machine
uses `ws://localhost:7880`. Before serving browsers elsewhere, replace `--dev` with
a real config and keys (see the config-file deploy paragraph below): a proxy in
front of `127.0.0.1:7880` exposes `--dev` just as a public bind does. Then either
front `127.0.0.1:7880` with a TLS proxy on the host, or set
`LIVEKIT_HTTP_BIND=0.0.0.0` (IPv4) or `::` (IPv4 + IPv6) in `.env`.

Existing voice installs pick the change up only when LiveKit is recreated:
`install.sh` runs `docker compose up -d` without the voice profile (unless
`COMPOSE_PROFILES=voice` is set), which leaves a running `livekit` on its old
bindings. After updating the compose file, decide first: if browsers connect to
`ws://<host>:7880` directly, set `LIVEKIT_HTTP_BIND` or add a TLS proxy. Then
recreate it:

```bash
docker compose --profile voice up -d livekit
```

`install.sh` warns on re-run while signaling is still published beyond
loopback, and again once it is loopback-only. Set `LIVEKIT_HTTP_BIND=127.0.0.1`
to silence the second note once a proxy is in place; it does not silence the
first, which keeps firing until the container is actually recreated on
loopback. With a public `LIVEKIT_HTTP_BIND`, `install.sh` warns while the
running container is still on loopback (not yet recreated). On every run, fresh
or upgrade, it warns when signaling is public and the running container uses the
`--dev` credentials. It reads the container's own command, not `.env`.

For local development (no TLS overlay) the profiled service runs `livekit-server --dev`, which
uses known credentials (`devkey` / `secret`). **Never expose `--dev` on a
public interface** — anyone who can reach the ports can mint LiveKit JWTs with
those credentials without Curia auth. Production must set `LIVEKIT_COMMAND` to
a real config (via `docker/livekit.yaml`) and store the same keys in the Curia
vault.

For a config-file deploy, copy `docker/livekit.yaml`, replace the placeholder
key/secret, and add a local compose override:

```yaml
services:
  livekit:
    volumes:
      - ./docker/livekit.yaml:/etc/livekit.yaml:ro
```

Then set:

```bash
LIVEKIT_COMMAND="--config /etc/livekit.yaml"
```

`docker/livekit.yaml` sets `rtc.use_external_ip: true`, uses `rtc.udp_port: 7882`
(single-port mux — fine for one concurrent console call; widen before expecting
multiple simultaneous rooms), and sets `room.empty_timeout: 30` so abandoned
rooms tear down promptly. Room timeouts / delete are cleanup only — they do not
revoke JWTs; a leaked token remains valid until its TTL.

## Signal calls (experimental)

Curia can accept inbound voice calls via Signal. The feature is off by default
and requires Signal-specific deploy infrastructure from curia-deploy.

### Configuration

Enable Signal voice calls and set call duration limits with these environment variables:

- `SIGNAL_VOICE_CALLS_ENABLED` — enable/disable Signal calling (default `false`).
- `SIGNAL_PULSE_SOCKET_PATH` — path to the PulseAudio socket shared from the signal-cli container.
- `SIGNAL_VOICE_MAX_CALL_SECONDS` — hard per-call duration cap in seconds (default `600`).

### Policy

Curia answers inbound Signal calls from callers with a stable phone number.
Contact resolution determines whether the caller is framed as the principal or a
non-principal contact; blocked contacts and callers with no phone number
(uuid-only, rejected as `no_identifier`) are declined. All calls enforce a hard
per-call duration cap; no wrap-up message is spoken when the limit is reached.

### Deploy prerequisites

Signal calling requires infrastructure that lands via curia-deploy (separate
repo/PR):

- signal-cli >= 0.14.7
- signal-call-tunnel binary
- PulseAudio running inside the signal-cli container with its socket shared to Curia

Ensure these are in place and the Pulse socket path is set in `SIGNAL_PULSE_SOCKET_PATH`
before enabling the feature via `SIGNAL_VOICE_CALLS_ENABLED`.

## Security & privacy notes

Canonical operator checklist. Decision rationale and residual risks live in
[ADR-037](../adr/037-voice-channel-livekit-duplex.md).

### HTTP auth / mint

| Route | Auth | Mints JWT? |
|---|---|---|
| `GET /api/voice/status` | None | No — `{ enabled }` only |
| `POST /api/voice/sessions` | `assertSecret` (console cookie / bootstrap header) | Yes |
| `DELETE /api/voice/sessions/:id` | `assertSecret` | No |

`/api/voice/*` is bearer-exempt so console session auth can run (same pattern as
`/api/kg`). **Anonymous mint is not possible.**

### LiveKit JWTs and `--dev`

- Grants: `roomJoin` + `canPublish` + `canSubscribe` for one room only (no admin).
- Explicit TTL: **1h** (not the SDK's 6h default).
- Room delete / empty timeouts tidy abandoned rooms; they do **not** revoke
  JWTs. A leaked token can still rejoin (and LiveKit may auto-create the room)
  until the TTL expires.
- Never run LiveKit `--dev` (public `devkey`/`secret`) on a reachable interface.

### Third-party privacy

Enabling voice means principal **audio and transcripts leave the host** to:

- Deepgram (streaming STT) — WebSocket subprotocol auth `['token', apiKey]`
- Cartesia (streaming TTS) — HTTPS bearer
- The deploy's LLM provider (streaming chat)

Speech-vendor keys never reach the browser. Treat vendor DPAs accordingly.
Channel trust is **high** (console session = principal), matching `web`. Spoken
TTS bypasses `OutboundGateway` (parity with web chat); tool calls still go
through `ExecutionLayer` and external sends still hit the gateway.

## Public IP, ICE, and TLS

- Open `7881/tcp` and `7882/udp` on the host firewall. Open `7880/tcp` too only
  if you publish signaling directly by setting `LIVEKIT_HTTP_BIND` (it is
  loopback-only by default; a TLS proxy on the host reaches `127.0.0.1:7880`).
- Forward those ports through NAT if Curia is behind a router.
- Keep `rtc.use_external_ip: true` for a simple public-VPS deploy.
- The `docker-compose.tls.yml` Caddy overlay terminates HTTPS for Curia on ports
  80/443. The shipped `deploy/Caddyfile` also routes `/rtc*` to LiveKit, so
  `wss://<domain>` reaches LiveKit signaling on the same host and certificate.
  Everything else, including `/twirp/*`, goes to Curia, so LiveKit's admin API is
  not reachable from outside. `7881/tcp` (TCP fallback) and `7882/udp` (media)
  still need direct firewall/NAT exposure. If you run your own proxy, route `/rtc*`
  to `127.0.0.1:7880` yourself.
- Set the Voice channel LiveKit URL to the browser-reachable signaling base
  address (no `/rtc`; the client adds it): `wss://<domain>` behind the shipped
  Caddyfile, `ws://localhost:7880` for local testing on the same machine, or
  `ws://<host>:7880` only with `LIVEKIT_HTTP_BIND` set (private networks, real
  keys).
- **Signaling vs management:** the vault `channel.voice.livekit_url` is for the
  **browser** (`wss://…` / `ws://…`). Curia's server-side RoomService calls
  (`DeleteRoom` on hangup, and any future admin ops) use a **separate** HTTP
  base from plain YAML — `channels.voice.livekit_management_url` — which must
  reach LiveKit directly on the compose network (default `http://livekit:7880`).
  Do not point management at the public signaling domain: if Caddy (or similar)
  only proxies `/rtc*` to LiveKit, `/twirp` RoomService calls hit Curia and 404
  (`Route POST:/twirp/.../DeleteRoom not found`). Host-side `pnpm dev` with
  published LiveKit ports should override management to `http://localhost:7880`
  in `config/local.yaml`.

## Vault keys and channel enablement

Enter these in **Settings → Channels → Voice**:

- `channel.voice.livekit_url`
- `channel.voice.livekit_api_key`
- `channel.voice.livekit_api_secret`
- `channel.voice.deepgram_api_key`
- `channel.voice.cartesia_api_key`
- `channel.voice.cartesia_voice_id` — the voice to speak in. Pick one from
  [play.cartesia.ai](https://play.cartesia.ai) and copy its voice id (a UUID).
  Required: Cartesia cannot synthesize a reply without it, so the channel stays
  disabled until it is set.

Then install/enable the Voice channel and restart Curia. The runtime reads the
vault values on startup; changing a key does not affect already-running calls.

## Console Call button

After restart, open the console chat. The Call button appears when the Voice
channel is enabled and the session API can mint LiveKit tokens. Click **Call**,
allow microphone access in the browser, speak naturally, and use mute or hang up
from the active call bar.

Final user and assistant transcripts are written to working memory so they can
appear in console chat history after the call. Spoken audio itself is streamed
by `VoiceRuntime` through LiveKit rather than `OutboundGateway` (same gateway
skip as principal web chat).

## Latency logs

Voice emits structured pino fields for latency debugging:

- `voice.ttfa_ms` — end of user turn to first assistant audio frame: what the caller
  hears. Logged at `info` as `voice time-to-first-audio`.
- `voice.stt_final_ms` — STT final transcript latency.
- `llm_ttft_ms` — turn start to first text delta, after any tool rounds before it. Logged
  at `info` as `voice llm first token`, with `model`, `turnKind` (`greeting` or `user`)
  and `round` (the round that produced the text). ADR-038's first-speech budget is on
  **`turnKind: user`, `round: 0` lines only**, the span its spike measured. Greetings
  send no tools and are reported apart. A `round` ≥ 1 line also times a tool and a later model call. Report it
  beside the gate, but it is not a reason to change the model. `voice.ttfa_ms` adds TTS
  and prompt assembly, which a model change does not move.
- `voice.tts_first_byte_ms` — TTS time to first audio frame.
- `voice.barge_in_stop_ms` — time to stop assistant audio after barge-in.
- `voice.barge_in_detect_ms` — for `trigger: speech_start`, speech onset to barge-in
  (Deepgram's onset event, backed by the caller's level). For `trigger: transcript`
  (an interim with words), the age of the first word's Deepgram start, not VAD onset;
  omitted when the transcript has no word timings. The two do not share an origin,
  so compare them only within one trigger. `flushed: true` means queued audio was
  dropped; Signal does it by restarting `pacat` (#2401). A `speech_start` barge-in
  with no words after it logs `voice barge-in on speech onset was not followed by
  speech` at `warn`: count those to tune `channels.voice.barge_in_speech_start_min_dbfs`.
- `voice.barge_in_caller_dbfs` — on a `speech_start` barge-in, the loudest caller frame
  since the onset. An onset that never reached the level while Curia was talking logs
  `voice speech onset below barge-in level; Curia kept talking` with
  `voice.speech_start_caller_dbfs`, which is how loud the echo or noise was.

Use these fields to compare models, regions, and provider accounts before
changing `channels.voice.model`.

## Troubleshooting WebRTC

- **Call button missing:** confirm Voice is installed/enabled in Settings →
  Channels and Curia was restarted after saving vault keys.
- **Token/session creation fails:** verify `channel.voice.livekit_url`,
  `channel.voice.livekit_api_key`, and `channel.voice.livekit_api_secret` match
  the LiveKit server exactly. `--dev` expects `devkey` / `secret`.
- **Hangup logs `DeleteRoom not found` (404):** management is still aimed at the
  public signaling URL. Set `channels.voice.livekit_management_url` to the
  internal LiveKit HTTP base (`http://livekit:7880` in compose;
  `http://localhost:7880` for host-side `pnpm dev`).
- **Browser connects but no audio:** check UDP `7882` first, then TCP `7881`.
  Cloud firewalls often allow TCP while silently dropping UDP.
- **Works on localhost, fails remotely:** use `rtc.use_external_ip: true`, set a
  browser-reachable LiveKit URL, and confirm NAT forwards the RTC ports.
- **HTTPS console blocks mic or WebSocket:** browsers require secure origins for
  microphone access. Use HTTPS for Curia, and use `wss://` for LiveKit on public
  hosts.
- **High `voice.ttfa_ms`:** inspect `voice.llm_ttft_ms` versus
  `voice.tts_first_byte_ms`; change the voice model only if LLM latency dominates.
