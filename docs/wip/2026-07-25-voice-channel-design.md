# Voice channel design — duplex console WebRTC (Phase 1)

Date: 2026-07-25  
Status: Implementation  
Issue: #1414  
ADR: [037](../adr/037-voice-channel-livekit-duplex.md)

## 1. Problem

Curia cannot have a natural spoken conversation with the principal. Channels are
turn-based text; the console streams complete replies over SSE; LLM providers
are non-streaming. Phase 1 adds **live duplex voice** through the web console
via self-hosted LiveKit, keeping Curia as the brain.

Non-goals: Signal RingRTC, PSTN, S2S realtime models, push-to-talk, multiparty,
video, version bump.

## 2. Architecture

```text
Console mic ──WebRTC──► LiveKit (Docker)
                              │
                              ▼
                        VoiceRuntime
              (endpointing / barge-in,
               SpeechToTextProvider,
               TextToSpeechProvider)
                              │
           inbound.message (final transcript)
           voice.session.started|ended
                              ▼
                    VoiceTurnRunner
           (LLMProvider.stream + tools;
            sentence-chunk → TTS)
                              │
                         PCM / frames
                              ▼
                        LiveKit ──► Console speaker
```

**Media stays off the bus.** Bus carries session lifecycle + text transcripts.

### Why not OutboundGateway / principal-rules

Voice sessions are console-authenticated as the principal. Spoken egress is PCM
through LiveKit, not an external messaging API. Following
`docs/dev/adding-a-channel.md` for catalog / trust / registry only; skip
`outbound-request.ts`, `OutboundGateway`, `principal-rules.ts`, and
`channel-outbound-gate` (ADR-037).

### Why VoiceTurnRunner instead of AgentRuntime.stream

Forcing `AgentRuntime.handleTask` to stream would risk regressing every text
channel. Phase 1 isolates streaming in `src/channels/voice/turn-runner.ts`,
reusing:

- the same `LLMProvider` (with new `stream()`)
- coordinator tool definitions from the skill registry
- autonomy / Gate C via existing execution-layer paths when tools are invoked
- a short **voice-mode prompt addendum** (1–3 spoken sentences, no markdown tables)

Final user text still publishes `inbound.message` so memory, checkpoints, and
audit see the conversation. If dispatch later emits `outbound.message` for
`channelId: 'voice'`, the adapter **no-ops** delivery (TTS already spoke).

## 3. Components

### 3.1 Catalog & secrets

```typescript
{
  name: 'voice',
  description: 'Duplex voice via console WebRTC (LiveKit + STT/TTS).',
  isToggleable: true,
  credentialFields: [
    { key: 'livekit_url', label: 'LiveKit WebSocket URL', secret: false },
    { key: 'livekit_api_key', label: 'LiveKit API key', secret: true },
    { key: 'livekit_api_secret', label: 'LiveKit API secret', secret: true },
    { key: 'deepgram_api_key', label: 'Deepgram API key', secret: true },
    { key: 'cartesia_api_key', label: 'Cartesia API key', secret: true },
  ],
  requiredSecretKeys: [
    'livekit_url', 'livekit_api_key', 'livekit_api_secret',
    'deepgram_api_key', 'cartesia_api_key',
  ],
}
```

Vault keys: `channel.voice.<key>` (vault-only, no envFallback — same as SMS).

Trust (`config/channel-trust.yaml`):

```yaml
voice:
  trust: high
  unknown_sender: ignore   # only console-principal sessions create calls
  threaded: false
```

### 3.2 HTTP surface (bridge pattern)

| Route | Auth | Notes |
|---|---|---|
| `POST /api/voice/sessions` | Console session (`assertSecret`) | Mint LiveKit room + participant tokens; create DB row |
| `DELETE /api/voice/sessions/:id` | Console session | Hang up / end |
| `POST /api/webhooks/livekit` (optional) | LiveKit signature; bearer-exempt | Room finished cleanup |

Always-on Fastify registration on `HttpAdapter`. Handler installed by
`VoiceAdapter.start()` into `VoiceSessionBridge`; cleared on `stop()` → **503**.

Do **not** bearer-exempt `/api/voice/*` beyond the session-cookie pattern used
for `/api/kg` (add `/api/voice` to the session allowlist). LiveKit webhook gets
`/api/webhooks/livekit` on the provider-self-auth allowlist.

### 3.3 Session persistence

Migration `082_voice_sessions.sql`:

```sql
CREATE TABLE voice_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL UNIQUE,  -- voice:<id>
  livekit_room  TEXT NOT NULL,
  principal_contact_id UUID NULL REFERENCES contacts(id),
  status        TEXT NOT NULL CHECK (status IN ('starting','active','ended','failed')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX voice_sessions_status_idx ON voice_sessions (status);
```

Restart safety: on VoiceRuntime start, mark non-`ended` rows as `failed` with
`end_reason = 'process_restart'` (rooms are ephemeral; do not auto-rejoin).

### 3.4 Bus events

```typescript
// New (channel publishes, system subscribes):
'voice.session.started' // { sessionId, conversationId, livekitRoom }
'voice.session.ended'   // { sessionId, conversationId, reason, durationMs? }

// Existing for finals:
'inbound.message' // channelId: 'voice', conversationId: 'voice:<sessionId>',
                  // senderId: 'ceo-web-user' (same as console chat)
```

Permissions: add the two session types to channel publish + system subscribe
(and optionally dispatch subscribe — not required for Phase 1).

### 3.5 Speech provider interfaces

```typescript
// Streaming-first; no vendor types past this boundary.

interface SpeechToTextProvider {
  readonly id: string;
  startSession(opts: SttSessionOptions): Promise<SttSession>;
}

interface SttSession {
  sendAudio(frame: PcmFrame): void;
  end(): Promise<void>;
  /** interim + final transcripts; endpoint = end-of-turn signal */
  onTranscript(cb: (e: SttTranscriptEvent) => void): void;
  cancel(): void;
}

interface TextToSpeechProvider {
  readonly id: string;
  synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame>;
  /** Abort in-flight synthesis for barge-in */
  cancel(streamId: string): void;
}
```

Implementations: `DeepgramSttProvider`, `CartesiaTtsProvider`. Unit tests use
`FakeSttProvider` / `FakeTtsProvider`.

`PcmFrame`: `{ pcm: Int16Array; sampleRate: number; channels: 1 }`.

### 3.6 LLM streaming

```typescript
interface LLMProvider {
  chat(...): Promise<LLMResponse>;
  /**
   * Optional. Voice refuses to start if absent / throws StreamUnsupportedError.
   * Yields text deltas, tool_use aggregates, usage, or error — never buffers
   * the full reply before first yield when the backend supports true streaming.
   */
  stream?(params: StreamParams): AsyncIterable<LLMStreamEvent>;
}

type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; toolCalls: ToolCall[]; content?: string; usage: LLMUsage; provenance: LLMCallProvenance }
  | { type: 'message_end'; content: string; usage: LLMUsage; provenance: LLMCallProvenance }
  | { type: 'error'; error: AgentError; usage?: LLMUsage };
```

Implement Anthropic `messages.stream` and OpenRouter OpenAI-compatible
streaming. Forward through router + telemetry wrappers. Honor `options.signal`
for barge-in cancel.

### 3.7 VoiceRuntime lifecycle

1. `POST /api/voice/sessions` → create room, DB row, mint tokens (principal +
   agent identities, **explicit 1h JWT TTL**), return
   `{ sessionId, livekitUrl, token, conversationId }`.
2. Console connects with LiveKit client SDK; publishes mic track.
3. VoiceRuntime joins as agent participant; subscribes to principal audio.
4. Pipe PCM → STT session; on **final + endpoint**, start `VoiceTurnRunner`.
5. Runner: inject voice-mode system addendum; `stream()`; sentence-chunk text
   deltas → TTS → publish audio track. On `tool_use`, speak a short filler,
   invoke tool via execution path, continue stream with tool results.
   Persist user + assistant turns to `WorkingMemory` for console history.
6. **Barge-in:** interim user speech while TTS/LLM active →
   `tts.cancel` + abort LLM `AbortSignal` + drop uncommitted assistant audio
   (~300ms stop target), gated by `text.length >= 3` and
   `confidence >= 0.4` (when reported) to reduce speaker-echo false triggers.
7. Hang up / principal disconnect / room disconnect → end session, delete
   LiveKit room, publish `voice.session.ended`, stop tracks, update DB.
   Transport `onClose` covers ungraceful tab close without `DELETE`.

### Phase 1 brain (explicit non-goal)

Spoken turns deliberately do **not** load the coordinator's full system prompt,
office persona injection, KG/entity-context enrichment, or DB-backed working
memory into the LLM context. The model sees the voice addendum, last-N
in-memory turns for this session, and coordinator pinned tools. Closing the
gap with `AgentRuntime.handleTask` is a tracked follow-up.

### Outbound judge parity

TTS egress bypasses `OutboundGateway` / Stage-2 judge — **same as web chat**
(principal console text never calls the gateway). External tool sends still
go through the gateway.

### 3.8 Latency instrumentation

Structured log fields (pino):

- `voice.ttfa_ms` — time from end-of-user-turn to first TTS audio frame
- `voice.stt_final_ms`, `voice.llm_ttft_ms`, `voice.tts_first_byte_ms`
- `voice.barge_in_stop_ms` when barge-in fires

Operators validate P95 against the deploy’s resolved model.

### 3.9 Console UI

On `ChatPage` / composer area:

- **Call** button (visible when voice channel enabled — probe via channel
  registry status or a lightweight `GET /api/voice/status`)
- Active call bar: mute / unmute / hang up + connection state
- Live transcript lines appended to the chat thread (local optimistic + bus /
  history for finals)

Use `@livekit/components-react` sparingly or raw `livekit-client` —
prefer minimal UI chrome consistent with existing console (no new card-heavy
layout).

### 3.10 Docker / ops

`docker-compose.yml` adds a `livekit` service (official image) with config for
RTC ports. Document in `docs/dev/` (and setup catalog `docs_url`):

- Public IP / `use_external_ip`
- UDP port range for WebRTC
- Firewall / ICE
- Generating API key/secret
- Vault keys + enable channel + restart

### 3.11 Setup catalog

Entry in `skills/setup/tools/setup-status/catalog.yaml` with
`vault_secrets_all` for the five `channel.voice.*` keys and a docs URL
(`/channels/voice-setup`). Public curia-docs page is ideal; Phase 1 may ship
in-repo `docs/dev/voice-setup.md` and point the catalog there until curia-docs
lands.

## 4. File layout

```text
docs/adr/037-voice-channel-livekit-duplex.md
docs/wip/2026-07-25-voice-channel-design.md          # this file
docs/wip/2026-07-25-voice-channel-implementation.md  # phased plan
docs/dev/voice-setup.md

src/channels/voice/
  voice-adapter.ts
  session-bridge.ts
  session-routes.ts
  voice-runtime.ts
  turn-runner.ts
  session-store.ts
  speech/
    types.ts
    deepgram-stt.ts
    cartesia-tts.ts
    fake-stt.ts
    fake-tts.ts
  livekit/
    token.ts
    room-session.ts
  *.test.ts

src/agents/llm/provider.ts          # + stream()
src/agents/llm/anthropic.ts
src/agents/llm/openrouter.ts
src/agents/llm/provider-router.ts
src/agents/llm/telemetry-provider.ts

src/db/migrations/082_voice_sessions.sql
config/channel-trust.yaml
config/default.yaml                   # optional channels.voice.model
src/bus/events.ts + permissions.ts
src/channels/catalog.ts
src/channels/apply-channel-vault-secrets.ts
src/config.ts + index.ts
src/channels/http/http-adapter.ts

apps/console/...                      # Call controls + LiveKit client
docker-compose.yml                    # livekit service
```

## 5. Testing strategy

| Layer | Coverage |
|---|---|
| Unit | Anthropic + OpenRouter `stream()` (mocked SDK); fake STT/TTS; turn-runner barge-in cancel; sentence chunker; token mint; session bridge 503 |
| Unit | Catalog descriptor; channel conformance for `VoiceAdapter` |
| Integration | Optional: DB session store with `DATABASE_URL`; skip when unset |
| Manual / smoke | Console call against local LiveKit + real keys (ops) |

Non-regression: text `chat()` path unchanged; Signal/email/SMS/HTTP unaffected.

## 6. Acceptance mapping

See #1414 acceptance criteria 1–11. Design locks: events (§3.4), schemas (§3.3),
provider seams (§3.5–3.6), atypical scaffolding (§2), `fast` tier (§ADR-037).
