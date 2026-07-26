# Voice channel setup (LiveKit console calls)

Duplex spoken conversation from the Curia web console. Phase 1 uses a
self-hosted LiveKit server for WebRTC transport, Deepgram for STT, and Cartesia
for TTS. Signal calling and PSTN/SIP are Phase 2.

## Prerequisites

- A Curia host reachable from the browser running the console.
- LiveKit server, either the bundled Docker Compose service or your own deploy.
- Deepgram account and API key.
- Cartesia account and API key.
- Host firewall/NAT access for LiveKit signaling and RTC ports.

## Start LiveKit with Docker Compose

The root `docker-compose.yml` includes an independent `livekit` service behind
the Compose `voice` profile so plain `docker compose up` never starts it.
Curia does not `depends_on` it because the voice channel is toggleable;
Postgres-only deploys still boot normally.

```bash
docker compose --profile voice up -d livekit
```

Default ports are:

| Purpose | Container | Host env override |
|---|---:|---|
| HTTP/WebSocket signaling | `7880/tcp` | `LIVEKIT_HTTP_PORT` |
| WebRTC TCP fallback | `7881/tcp` | `LIVEKIT_RTC_TCP_PORT` |
| WebRTC UDP media | `7882/udp` | `LIVEKIT_RTC_UDP_PORT` |

For local development the profiled service runs `livekit-server --dev`, which
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

- Open `7880/tcp`, `7881/tcp`, and `7882/udp` on the host firewall.
- Forward those ports through NAT if Curia is behind a router.
- Keep `rtc.use_external_ip: true` for a simple public-VPS deploy.
- The optional `docker-compose.tls.yml` Caddy overlay terminates HTTPS for Curia
  on ports 80/443. It proxies only Curia — not LiveKit. Caddy can terminate
  HTTPS/WSS for signaling on `7880` via a separate proxy; `7881/tcp` (TCP
  fallback) and `7882/udp` (media) still need direct firewall/NAT exposure.
- Set the Voice channel LiveKit URL to the browser-reachable signaling endpoint:
  `ws://<host>:7880` for private local testing, or `wss://<voice-host>` when you
  terminate TLS for LiveKit through a separate proxy.

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

- `voice.ttfa_ms` — end of user turn to first assistant audio frame.
- `voice.stt_final_ms` — STT final transcript latency.
- `voice.llm_ttft_ms` — LLM time to first text delta.
- `voice.tts_first_byte_ms` — TTS time to first audio frame.
- `voice.barge_in_stop_ms` — time to stop assistant audio after barge-in.

Use these fields to compare models, regions, and provider accounts before
changing `channels.voice.model`.

## Troubleshooting WebRTC

- **Call button missing:** confirm Voice is installed/enabled in Settings →
  Channels and Curia was restarted after saving vault keys.
- **Token/session creation fails:** verify `channel.voice.livekit_url`,
  `channel.voice.livekit_api_key`, and `channel.voice.livekit_api_secret` match
  the LiveKit server exactly. `--dev` expects `devkey` / `secret`.
- **Browser connects but no audio:** check UDP `7882` first, then TCP `7881`.
  Cloud firewalls often allow TCP while silently dropping UDP.
- **Works on localhost, fails remotely:** use `rtc.use_external_ip: true`, set a
  browser-reachable LiveKit URL, and confirm NAT forwards the RTC ports.
- **HTTPS console blocks mic or WebSocket:** browsers require secure origins for
  microphone access. Use HTTPS for Curia, and use `wss://` for LiveKit on public
  hosts.
- **High `voice.ttfa_ms`:** inspect `voice.llm_ttft_ms` versus
  `voice.tts_first_byte_ms`; change the voice model only if LLM latency dominates.
