import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../logger.js';
import type { Logger } from '../../../logger.js';
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

/**
 * Stub pino-shaped logger with spyable level methods. The bridge only uses
 * child() + the four level methods, so this is a safe stand-in when a test
 * needs to assert a warn/info was emitted (createSilentLogger has no spies).
 */
function stubLogger() {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger: Record<string, unknown> = { debug, info, warn, error };
  logger.child = vi.fn(() => logger);
  return { logger: logger as unknown as Logger, debug, info, warn, error };
}

interface SetupOptions {
  resolveImpl?: (channel: string, senderId: string) => Promise<InboundSenderContext>;
  maxCallSeconds?: number;
  /** Override sessionStore.create (e.g. reject, or hang forever). */
  createImpl?: (input: CreateVoiceSessionInput) => Promise<unknown>;
  /** Override voiceRuntime.startSession (e.g. hang forever to exercise the setup-window race). */
  startSessionImpl?: (params: FakeStartSessionCall) => Promise<void>;
  logger?: Logger;
}

function setup(opts: SetupOptions = {}) {
  const rpc = new FakeRpcClient();

  const startSession = vi.fn(opts.startSessionImpl ?? (async (_params: FakeStartSessionCall) => undefined));
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

  const defaultCreateImpl = async (input: CreateVoiceSessionInput): Promise<unknown> => ({
    id: input.id ?? randomUUID(),
    conversationId: input.conversationId,
    livekitRoom: input.livekitRoom,
    principalContactId: input.principalContactId ?? null,
    status: 'starting' as const,
    startedAt: new Date('2026-08-20T12:00:00Z'),
    endedAt: null,
    endReason: null,
    metadata: input.metadata ?? {},
  });
  const create = vi.fn<(input: CreateVoiceSessionInput) => Promise<unknown>>(opts.createImpl ?? defaultCreateImpl);
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
    logger: opts.logger ?? createSilentLogger(),
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
      // The resolved contactId is a real UUID, so it passes the UUID_RE gate
      // and is persisted as principal_contact_id.
      principalContactId: '33333333-3333-3333-3333-333333333333',
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
    const { bridge, rpc, startSession, create } = setup({
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
    // Unknown caller's contactId is the E.164 number (not a UUID) — the
    // UUID-only principal_contact_id column must stay unset.
    expect(create.mock.calls[0]![0].principalContactId).toBeUndefined();
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

  it('ignores a redundant CONNECTED for the already-active call (RingRTC reconnect) instead of hanging up', async () => {
    const { bridge, rpc, startSession, endSession } = setup();
    bridge.start();
    const callId = 81n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    // Network blip recovery: RECONNECTING → CONNECTED again for the SAME call.
    rpc.emit('callEvent', connectedEvent(callId));
    // Give the async handler a chance to run fully.
    await new Promise(resolve => setImmediate(resolve));

    expect(rpc.hangupCall).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
    // No second session was started — the call is still the original one.
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('cleans up (hangupCall, no session start) when sessionStore.create rejects mid-CONNECTED', async () => {
    const { bridge, rpc, startSession, endSession } = setup({
      createImpl: async () => {
        throw new Error('db down');
      },
    });
    bridge.start();
    const callId = 82n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));

    await vi.waitFor(() => expect(rpc.hangupCall).toHaveBeenCalledWith(callId));
    expect(startSession).not.toHaveBeenCalled();
    // No row was created, so no endSession call either — nothing to end.
    expect(endSession).not.toHaveBeenCalled();

    // State must be fully cleared: a fresh incoming call is accepted, not
    // busy-rejected (which would mean the failed call leaked into pending).
    const nextCallId = 83n;
    rpc.emit('callEvent', ringingEvent(nextCallId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(nextCallId));
  });

  it('logs a warning instead of an unhandled rejection when rejectCall fails on the busy path', async () => {
    const { logger, warn } = stubLogger();
    const { bridge, rpc, startSession } = setup({ logger });
    bridge.start();
    const activeCallId = 84n;
    const busyCallId = 85n;

    rpc.emit('callEvent', ringingEvent(activeCallId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(activeCallId));
    rpc.emit('callEvent', connectedEvent(activeCallId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    rpc.rejectCall.mockRejectedValueOnce(new Error('rpc socket write failed'));
    rpc.emit('callEvent', ringingEvent(busyCallId));

    // The rejection must be swallowed into a warn log — vitest fails the run
    // on any unhandled rejection, so reaching this assertion IS the guarantee.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ what: 'rejectCall', callId: busyCallId.toString() }),
        expect.any(String),
      );
    });
  });

  it('keeps rejecting busy while a CONNECTED session setup is still in flight', async () => {
    // sessionStore.create hangs forever — call A is mid-setup: not yet active,
    // and (pre-fix) already deleted from pending. The busy invariant must hold.
    const { bridge, rpc, create, startSession } = setup({
      createImpl: () => new Promise(() => undefined),
    });
    bridge.start();
    const callA = 86n;
    const callB = 87n;

    rpc.emit('callEvent', ringingEvent(callA));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callA));
    rpc.emit('callEvent', connectedEvent(callA));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    rpc.emit('callEvent', ringingEvent(callB));
    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(callB));
    expect(rpc.acceptCall).not.toHaveBeenCalledWith(callB);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('processes only one of two same-tick CONNECTED events for the same call', async () => {
    // sessionStore.create is deferred: both CONNECTED events land before the
    // first handler's first await resolves, so `active` is still null and the
    // pending entry still present for both — only the `connecting` reentrance
    // guard separates them.
    let resolveCreate!: () => void;
    const { bridge, rpc, create, startSession } = setup({
      createImpl: (input: CreateVoiceSessionInput) =>
        new Promise(resolve => {
          resolveCreate = () =>
            resolve({
              id: input.id ?? 'session-dup',
              conversationId: input.conversationId,
              livekitRoom: input.livekitRoom,
              principalContactId: input.principalContactId ?? null,
              status: 'starting' as const,
              startedAt: new Date('2026-08-20T12:00:00Z'),
              endedAt: null,
              endReason: null,
              metadata: input.metadata ?? {},
            });
        }),
    });
    bridge.start();
    const callId = 90n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));

    // Two CONNECTED back-to-back in the same tick (fast flap / duplicate
    // delivery), before the hung sessionStore.create resolves.
    rpc.emit('callEvent', connectedEvent(callId));
    rpc.emit('callEvent', connectedEvent(callId));

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    resolveCreate();
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    // Let any second (buggy) setup surface before asserting exactly-once.
    await new Promise(resolve => setImmediate(resolve));
    expect(create).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(rpc.hangupCall).not.toHaveBeenCalled();
  });

  it('aborts session start when ENDED arrives while setup awaits are in flight', async () => {
    let resolveCreate!: () => void;
    const { bridge, rpc, create, startSession, endSession } = setup({
      createImpl: (input: CreateVoiceSessionInput) =>
        new Promise(resolve => {
          resolveCreate = () =>
            resolve({
              id: input.id ?? 'session-aborted',
              conversationId: input.conversationId,
              livekitRoom: input.livekitRoom,
              principalContactId: input.principalContactId ?? null,
              status: 'starting' as const,
              startedAt: new Date('2026-08-20T12:00:00Z'),
              endedAt: null,
              endReason: null,
              metadata: input.metadata ?? {},
            });
        }),
    });
    bridge.start();
    const callId = 91n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    // Caller hangs up while sessionStore.create is still pending.
    rpc.emit('callEvent', endedEvent(callId));
    resolveCreate();

    // The already-created row is ended; no session starts for the dead call.
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledWith(expect.any(String), 'remote_hangup'));
    expect(startSession).not.toHaveBeenCalled();
    // Remote already hung up — nothing for us to hang up.
    expect(rpc.hangupCall).not.toHaveBeenCalled();

    // State is clean: a fresh call is accepted, not busy-rejected.
    const nextCallId = 92n;
    rpc.emit('callEvent', ringingEvent(nextCallId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(nextCallId));
  });

  it('clears pending calls on RPC disconnect so the next call is not busy-rejected', async () => {
    const { bridge, rpc } = setup();
    bridge.start();
    const staleCallId = 88n;
    const freshCallId = 89n;

    // Call accepted but CONNECTED never arrives — then the socket drops.
    rpc.emit('callEvent', ringingEvent(staleCallId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(staleCallId));
    rpc.emit('disconnected');

    // After reconnect a new call rings: it must be accepted, not busy-rejected
    // because of the stale pending entry (which would wedge the channel).
    rpc.emit('callEvent', ringingEvent(freshCallId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(freshCallId));
    expect(rpc.rejectCall).not.toHaveBeenCalled();
  });

  // CodeRabbit #3: an accepted-but-never-connected call whose CONNECTED/ENDED
  // is lost while the socket stays up must not wedge the channel forever — a
  // bounded backstop timer drops it and hangs up, freeing the busy check.
  it('expires a pending call that never reaches CONNECTED/ENDED, freeing the busy check', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, rpc } = setup();
      bridge.start();
      const stuckCallId = 90n;
      const nextCallId = 91n;

      rpc.emit('callEvent', ringingEvent(stuckCallId));
      await vi.advanceTimersByTimeAsync(0);
      expect(rpc.acceptCall).toHaveBeenCalledWith(stuckCallId);

      // No CONNECTED, no ENDED, socket stays up. A new ring right now is
      // correctly busy-rejected (one call at a time).
      rpc.emit('callEvent', ringingEvent(nextCallId));
      await vi.advanceTimersByTimeAsync(0);
      expect(rpc.rejectCall).toHaveBeenCalledWith(nextCallId);
      expect(rpc.hangupCall).not.toHaveBeenCalled();

      // After the backstop elapses, the stuck entry is dropped + hung up...
      await vi.advanceTimersByTimeAsync(90_000);
      expect(rpc.hangupCall).toHaveBeenCalledWith(stuckCallId);

      // ...and the channel is free again: the next ring is accepted, not busy.
      rpc.rejectCall.mockClear();
      const laterCallId = 92n;
      rpc.emit('callEvent', ringingEvent(laterCallId));
      await vi.advanceTimersByTimeAsync(0);
      expect(rpc.acceptCall).toHaveBeenCalledWith(laterCallId);
      expect(rpc.rejectCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // CodeRabbit #3 companion: a call that DOES connect must cancel its pending
  // backstop, so the timer never fires against a now-active/ended call.
  it('cancels the pending backstop once a call connects', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, rpc, startSession } = setup();
      bridge.start();
      const callId = 93n;

      rpc.emit('callEvent', ringingEvent(callId));
      await vi.advanceTimersByTimeAsync(0);
      rpc.emit('callEvent', connectedEvent(callId));
      await vi.advanceTimersByTimeAsync(0);
      expect(startSession).toHaveBeenCalledTimes(1);

      // Elapse well past the pending backstop: it must NOT hang up the call
      // (the cap timer, not the pending timer, governs a connected call).
      await vi.advanceTimersByTimeAsync(90_000);
      expect(rpc.hangupCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // C2: caller-resolution throw must reject the call rather than leaving it
  // in limbo (an unguarded throw would bubble to onCallEvent's catch-all,
  // which only error-logs — no rejectCall is ever sent).
  it('rejects the call instead of leaving it in limbo when caller resolution throws', async () => {
    const { bridge, rpc } = setup({
      resolveImpl: async () => {
        throw new Error('contact resolver DB blip');
      },
    });
    bridge.start();
    const callId = 95n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(callId));
    expect(rpc.acceptCall).not.toHaveBeenCalled();
  });

  // I5: acceptCall itself failing (after a successful caller resolution)
  // must also send an explicit reject, for consistency with every other
  // rejection path in handleRingingIncoming.
  it('rejects the call when acceptCall fails after a successful caller resolution', async () => {
    const { bridge, rpc } = setup();
    rpc.acceptCall.mockRejectedValueOnce(new Error('rpc socket write failed'));
    bridge.start();
    const callId = 96n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(callId));
  });

  // I3: the busy check races two RINGING_INCOMING events for different
  // callIds landing in the same synchronous burst — the pending reservation
  // only happens after resolveSignalVoiceCaller's await, so without a
  // synchronous reservation both would pass the busy check.
  it('busy-rejects a second RINGING for a different callId that arrives synchronously while the first is still resolving', async () => {
    let resolveFirst!: (v: InboundSenderContext) => void;
    let resolveCalls = 0;
    const resolveImpl = async (): Promise<InboundSenderContext> => {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        return new Promise<InboundSenderContext>(resolve => {
          resolveFirst = resolve;
        });
      }
      return resolvedSenderContext();
    };
    const { bridge, rpc } = setup({ resolveImpl });
    bridge.start();
    const callA = 100n;
    const callB = 101n;

    // Both emitted synchronously, back-to-back, before callA's
    // resolveSignalVoiceCaller promise has a chance to settle.
    rpc.emit('callEvent', ringingEvent(callA));
    rpc.emit('callEvent', ringingEvent(callB));

    await vi.waitFor(() => expect(rpc.rejectCall).toHaveBeenCalledWith(callB));
    expect(rpc.acceptCall).not.toHaveBeenCalledWith(callB);

    resolveFirst(resolvedSenderContext());
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callA));
    expect(rpc.rejectCall).not.toHaveBeenCalledWith(callA);
  });

  // Prod bug (2026-08-20): signal-cli re-emits RINGING_INCOMING for the SAME
  // call while it rings. The busy check treated the repeat as a competing call
  // and rejected it — tearing down the very call being answered. A duplicate
  // for a call already in flight must be ignored (no reject), not busy-rejected.
  it('ignores a duplicate RINGING_INCOMING for the same call still resolving (no self-reject)', async () => {
    let resolveFirst!: (v: InboundSenderContext) => void;
    let resolveCalls = 0;
    const resolveImpl = async (): Promise<InboundSenderContext> => {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        // Hold the first handler open in its resolve await so the duplicate
        // lands while the callId is still in `ringing` (not yet pending).
        return new Promise<InboundSenderContext>(resolve => {
          resolveFirst = resolve;
        });
      }
      return resolvedSenderContext();
    };
    const { bridge, rpc, startSession } = setup({ resolveImpl });
    bridge.start();
    const callId = 110n;

    // Two RINGING_INCOMING for the SAME callId, back-to-back in one tick —
    // the second arrives before the first's resolve settles.
    rpc.emit('callEvent', ringingEvent(callId));
    rpc.emit('callEvent', ringingEvent(callId));

    // The duplicate must NOT have been rejected — it's the same call.
    await new Promise(resolve => setImmediate(resolve));
    expect(rpc.rejectCall).not.toHaveBeenCalled();

    // The one real handler proceeds: accept exactly once, then CONNECTED
    // starts a session — proving the call survived the duplicate.
    resolveFirst(resolvedSenderContext());
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    expect(rpc.acceptCall).toHaveBeenCalledTimes(1);

    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(rpc.rejectCall).not.toHaveBeenCalled();
  });

  it('ignores a duplicate RINGING_INCOMING for a call already pending accept (no self-reject)', async () => {
    const { bridge, rpc, startSession } = setup();
    bridge.start();
    const callId = 111n;

    // First ring is accepted and sits in `pending` awaiting CONNECTED.
    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));

    // signal-cli re-emits RINGING for the same call before CONNECTED — must be
    // ignored, not busy-rejected (which would hang up the accepted call).
    rpc.emit('callEvent', ringingEvent(callId));
    await new Promise(resolve => setImmediate(resolve));
    expect(rpc.rejectCall).not.toHaveBeenCalled();
    expect(rpc.acceptCall).toHaveBeenCalledTimes(1);

    // The call still connects normally.
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
  });

  // I1: ENDED arriving in the window between `active` being assigned and
  // `startSession` resolving must not orphan a runtime session — the
  // teardown has to happen AFTER startSession registers it, not before.
  it('tears down a session that finishes registering after ENDED arrived mid-startSession (no zombie session, no cap timer leak)', async () => {
    let resolveStartSession!: () => void;
    const { bridge, rpc, startSession, endSession } = setup({
      startSessionImpl: () =>
        new Promise<void>(resolve => {
          resolveStartSession = resolve;
        }),
    });
    bridge.start();
    const callId = 97n;

    rpc.emit('callEvent', ringingEvent(callId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(callId));
    rpc.emit('callEvent', connectedEvent(callId));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    const sessionId = startSession.mock.calls[0]![0].sessionId;

    // Caller hangs up while startSession (STT connect, etc.) is still
    // pending — `active` (with its capTimer) was already assigned before
    // this await started, so this exercises the later setup-window race,
    // distinct from the earlier row/publish window covered by the "aborts
    // session start" test above.
    rpc.emit('callEvent', endedEvent(callId));
    await new Promise(resolve => setImmediate(resolve));

    // Not torn down yet — the session isn't registered in the runtime's
    // session map until startSession resolves, so tearing down now would be
    // a no-op against a session that doesn't exist yet.
    expect(endSession).not.toHaveBeenCalled();

    resolveStartSession();
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledWith(sessionId, 'remote_hangup'));

    // No cap timer / active leak: a fresh call is accepted, not
    // busy-rejected by a zombie `active` entry from the orphaned session.
    const nextCallId = 98n;
    rpc.emit('callEvent', ringingEvent(nextCallId));
    await vi.waitFor(() => expect(rpc.acceptCall).toHaveBeenCalledWith(nextCallId));
  });
});
