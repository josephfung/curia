# Voice channel security notes (Phase 1)

Date: 2026-07-25  
PR: #1544 / Issue: #1414  
ADR: [037](../adr/037-voice-channel-livekit-duplex.md)

Focused security memo for the duplex voice surface. Complements ADR-037 and
`docs/dev/voice-setup.md`.

## Authn / mint

| Route | Auth | Mint? |
|---|---|---|
| `GET /api/voice/status` | None | No — `{ enabled }` only |
| `POST /api/voice/sessions` | `assertSecret` (console cookie / bootstrap header) | Yes |
| `DELETE /api/voice/sessions/:id` | `assertSecret` | No |

`/api/voice/*` is bearer-exempt so console session auth can run (same pattern as
`/api/kg`). **Anonymous mint is not possible.**

## LiveKit JWTs

- Grants: `roomJoin` + `canPublish` + `canSubscribe` for one room only.
- Explicit TTL: **1h** (not the SDK's 6h default).
- Room delete / empty timeouts tidy abandoned rooms; they do **not** revoke
  JWTs. A leaked token can still rejoin (and LiveKit may auto-create the room)
  until the TTL expires.
- Never run LiveKit `--dev` (public `devkey`/`secret`) on a reachable interface.

## Privacy (third-party data flow)

Enabling voice means principal **audio and transcripts leave the box** to:

- Deepgram (streaming STT) — WebSocket subprotocol auth `['token', apiKey]`
- Cartesia (streaming TTS) — HTTPS bearer
- The deploy's LLM provider (streaming chat)

Speech-vendor keys never reach the browser. Operator DPAs should cover this path.

## Trust / outbound

- Channel trust: **high** (console session = principal), matching `web`.
- Spoken TTS bypasses `OutboundGateway` / Stage-2 judge — **parity with web chat**.
- Tool calls from a live call go through `ExecutionLayer` with a stamped
  principal `TaskOriginator` + `liveTurn: true`; external sends still hit the
  gateway.

## Residual risks / smoke-test focus

- Speaker echo can still false-trigger barge-in despite confidence/length gates —
  validate on speakers vs headset.
- Full duplex P95 / ICE / NAT must be validated against real LiveKit + Deepgram
  + Cartesia (not covered by unit fakes).
