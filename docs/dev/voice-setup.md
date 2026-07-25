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

The root `docker-compose.yml` includes an independent `livekit` service. Curia
does not `depends_on` it because the voice channel is toggleable; Postgres-only
deploys still boot normally.

```bash
docker compose up -d livekit
```

Default ports are:

| Purpose | Container | Host env override |
|---|---:|---|
| HTTP/WebSocket signaling | `7880/tcp` | `LIVEKIT_HTTP_PORT` |
| WebRTC TCP fallback | `7881/tcp` | `LIVEKIT_RTC_TCP_PORT` |
| WebRTC UDP media | `7882/udp` | `LIVEKIT_RTC_UDP_PORT` |

For local development the service runs `livekit-server --dev`, which uses known
credentials (`devkey` / `secret`). That is only acceptable on a private dev
machine. Production must use real keys and the same values must be stored in the
Curia vault.

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

`docker/livekit.yaml` sets `rtc.use_external_ip: true` and constrains UDP to
`7882` to match the default compose port. If you widen the UDP range, update
both the config and firewall.

## Public IP, ICE, and TLS

- Open `7880/tcp`, `7881/tcp`, and `7882/udp` on the host firewall.
- Forward those ports through NAT if Curia is behind a router.
- Keep `rtc.use_external_ip: true` for a simple public-VPS deploy.
- The optional `docker-compose.tls.yml` Caddy overlay terminates HTTPS for Curia
  on ports 80/443. It does not proxy LiveKit RTC ports.
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

Then install/enable the Voice channel and restart Curia. The runtime reads the
vault values on startup; changing a key does not affect already-running calls.

## Console Call button

After restart, open the console chat. The Call button appears when the Voice
channel is enabled and the session API can mint LiveKit tokens. Click **Call**,
allow microphone access in the browser, speak naturally, and use mute or hang up
from the active call bar.

Final user transcripts publish as normal `inbound.message` turns for memory and
audit. Assistant speech is streamed by `VoiceRuntime` through LiveKit rather than
sent through `OutboundGateway`.

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
