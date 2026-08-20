# Signal Voice Calls — Design (curia#1672)

Status: approved design, pre-implementation. Spike: #1602 (feasibility + live
validation, 2026-08-20). Successor to ADR-037 §10's "Phase 2: Signal RingRTC
PCM → same VoiceRuntime".

## Goal

Anyone can place a native Signal voice call to Curia's Signal number and hold
a real-time spoken conversation through the existing voice pipeline
(VoiceRuntime + Deepgram STT + Cartesia TTS). Ships config-gated, default off.

## Validated foundation (spike #1602)

- signal-cli ≥ 0.14.2 answers calls by spawning one `signal-call-tunnel`
  process per call (RingRTC/WebRTC, upstream: visigoth/signal-call-tunnel,
  pinned commit `02c84e9`). signal-cli relays all Signal-protocol signaling.
- JSON-RPC on the existing daemon socket: `subscribeCallEvents` (required —
  without an active subscription signal-cli silently ignores incoming calls),
  `acceptCall`, `rejectCall`, `hangupCall`, `listCalls`, plus `callEvent`
  notifications `{callId, state, number, uuid, isOutgoing, inputDeviceName,
  outputDeviceName, reason?}` with states RINGING_INCOMING → CONNECTING →
  CONNECTED → (RECONNECTING →) ENDED.
- Call audio surfaces as per-call PulseAudio virtual devices inside the
  signal-cli container. Confirmed live: Opus, 48 000 Hz, mono, 20 ms frames.
  - Send audio to the caller: play into sink `sink_for_<inputDeviceName>`
  - Receive caller audio: record source `<outputDeviceName>.monitor`
- Upstream requires signal-cli ≥ 0.14.7 for any (re-)registration (old
  registration API retired; 0.14.5 `register` → 403). Calls themselves work on
  0.14.5+, but the deploy bumps to ≥ 0.14.7 as part of this work.

## Architecture

```
 caller ──Signal call──▶ signal-cli daemon ──spawns──▶ signal-call-tunnel (RingRTC)
                              │ JSON-RPC (existing unix socket)      │
                              │  callEvent / acceptCall / hangupCall │ PulseAudio (shared socket)
                              ▼                                      ▼
                       SignalCallBridge ──▶ VoiceRuntime ◀── SignalAudioTransport
                        (policy, lifecycle,     │ STT: Deepgram (48k linear16)
                         persistence, audit)    │ TTS: Cartesia (48k pcm_s16le)
```

Media never touches the bus (ADR-037 invariant). The runtime, turn loop,
barge-in, speech providers, and history handling are reused unchanged.

## Components

### 1. SignalRpcClient additions (`src/channels/signal/signal-rpc-client.ts`)

- `subscribeCallEvents()` — sent on connect AND on every reconnect (the
  subscription dies with the socket; forgetting this silently disables calls).
- `acceptCall(callId)`, `rejectCall(callId)`, `hangupCall(callId)`.
- `callEvent` notifications parsed and emitted as a typed event
  (`emit('callEvent', ev)`), alongside the existing `message` emission.
- `callId` is an unsigned 64-bit value that routinely exceeds
  `Number.MAX_SAFE_INTEGER` (observed in the spike: `-7828393543136742976`).
  Plain `JSON.parse` would silently corrupt it and `acceptCall` would then
  target a nonexistent call. Carried as `bigint` end-to-end: inbound
  `callEvent` lines are parsed with a bigint-preserving step (quote the
  `"callId": -?\d+` value before `JSON.parse`, or a reviver on the raw
  token), and outbound requests serialize the bigint as a bare JSON number
  via string construction (never `Number(callId)`).

### 2. SignalAudioTransport (`src/channels/voice/signal/signal-audio-transport.ts`)

Implements the five-method `AudioTransport` seam plus rate hints:

- `connect()` — spawn `parec --device=<outputDeviceName>.monitor` and
  `pacat --device=sink_for_<inputDeviceName>` (both
  `--rate=48000 --channels=1 --format=s16le --raw`) against
  `PULSE_SERVER=<shared socket path>`.
- `onRemoteAudio` — chunk parec stdout into 20 ms `PcmFrame`s
  (960 samples, Int16Array, mono, 48 000 Hz).
- `publishAudio(frame)` — write frame bytes to pacat stdin with backpressure
  (`drain`) handling.
- `inboundSampleRate = publishSampleRate = 48000` (RateAwareTransport hints;
  Deepgram and Cartesia both configured at 48 k → no in-process resampling).
- `onClose` mapping: remote hangup (bridge calls `notifyEnded()` when
  `callEvent: ENDED` arrives) → `'principal_disconnected'`; parec/pacat
  unexpected exit or spawn failure → `'transport_error'`. Local
  `disconnect()` fires nothing (seam contract).
- `disconnect()` — SIGTERM both children, await exit, idempotent.

The process spawner is injected (constructor dependency) so unit tests script
PCM without PulseAudio; CI never needs an audio stack.

### 3. SignalCallBridge (`src/channels/voice/signal/signal-call-bridge.ts`)

Analogous to `VoiceSessionBridge` for console. Owns:

- **Subscription + dispatch.** On startup (only when the feature flag and the
  voice stack are both enabled): `subscribeCallEvents`, listen for
  `callEvent`.
- **Answer policy (v1: answer everyone).** On RINGING_INCOMING:
  1. Resolve the caller (number/uuid) through the same contact-resolution
     path as inbound Signal messages; unknown callers get a contact created
     exactly like an inbound text would.
  2. Determine audience structurally: principal iff resolved contact id
     matches `principalContactId` (never `role`-based; per contacts-ledger
     rules and the #1514 incident).
  3. If another call session is active → `rejectCall` (busy). Audit the
     decision either way (accept/reject, resolved contact, reason).
  4. `acceptCall`, then on CONNECTED construct `SignalAudioTransport` from
     the event's device names and `VoiceRuntime.startSession` with a
     `VoiceCallerContext` carrying the resolved contact and audience.
     `liveTurn` stamps once at session create (voice rule, #1598).
- **Framing.** Principal callers get the standard principal voice framing.
  Known non-principal and unknown callers get non-principal audience framing
  (#1598 machinery) and NO outbound-context injection (#1594 gate). Greeting
  turn (#1596) varies by audience: principal / known contact / unknown
  caller.
- **Duration cap.** `SIGNAL_VOICE_MAX_CALL_SECONDS` (default 600). On expiry:
  inject a wrap-up prompt for a short closing turn, then `hangupCall` and end
  the session. Bounds token burn under answer-everyone.
- **Lifecycle & persistence.** `voice_sessions` row (channel=signal),
  `voice.session.started` / `voice.session.ended` events, teardown on
  `callEvent: ENDED` (either side hung up), on transport close, on runtime
  end, or on RPC socket loss mid-call (we can no longer control the call:
  end the session locally, log at error, re-subscribe on reconnect).
  Every exit path leaves: STT/TTS cancelled, transport children reaped,
  session row closed, `ended` event published. No silent failures.

### 4. VoiceRuntime factory generalization (`src/channels/voice/voice-runtime.ts`)

`VoiceRuntimeConfig.createTransport` currently takes LiveKit-shaped opts
(roomName/token/livekitUrl/callerIdentity). Generalize: `startSession`
accepts a caller-supplied `transportFactory: () => AudioTransport` (console
keeps a LiveKit factory built by `VoiceAdapter`; the bridge supplies a Signal
factory). No behavioral change for console.

### 5. Configuration (`src/config.ts`)

- `SIGNAL_VOICE_CALLS_ENABLED` (default false) — master gate; bridge starts
  only when this AND the voice stack AND the Signal channel are configured.
- `SIGNAL_PULSE_SOCKET_PATH` — path to the shared PulseAudio native socket
  (mounted from the signal-cli container).
- `SIGNAL_VOICE_MAX_CALL_SECONDS` (default 600).

### 6. Deploy (curia-deploy — companion issue, separate PR, lands second)

- signal-cli image → ≥ 0.14.7; add Rust build stage for `signal-call-tunnel`
  (pin `02c84e9`; linux-x64 prebuilt WebRTC exists) and set
  `SIGNAL_CALL_TUNNEL_BIN`.
- Run PulseAudio in the signal-cli container (per-user daemon, as validated
  in the spike harness); expose its native socket on a shared volume with
  the same group-permission pattern as the RPC socket; curia container mounts
  it read-write and sets `SIGNAL_PULSE_SOCKET_PATH`.
- Runbook: signal voice bootstrap, ops notes (daemon must be stopped for
  account maintenance commands; tunnel logs on daemon stderr as
  `[tunnel-<callId>]`; per-call devices are auto-created/destroyed).
- Reference implementation: `office-of-the-ceo/spikes/signal-call-spike-1602/`.

## Error handling summary

| Failure | Detection | Handling |
|---|---|---|
| Tunnel process dies mid-call | signal-cli emits `callEvent: ENDED` | normal teardown |
| parec/pacat dies / Pulse unreachable | child exit / spawn error | `onClose('transport_error')` → runtime ends session → bridge `hangupCall` |
| RPC socket lost mid-call | client reconnect logic | end session locally, error log, re-`subscribeCallEvents` on reconnect |
| Caller hangs up | `callEvent: ENDED (RemoteHangup)` | bridge notifies transport → `'principal_disconnected'` path |
| Second incoming call while busy | bridge session registry | `rejectCall`, audited |
| Duration cap reached | bridge timer | wrap-up turn → `hangupCall` → teardown |

## Testing

TDD throughout (tests written before implementation, per repo practice).

- **Unit — transport:** fake spawner scripting stdout PCM and capturing
  stdin; frame chunking (20 ms boundaries, partial-chunk carry), backpressure,
  close-reason mapping, idempotent disconnect.
- **Unit — RPC client:** fake socket; subscribeCallEvents on connect and
  after reconnect; callEvent parsing incl. negative-looking (unsigned)
  callIds; accept/reject/hangup wire format.
- **Unit — bridge policy matrix:** principal / known non-principal / unknown
  / busy / flag-off / voice-stack-off; audit entries; duration cap.
- **Integration:** bridge + FakeAudioTransport driving a real VoiceRuntime
  session end-to-end (greeting, turn, hangup teardown), asserting events and
  session rows.
- **Manual E2E (pre-merge):** adapted spike harness + local dev stack
  (`pnpm dev` against dev DB per the local runbook), real phone call:
  greeting heard, multi-turn conversation, barge-in, hangup teardown clean.
- CI requires no PulseAudio and no signal-cli.

## Out of scope (v1)

Outgoing calls, group calls, video, PSTN/SIP (ADR-036), voice-note fallback
(#1597, already shipped), answering-policy configurability beyond the master
flag and duration cap (fast follow if answer-everyone proves noisy).

## Decisions log

- **Answer policy v1: answer everyone** (Joseph, 2026-08-20) — framing and
  the duration cap are the guardrails; revisit if abused.
- Pulse access via spawned `parec`/`pacat` (no native Node audio deps;
  trivially fakeable).
- `callId` as `bigint` internally.
- App PR first, deploy PR second, flag flipped manually by Joseph after both.
