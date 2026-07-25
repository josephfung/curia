# ADR-037: Duplex voice via self-hosted LiveKit cascade (console WebRTC)

Date: 2026-07-25
Status: Accepted

## Context

Curia’s channels are turn-based text: `inbound.message` → full LLM reply →
`outbound.message`. Natural spoken conversation needs a streaming cascade with
barge-in (`mic → VAD/STT → streaming LLM (+ tools) → streaming TTS → speaker`).
Signal RingRTC calling exists but is ops-heavy and young; HTTP chat is SSE of
complete replies; `LLMProvider.chat()` is non-streaming. Spec 04 already notes
a future streaming concept; overview listed voice/telephony as out of launch
scope.

Goals for Phase 1 (#1414): principal duplex calls from the **web console**,
Curia remains the brain (skills / memory / autonomy / outbound safety), media
stays off the bus, works on Anthropic **and** OpenRouter-routed deploys, and
leaves a clean path for Phase 2 Signal/PSTN on the same runtime.

Alternatives considered and rejected as the Phase 1 primary path:

- **Push-to-talk / Signal voice-notes** — reuses the text path but throws away
  duplex VAD / barge-in / streaming work.
- **Speech-to-speech (OpenAI Realtime / Gemini Live)** — would orphan Curia’s
  skills, memory, autonomy, and audit as the brain; keep only as a future
  latency escape hatch if cascade + tools miss budget.
- **LiveKit Cloud / Twilio / Vapi** — extra vendors and cost; Curia is
  self-hosted on a VPS next to Postgres.
- **Anthropic-only streaming** — production may route DeepSeek via OpenRouter
  (ADR-014); voice must not hardcode Anthropic.

SMS (#1478 / ADR-036) established the HTTP webhook-bridge pattern for
toggleable channels that share `HttpAdapter`’s always-on Fastify surface —
voice reuses that for session minting (and optional LiveKit webhooks).

## Decision

1. **Transport:** self-hosted **LiveKit** (Docker Compose alongside Curia).
   Console joins via WebRTC; Curia’s `VoiceRuntime` joins the same room as a
   server participant. No LiveKit Cloud in Phase 1.
2. **Cascade:** Deepgram (STT) + Cartesia Sonic (TTS) are the Phase 1
   *defaults*, consumed only through `SpeechToTextProvider` /
   `TextToSpeechProvider` interfaces (mirroring `LLMProvider` / ADR-007). No
   vendor SDK types may appear in `VoiceRuntime`, session, or bus code.
3. **LLM:** add `LLMProvider.stream()` for **Anthropic and OpenRouter**. Text
   channels keep `chat()`. Non-streamable providers refuse to start voice
   sessions — never silently full-buffer-then-speak. Spoken turns use the
   existing **`fast` tier** (optional `channels.voice.model` override); do not
   invent a separate `voice` tier in Phase 1.
4. **Channel shape:** toggleable catalog entry `voice` with vault secrets
   `channel.voice.{livekit_url,livekit_api_key,livekit_api_secret,deepgram_api_key,cartesia_api_key}`.
   Trust: **high** (console session = principal, same as `web`).
   `conversation_id`: `voice:<sessionId>`. Follow
   `docs/dev/adding-a-channel.md` for catalog / trust / registry gating only.
5. **Atypical scaffolding (intentional):** media never rides
   `inbound.message` / `outbound.message`. TTS egress is owned by
   `VoiceRuntime`, **not** `OutboundGateway`. No `outbound-request.ts`, no
   `principal-rules.ts`, no `channel-outbound-gate` edits in Phase 1.
6. **Turn path:** `VoiceTurnRunner` (inside the voice package) drives a
   streaming tool loop against the coordinator’s tools / autonomy gates. Final
   user transcripts publish as `inbound.message` (`channelId: 'voice'`) for
   memory/audit; spoken replies never wait on `outbound.message`. The voice
   adapter no-ops any `outbound.message` addressed to `voice` (defence in
   depth if dispatch emits one).
7. **Bus events (new):** `voice.session.started`, `voice.session.ended` —
   channel publishes; system (+ optional dispatch) subscribe for audit.
   Utterance finals use existing `inbound.message` (not a parallel utterance
   type) so KG / checkpoint / trust paths stay unified.
8. **HTTP:** always-on routes via a `VoiceSessionBridge` (SMS webhook-bridge
   pattern). `POST /api/voice/sessions` is **console-session authed** (bearer
   exempt like `/api/kg`, never anonymous). Optional LiveKit webhooks are
   bearer-exempt and self-authenticate via LiveKit signature.
9. **Worker shape:** **in-process** LiveKit server SDK + client join inside
   Curia (no separate LiveKit Agents worker in Phase 1). Prefer Deepgram
   endpointing for end-of-turn; Silero-style local VAD only if endpointing is
   insufficient for barge-in.
10. **Phase 2 (non-goals here):** Signal RingRTC PCM → same `VoiceRuntime`;
    optional Telnyx SIP → LiveKit (ADR-036).

## Consequences

- Operators must run LiveKit with public IP / UDP / ICE correctly documented;
  first-time WebRTC deploys will fail without that ops guide.
- Deepgram + Cartesia costs and rate limits become part of voice enablement;
  vault + setup catalog entry are required before the channel can be enabled.
- Extending `LLMProvider` with `stream()` is a public API surface change
  (CHANGELOG must call it out); wrappers (`LLMProviderRouter`,
  `TelemetryLlmProvider`) must forward it.
- Voice turns share coordinator tools but not the exact `AgentRuntime.handleTask`
  code path — drift risk is accepted and mitigated by reusing the same
  provider, tool definitions, and bus `tool.invoke` / autonomy checks where
  practical. A later refactor may fold streaming into `AgentRuntime`.
- Phase 2 transports plug into `VoiceRuntime` without rewriting console
  WebRTC or the speech provider interfaces.
- Lifting SMS’s webhook-bridge into a shared helper is optional; copy is fine
  if the session-mint shape differs enough.
