import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../logger.js';
import type { ContactResolver } from '../../../contacts/contact-resolver.js';
import type { InboundSenderContext, SenderContext } from '../../../contacts/types.js';
import type { BusEvent, Layer } from '../../../bus/events.js';
import type { EventBus } from '../../../bus/bus.js';
import type { SignalCallEvent } from '../../signal/call-types.js';
import type { SignalRpcClient } from '../../signal/signal-rpc-client.js';
import type { VoiceRuntime } from '../voice-runtime.js';
import type { CreateVoiceSessionInput, VoiceSessionStore } from '../session-store.js';
import type { SignalAudioTransportOpts } from './signal-audio-transport.js';
import { SignalCallBridge } from './signal-call-bridge.js';

/**
 * Subset of VoiceRuntime.startSession's params relevant to assertions —
 * StartVoiceSessionParams itself isn't exported from voice-runtime.ts, and
 * typing the fake mock's parameter (rather than leaving it inferred as `()`)
 * is what gives `.mock.calls[0][0]` a real shape instead of `undefined`.
 */
interface FakeStartSessionCall {
  sessionId: string;
  conversationId: string;
  roomName: string;
  caller: { tier: string; liveTurn: boolean };
  transport: unknown;
  openingGreeting?: boolean;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_NUMBER = '+15196161377';

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

function resolvedSenderContext(overrides: Partial<SenderContext> = {}): SenderContext {
  return {
    resolved: true,
    contactId: '33333333-3333-3333-3333-333333333333',
    displayName: 'Caller Contact',
    role: null,
    systemRole: null,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 0.8,
    tier: 'trusted',
    kind: 'person',
    ...overrides,
  };
}

function unresolvedSenderContext(): InboundSenderContext {
  return { resolved: false, channel: 'signal', senderId: DEFAULT_NUMBER };
}

/** Fake signal-cli RPC client: a real EventEmitter (so listenerCount/on/off
 * behave exactly like the production client) with vi.fn() call methods. */
class FakeRpcClient extends EventEmitter {
  setCallEventsSubscription = vi.fn();
  acceptCall = vi.fn(async (_callId: bigint) => undefined);
  rejectCall = vi.fn(async (_callId: bigint) => undefined);
  hangupCall = vi.fn(async (_callId: bigint) => undefined);
}

/** Fake AudioTransport + notifyRemoteHangup, standing in for SignalAudioTransport. */
class FakeCallTransport {
  notifyRemoteHangup = vi.fn();
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => undefined);
  onRemoteAudio = vi.fn();
  onClose = vi.fn();
  publishAudio = vi.fn(async () => undefined);
}

interface SetupOptions {
  resolveImpl?: (channel: string, senderId: string) => Promise<InboundSenderContext>;
  maxCallSeconds?: number;
}

function setup(opts: SetupOptions = {}) {
  const rpc = new FakeRpcClient();

  const startSession = vi.fn(async (_params: FakeStartSessionCall) => undefined);
  const endSession = vi.fn(async (_sessionId: string, _reason: string) => null);
  const runtime = {
    startSession,
    endSession,
    endAllSessions: vi.fn(async () => undefined),
    configureTools: vi.fn(),
    get activeSessionCount() {
      return 0;
    },
  } as unknown as VoiceRuntime;

  const create = vi.fn(async (input: CreateVoiceSessionInput) => ({
    id: input.id ?? randomUUID(),
    conversationId: input.conversationId,
    livekitRoom: input.livekitRoom,
    principalContactId: input.principalContactId ?? null,
    status: 'starting' as const,
    startedAt: new Date('2026-08-20T12:00:00Z'),
    endedAt: null,
    endReason: null,
    metadata: input.metadata ?? {},
  }));
  const store = { create } as unknown as VoiceSessionStore;

  const publish = vi.fn(async (_layer: Layer, _event: BusEvent) => undefined);
  const bus = { publish, subscribe: vi.fn() } as unknown as EventBus;

  const resolveImpl = opts.resolveImpl ?? (async () => resolvedSenderContext());
  const contactResolver = { resolve: vi.fn(resolveImpl) } as unknown as ContactResolver;

  const transports: FakeCallTransport[] = [];
  const createTransport = vi.fn((_transportOpts: SignalAudioTransportOpts) => {
    const t = new FakeCallTransport();
    transports.push(t);
    return t;
  });

  const bridge = new SignalCallBridge({
    bus,
    logger: createSilentLogger(),
    rpcClient: rpc as unknown as SignalRpcClient,
    contactResolver,
    voiceRuntime: runtime,
    sessionStore: store,
    pulseServer: '/run/pulse/native',
    maxCallSeconds: opts.maxCallSeconds,
    createTransport,
  });

  return { bridge, rpc, startSession, endSession, create, publish, transports, createTransport };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignalCallBridge', () => {
  it('subscribes for call events on start', () => {
    const { bridge, rpc } = setup();

    bridge.start();

    expect(rpc.setCallEventsSubscription).toHaveBeenCalledWith(true);
    expect(rpc.listenerCount('callEvent')).toBe(1);
    expect(rpc.listenerCount('disconnected')).toBe(1);

    // Idempotent — calling start() again must not double-subscribe or attach
    // a second pair of listeners.
    bridge.start();
    expect(rpc.setCallEventsSubscription).toHaveBeenCalledTimes(1);
    expect(rpc.listenerCount('callEvent')).toBe(1);
    expect(rpc.listenerCount('disconnected')).toBe(1);
  });

  it('accepts a ringing call for a resolvable caller and starts a runtime session on CONNECTED with the signal transport', async () => {
    const { bridge, rpc, startSession, transports } = setup();
    bridge.start();
    const callId = 42n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    expect(rpc.rejectCall).not.toHaveBeenCalled();

    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    expect(transports).toHaveLength(1);
    const call = startSession.mock.calls[0]![0];
    expect(call.transport).toBe(transports[0]);
    expect(call.openingGreeting).toBe(true);
    expect(call.roomName).toBe(`signal-call:${callId.toString()}`);
  });

  it('persists a voice_sessions row with channel=signal metadata and publishes voice.session.started', async () => {
    const { bridge, rpc, create, publish } = setup({
      resolveImpl: async () => resolvedSenderContext({ tier: 'trusted' }),
    });
    bridge.start();
    const callId = 99n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: expect.stringMatching(/^voice:/),
      livekitRoom: `signal-call:${callId.toString()}`,
      metadata: {
        channel: 'signal',
        callerNumber: DEFAULT_NUMBER,
        callId: callId.toString(),
        tier: 'trusted',
      },
    }));

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]![0]).toBe('channel');
    expect(publish.mock.calls[0]![1].type).toBe('voice.session.started');
  });

  it('rejects a second incoming call while one is active (busy)', async () => {
    const { bridge, rpc, startSession } = setup();
    bridge.start();
    const firstId = 1n;
    const secondId = 2n;

    rpc.emit('callEvent', ringingEvent(firstId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(firstId));
    rpc.emit('callEvent', connectedEvent(firstId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    rpc.emit('callEvent', ringingEvent(secondId));
    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(secondId));
    expect(rpc.acceptCall).not.toHaveBeenCalledWith(secondId);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('rejects blocked callers and never accepts', async () => {
    const { bridge, rpc } = setup({
      resolveImpl: async () => resolvedSenderContext({ tier: 'blocked' }),
    });
    bridge.start();
    const callId = 7n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(callId));
    expect(rpc.acceptCall).not.toHaveBeenCalled();
  });

  it('rejects uuid-only callers (no_identifier)', async () => {
    const { bridge, rpc } = setup();
    bridge.start();
    const callId = 8n;

    rpc.emit('callEvent', ringingEvent(callId, { number: null, uuid: 'some-signal-aci-uuid' }));
    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(callId));
    expect(rpc.acceptCall).not.toHaveBeenCalled();
  });

  it('admits an unknown caller with tier unknown and liveTurn false (answer-everyone)', async () => {
    const { bridge, rpc, startSession } = setup({
      resolveImpl: async () => unresolvedSenderContext(),
    });
    bridge.start();
    const callId = 11n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    const call = startSession.mock.calls[0]![0];
    expect(call.caller.tier).toBe('unknown');
    expect(call.caller.liveTurn).toBe(false);
  });

  it('hangs up instead of starting a session when CONNECTED arrives without a pending accept', async () => {
    const { bridge, rpc, startSession } = setup();
    bridge.start();
    const callId = 13n;

    // No prior RINGING_INCOMING — nothing in `pending` for this callId.
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(rpc.hangupCall).toHaveBeenCalledWith(callId));
    expect(startSession).not.toHaveBeenCalled();
  });

  it('on ENDED notifies the transport (remote hangup) and ends the runtime session', async () => {
    const { bridge, rpc, startSession, endSession, transports } = setup();
    bridge.start();
    const callId = 21n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    const sessionId = startSession.mock.calls[0]![0].sessionId;

    rpc.emit('callEvent', endedEvent(callId));
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledWith(sessionId, 'remote_hangup'));
    expect(transports[0]!.notifyRemoteHangup).toHaveBeenCalledTimes(1);
  });

  it('enforces the max-duration cap: hangupCall + endSession(max_duration)', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, rpc, startSession, endSession } = setup({ maxCallSeconds: 600 });
      bridge.start();
      const callId = 55n;

      rpc.emit('callEvent', ringingEvent(callId));
      await vi.advanceTimersByTimeAsync(0);
      expect(rpc.acceptCall).toHaveBeenCalledWith(callId);

      rpc.emit('callEvent', connectedEvent(callId));
      await vi.advanceTimersByTimeAsync(0);
      expect(startSession).toHaveBeenCalledTimes(1);
      const sessionId = startSession.mock.calls[0]![0].sessionId;

      await vi.advanceTimersByTimeAsync(600_000);
      expect(rpc.hangupCall).toHaveBeenCalledWith(callId);
      expect(endSession).toHaveBeenCalledWith(sessionId, 'max_duration');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the session with rpc_disconnected when the socket drops mid-call', async () => {
    const { bridge, rpc, startSession, endSession } = setup();
    bridge.start();
    const callId = 61n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    const sessionId = startSession.mock.calls[0]![0].sessionId;

    rpc.emit('disconnected');
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledWith(sessionId, 'rpc_disconnected'));
  });

  it('stop() hangs up and ends an active session', async () => {
    const { bridge, rpc, startSession, endSession } = setup();
    bridge.start();
    const callId = 71n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    const sessionId = startSession.mock.calls[0]![0].sessionId;

    await bridge.stop();

    expect(rpc.setCallEventsSubscription).toHaveBeenCalledWith(false);
    expect(rpc.hangupCall).toHaveBeenCalledWith(callId);
    expect(endSession).toHaveBeenCalledWith(sessionId, 'adapter_stop');
    expect(rpc.listenerCount('callEvent')).toBe(0);
    expect(rpc.listenerCount('disconnected')).toBe(0);
  });
});
