# Voice channel — implementation plan (Phase 1)

Date: 2026-07-25  
Design: [2026-07-25-voice-channel-design.md](./2026-07-25-voice-channel-design.md)  
ADR: [037](../adr/037-voice-channel-livekit-duplex.md)  
Issue: #1414

This is a **size:XXL** change. Land as one PR on `cursor/voice-channel-phase1-963a`
with incremental commits. Each phase below should leave `pnpm run typecheck` and
`pnpm run lint` green for touched packages.

---

## Locked decisions (do not reopen in code review)

| Topic | Choice |
|---|---|
| Transport | Self-hosted LiveKit (Compose) |
| STT / TTS defaults | Deepgram / Cartesia behind interfaces |
| LLM streaming | `LLMProvider.stream()` on Anthropic **and** OpenRouter |
| Voice model | Existing `fast` tier + optional `channels.voice.model` |
| Turn path | `VoiceTurnRunner` (not AgentRuntime rewrite) |
| Outbound | No OutboundGateway / principal-rules / outbound-request |
| Bus | `voice.session.started\|ended` + `inbound.message` for finals |
| HTTP | `VoiceSessionBridge` (SMS pattern); session-authed mint |
| Worker | In-process (no LiveKit Agents worker) |
| End-of-turn | Deepgram endpointing first |
| Shared webhook helper | Copy SMS bridge shape; lift only if identical |

---

## Phase A — Design artifacts (this commit)

- [x] ADR-037
- [x] WIP design
- [x] This plan
- [ ] ADR index row
- [ ] CHANGELOG bullet for ADR/design (optional until code lands; prefer one
      changelog entry when the channel is functional)

## Phase B — Streaming LLM (foundation, no voice UI yet)

1. Extend `LLMProvider` with optional `stream?()`.
2. Implement Anthropic `messages.stream` → `LLMStreamEvent`.
3. Implement OpenRouter OpenAI-compatible streaming.
4. Forward in `LLMProviderRouter` + `TelemetryLlmProvider`.
5. Unit tests with mocked SDK streams; assert AbortSignal cancels.
6. **Do not** change `AgentRuntime` to call `stream()` yet.

## Phase C — Channel scaffolding (disabled by default)

1. Catalog `voice` descriptor + required secrets.
2. `config/channel-trust.yaml` `voice:` block.
3. Config fields + `apply-channel-vault-secrets` allowlist.
4. Migration `082_voice_sessions.sql` + `VoiceSessionStore`.
5. Bus events + permissions for session lifecycle.
6. `VoiceSessionBridge` + always-on routes on `HttpAdapter`.
7. Stub `VoiceAdapter` (`start`/`stop` install/clear bridge).
8. Bootstrap gate in `index.ts` (`channelShouldStart.has('voice')`).
9. Catalog + conformance tests.

## Phase D — Speech providers

1. `speech/types.ts` interfaces + `PcmFrame`.
2. Deepgram streaming STT implementation.
3. Cartesia streaming TTS implementation.
4. Fake providers for tests.
5. Unit tests: transcript events, cancel/flush, no vendor types leak into
   runtime modules (eslint/import boundary or type-only review).

## Phase E — VoiceRuntime + LiveKit

1. LiveKit token mint helper (room + identity grants).
2. Room join / subscribe / publish audio (server participant).
3. Wire STT ← principal track; TTS → agent track.
4. `VoiceTurnRunner`: stream LLM, sentence chunker, tool filler, barge-in.
5. Publish `inbound.message` on user finals; session started/ended events.
6. Latency log fields (`voice.ttfa_ms`, etc.).
7. Unit tests with fakes (no live LiveKit required in CI).

## Phase F — Console UI

1. `POST /api/voice/sessions` client helper in console `api.ts`.
2. Call controls on chat page (join / mute / hang up).
3. LiveKit browser client connection.
4. Live transcript rendering.
5. Hide/disable Call when channel not enabled (`GET /api/voice/status` or
   channel-registry status already exposed).

## Phase G — Compose, docs, setup, changelog

1. `livekit` service in `docker-compose.yml` (+ sample config).
2. `docs/dev/voice-setup.md` (ports, ICE, vault, enable, restart).
3. Setup catalog entry → docs URL.
4. Update `docs/specs/04-channels.md` (voice section); note Phase 1 in
   `00-overview.md` (remove from “not in scope” or qualify console-only).
5. `CHANGELOG.md` `[Unreleased]` — ≤15 words after em-dash; call out
   `LLMProvider.stream` as public API.
6. Pin LiveKit / Deepgram / Cartesia deps in root `package.json` (and console
   LiveKit client if needed). Prefer official SDKs; add `pnpm-workspace.yaml`
   overrides only if a CVE pin is required.

## Phase H — Verify

1. `pnpm run typecheck` + console typecheck.
2. `pnpm run lint`.
3. `pnpm test` (unit; integration if DB up).
4. Manual smoke when keys available (optional in cloud agent).

---

## Risk mitigations

| Risk | Mitigation |
|---|---|
| AgentRuntime drift | Keep VoiceTurnRunner thin; document reuse points; follow-up issue to merge streaming into runtime |
| OpenRouter TTFT | Measure `voice.ttfa_ms`; optional model override; refuse non-streaming |
| WebRTC NAT | Ops doc first-class; Compose comments for UDP ports |
| Scope creep | No Phase 2 Signal/PSTN; no S2S; no OutboundGateway |
| Migration collision | Before merge, `ls src/db/migrations \| sort` — renumber if 082 taken |

---

## Suggested commit sequence

1. `docs: ADR-037 + voice channel design/plan (#1414)`
2. `feat(llm): add LLMProvider.stream for Anthropic and OpenRouter`
3. `feat(voice): catalog, trust, vault, sessions table, bus events, HTTP bridge`
4. `feat(voice): SpeechToText/TextToSpeech providers (Deepgram/Cartesia)`
5. `feat(voice): VoiceRuntime duplex cascade + barge-in`
6. `feat(console): voice call controls and LiveKit client`
7. `chore(voice): LiveKit compose, setup docs, changelog, specs`

Each commit: DCO `Signed-off-by` via `git commit -s`.
