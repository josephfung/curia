// signal-call-integration.test.ts — end-to-end test: SignalCallBridge driving a
// REAL VoiceRuntime session (#1672 Task 8).
//
// Every other test in this directory fakes one side or the other (bridge unit
// tests fake VoiceRuntime entirely; voice-runtime.test.ts fakes the transport
// but never goes through SignalCallBridge). This file wires the real bridge to
// a real VoiceRuntime, sharing one fake sessionStore between them, so any seam
// mismatch between Tasks 2-7 (transport factory shape, session-store row
// shape, the `transport` override contract, event publishing) fails here
// instead of silently in production. Only VoiceRuntime's leaf dependencies
// (STT, TTS, LLM, transport, RPC client) are fakes — the bridge and runtime
// themselves are the real production classes.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../bus/bus.js';
import type { BusEvent } from '../../../bus/events.js';
import type { ContactResolver } from '../../../contacts/contact-resolver.js';
import type { SenderContext } from '../../../contacts/types.js';
import { createSilentLogger } from '../../../logger.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent, Message } from '../../../agents/llm/provider.js';
import { FakeSttProvider, FakeTtsProvider } from '../../../speech/index.js';
import type { SignalCallEvent } from '../../signal/call-types.js';
import type { SignalRpcClient } from '../../signal/signal-rpc-client.js';
import { FakeAudioTransport } from '../fake-audio-transport.js';
import type { CreateVoiceSessionInput, VoiceSessionRecord, VoiceSessionStore } from '../session-store.js';
import { VoiceRuntime } from '../voice-runtime.js';
import { SignalCallBridge } from './signal-call-bridge.js';
import type { SignalAudioTransportOpts } from './signal-audio-transport.js';

const DEFAULT_NUMBER = '+15196161377';
const PRINCIPAL_CONTACT_ID = '11111111-1111-1111-1111-111111111111';

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'fake', actualModel: 'fake', providerRequestId: 'req_1' };

// ---------------------------------------------------------------------------
// Signal call event fixtures — mirrors signal-call-bridge.test.ts.
// ---------------------------------------------------------------------------

function ringingEvent(callId: bigint, overrides: Partial<SignalCallEvent> = {}): SignalCallEvent {
  return {
    callId,
    state: 'RINGING_INCOMING',
    number: DEFAULT_NUMBER,
    uuid: null,
    isOutgoing: false,
    inputDeviceName: null,
    outputDeviceName: null,
    reason: null,
    ...overrides,
  };
}

function connectedEvent(callId: bigint, overrides: Partial<SignalCallEvent> = {}): SignalCallEvent {
  return {
    callId,
    state: 'CONNECTED',
    number: DEFAULT_NUMBER,
    uuid: null,
    isOutgoing: false,
    inputDeviceName: `signal_input_${callId.toString()}`,
    outputDeviceName: `signal_output_${callId.toString()}`,
    reason: null,
    ...overrides,
  };
}

function endedEvent(callId: bigint, overrides: Partial<SignalCallEvent> = {}): SignalCallEvent {
  return {
    callId,
    state: 'ENDED',
    number: DEFAULT_NUMBER,
    uuid: null,
    isOutgoing: false,
    inputDeviceName: null,
    outputDeviceName: null,
    reason: 'RemoteHangup',
    ...overrides,
  };
}

/** Resolved principal SenderContext — the caller resolves to a known contact. */
function principalSenderContext(): SenderContext {
  return {
    resolved: true,
    contactId: PRINCIPAL_CONTACT_ID,
    displayName: 'Joseph',
    role: 'ceo',
    systemRole: 'principal',
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1.0,
    tier: 'principal',
    kind: 'principal',
  };
}

// ---------------------------------------------------------------------------
// Fakes for the bridge's own dependencies (RPC client, transport factory,
// contact resolver) — same shapes as signal-call-bridge.test.ts.
// ---------------------------------------------------------------------------

/** Fake signal-cli RPC client: a real EventEmitter (so on/off/listenerCount
 * behave exactly like the production client) with vi.fn() call methods. */
class FakeRpcClient extends EventEmitter {
  setCallEventsSubscription = vi.fn();
  acceptCall = vi.fn(async (_callId: bigint) => undefined);
  rejectCall = vi.fn(async (_callId: bigint) => undefined);
  hangupCall = vi.fn(async (_callId: bigint) => undefined);
}

/**
 * Real FakeAudioTransport (the same class VoiceRuntime's own tests drive)
 * with the extra notifyRemoteHangup() the bridge's transport contract
 * requires. Wiring ENDED -> notifyRemoteHangup() -> emitClose() exercises the
 * exact path production's SignalAudioTransport takes when RingRTC reports the
 * remote party hung up.
 */
class FakeSignalCallTransport extends FakeAudioTransport {
  notifyRemoteHangup(): void {
    this.emitClose('principal_disconnected');
  }
}

/** Streaming LLM fake — scripted replies, records every messages[] it saw so
 * the greeting turn's invocation is provable (not just "some frames played"). */
class FakeStreamProvider implements LLMProvider {
  readonly id = 'fake-stream';
  readonly seenMessages: Message[][] = [];
  constructor(private readonly scripts: LLMStreamEvent[][]) {}
  private call = 0;
  async chat(): Promise<LLMResponse> {
    return { type: 'text', content: '', usage, provenance };
  }
  async *stream(params: { messages?: Message[] }): AsyncIterable<LLMStreamEvent> {
    this.seenMessages.push(params.messages ?? []);
    const script = this.scripts[this.call] ?? [];
    this.call += 1;
    for (const event of script) yield event;
  }
}

const greetingScript: LLMStreamEvent[] = [
  { type: 'text_delta', text: 'Hey, this is Curia. ' },
  { type: 'message_end', content: 'Hey, this is Curia.', usage, provenance },
];

/**
 * In-memory VoiceSessionStore stand-in shared by BOTH the bridge and the
 * runtime (the coordination detail the brief calls out) — modeling the same
 * row shape and endSession dedupe (`status <> 'ended'` in the real SQL)
 * session-store.ts enforces. Only `create`/`endSession` are exercised here
 * (`updateStatus` is called by the runtime on first transcript, not reached
 * in this greeting-only script).
 */
function fakeSharedSessionStore(): {
  store: VoiceSessionStore;
  createCalls: CreateVoiceSessionInput[];
  endCalls: Array<{ id: string; reason: string }>;
} {
  const rows = new Map<string, VoiceSessionRecord>();
  const createCalls: CreateVoiceSessionInput[] = [];
  const endCalls: Array<{ id: string; reason: string }> = [];

  const store = {
    async create(input: CreateVoiceSessionInput): Promise<VoiceSessionRecord> {
      createCalls.push(input);
      const id = input.id ?? randomUUID();
      const record: VoiceSessionRecord = {
        id,
        conversationId: input.conversationId,
        livekitRoom: input.livekitRoom,
        principalContactId: input.principalContactId ?? null,
        status: 'starting',
        startedAt: new Date(),
        endedAt: null,
        endReason: null,
        metadata: input.metadata ?? {},
      };
      rows.set(id, record);
      return record;
    },
    async updateStatus(id: string, status: 'starting' | 'active' | 'failed'): Promise<VoiceSessionRecord | null> {
      const row = rows.get(id);
      if (!row || row.status === 'ended') return null;
      row.status = status;
      return row;
    },
    async endSession(id: string, reason: string): Promise<VoiceSessionRecord | null> {
      endCalls.push({ id, reason });
      const row = rows.get(id);
      // Mirrors the real `WHERE status <> 'ended'` dedupe — the second
      // endSession call (bridge's safety-net vs. the transport-close path)
      // must be a no-op, not a second ended event.
      if (!row || row.status === 'ended') return null;
      row.status = 'ended';
      row.endedAt = new Date();
      row.endReason = reason;
      return row;
    },
  } as unknown as VoiceSessionStore;

  return { store, createCalls, endCalls };
}

describe('SignalCallBridge -> VoiceRuntime (end-to-end, #1672)', () => {
  it('runs a full ring -> connect -> greet -> hangup cycle against a real VoiceRuntime session', async () => {
    // ---- shared fakes -------------------------------------------------
    const { store, createCalls } = fakeSharedSessionStore();
    const logger = createSilentLogger();
    const bus = new EventBus(logger);
    const busEvents: BusEvent[] = [];
    bus.subscribe('voice.session.started', 'system', async e => {
      busEvents.push(e);
    });
    bus.subscribe('voice.session.ended', 'system', async e => {
      busEvents.push(e);
    });

    const llm = new FakeStreamProvider([greetingScript]);
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();

    // createTransport on the RUNTIME side must never be invoked — the bridge
    // always supplies a per-session transport override (#1672's seam under
    // test). A throwing stub turns a regression (runtime falling back to its
    // own LiveKit factory) into a hard failure instead of a silent divergence.
    const runtimeCreateTransport = vi.fn(() => {
      throw new Error('VoiceRuntime.createTransport must not be called when SignalCallBridge supplies a transport');
    });

    const runtime = new VoiceRuntime({
      bus,
      logger,
      sessionStore: store,
      stt,
      tts,
      llm,
      model: 'fake',
      livekitUrl: 'ws://localhost',
      createTransport: runtimeCreateTransport,
    });

    const rpc = new FakeRpcClient();
    const contactResolver = {
      resolve: vi.fn(async () => principalSenderContext()),
    } as unknown as ContactResolver;

    const transports: FakeSignalCallTransport[] = [];
    const bridgeCreateTransport = vi.fn((_opts: SignalAudioTransportOpts) => {
      const t = new FakeSignalCallTransport();
      transports.push(t);
      return t;
    });

    const bridge = new SignalCallBridge({
      bus,
      logger,
      rpcClient: rpc as unknown as SignalRpcClient,
      contactResolver,
      voiceRuntime: runtime,
      sessionStore: store,
      pulseServer: '/run/pulse/native',
      createTransport: bridgeCreateTransport,
    });

    const callId = 1672n;

    // ---- Act 1: ring -> accept -----------------------------------------
    bridge.start();
    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    expect(rpc.rejectCall).not.toHaveBeenCalled();

    // ---- Act 2: connect -> real VoiceRuntime session + greeting --------
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(runtime.activeSessionCount).toBe(1));

    // The bridge inserted a row with signal metadata, and via the shared
    // UUID_RE gate the resolved principal's contactId was persisted.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.principalContactId).toBe(PRINCIPAL_CONTACT_ID);
    expect(createCalls[0]!.metadata).toMatchObject({
      channel: 'signal',
      callerNumber: DEFAULT_NUMBER,
      callId: callId.toString(),
    });

    // The bridge built exactly one Signal transport and handed it straight
    // to the real runtime as a `transport` override — never through the
    // runtime's own createTransport factory.
    expect(transports).toHaveLength(1);
    const transport = transports[0]!;
    expect(transport.connected).toBe(true);
    expect(runtimeCreateTransport).not.toHaveBeenCalled();

    const sessionId = createCalls[0]!.id;
    expect(sessionId).toBeDefined();

    // openingGreeting is enqueued (fire-and-forget) inside startSession, so
    // activeSessionCount going to 1 does not itself prove the greeting turn
    // ran. awaitIdle() drains the turn chain deterministically instead of
    // polling on frame counts.
    await runtime.awaitIdle(sessionId!);

    // The fake LLM was actually invoked for the greeting turn (not just a
    // transport connect with no brain behind it), and the synthesized
    // greeting reached the transport as published audio.
    expect(llm.seenMessages.length).toBeGreaterThanOrEqual(1);
    expect(transport.publishedFrames.length).toBeGreaterThan(0);

    await vi.waitFor(() => expect(busEvents.some(e => e.type === 'voice.session.started')).toBe(true));

    // ---- Act 3: remote hangup -> real teardown --------------------------
    rpc.emit('callEvent', endedEvent(callId, { reason: 'RemoteHangup' }));

    await vi.waitFor(() => expect(runtime.activeSessionCount).toBe(0));
    expect(transport.disconnectCount).toBe(1);

    await vi.waitFor(() => {
      const ended = busEvents.filter(
        (e): e is BusEvent & { payload: { sessionId: string } } =>
          e.type === 'voice.session.ended',
      );
      expect(ended).toHaveLength(1);
      expect(ended[0]!.payload.sessionId).toBe(sessionId);
    });
  });
});
