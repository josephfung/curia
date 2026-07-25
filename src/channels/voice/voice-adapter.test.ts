import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { EventBus } from '../../bus/bus.js';
import type { BusEvent, EventType, Layer } from '../../bus/events.js';
import type { VoiceSessionStore } from './session-store.js';
import type { VoiceRuntime } from './voice-runtime.js';
import { VoiceSessionBridge } from './session-bridge.js';
import { VoiceAdapter } from './voice-adapter.js';
import { mintVoiceParticipantToken } from './livekit/token.js';

// Mock JWT minting so tests don't need real keys and can simulate a signing
// failure on the agent token (the second mint) independently of the principal.
vi.mock('./livekit/token.js', () => ({
  mintVoiceParticipantToken: vi.fn(async (_creds: unknown, opts: { identity: string }) => `token-${opts.identity}`),
}));

const logger = pino({ level: 'silent' });

beforeEach(() => {
  // Reset to the default resolving implementation before every test so a
  // per-test rejection override does not leak into the next case.
  vi.mocked(mintVoiceParticipantToken).mockImplementation(
    async (_creds: unknown, opts: { identity: string }) => `token-${opts.identity}`,
  );
});

function fakeBus() {
  const publish = vi.fn<(_layer: Layer, _event: BusEvent) => Promise<void>>().mockResolvedValue(undefined);
  const subscribe = vi.fn<(_type: EventType, _layer: Layer, _handler: (event: BusEvent) => unknown) => void>();
  return {
    bus: { publish, subscribe } as unknown as EventBus,
    publish,
    subscribe,
  };
}

function fakeStore() {
  const startedAt = new Date('2026-07-25T15:00:00Z');
  const endedAt = new Date('2026-07-25T15:00:05Z');
  const create = vi.fn(async (input: {
    id?: string;
    conversationId: string;
    livekitRoom: string;
    principalContactId?: string;
    metadata?: Record<string, unknown>;
  }) => ({
    id: input.id ?? 'session-1',
    conversationId: input.conversationId,
    livekitRoom: input.livekitRoom,
    principalContactId: input.principalContactId ?? null,
    status: 'starting' as const,
    startedAt,
    endedAt: null,
    endReason: null,
    metadata: input.metadata ?? {},
  }));
  const endSession = vi.fn(async (id: string, reason: string) => ({
    id,
    conversationId: `voice:${id}`,
    livekitRoom: `voice-${id}`,
    principalContactId: null,
    status: 'ended' as const,
    startedAt,
    endedAt,
    endReason: reason,
    metadata: {},
  }));
  return {
    store: { create, endSession } as unknown as VoiceSessionStore,
    create,
    endSession,
  };
}

function fakeRuntime(): VoiceRuntime {
  return {
    startSession: vi.fn(async () => undefined),
    endSession: vi.fn(async () => null),
    endAllSessions: vi.fn(async () => undefined),
    configureTools: vi.fn(),
    get activeSessionCount() {
      return 0;
    },
  } as unknown as VoiceRuntime;
}

describe('VoiceAdapter', () => {
  it('installs a handler that creates sessions, mints a token, and publishes started', async () => {
    const bridge = new VoiceSessionBridge();
    const { bus, publish, subscribe } = fakeBus();
    const { store, create } = fakeStore();
    const runtime = fakeRuntime();
    const adapter = new VoiceAdapter({
      bus,
      logger,
      sessionBridge: bridge,
      sessionStore: store,
      livekitUrl: 'wss://voice.example.test',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
      voiceRuntime: runtime,
    });

    await adapter.start();
    expect(subscribe).toHaveBeenCalledWith('outbound.message', 'channel', expect.any(Function));
    const handler = bridge.getHandler();
    expect(handler).not.toBeNull();

    const result = await handler!.createSession({
      principalContactId: '11111111-1111-1111-1111-111111111111',
      metadata: { source: 'test' },
    });

    expect(result.status).toBe(201);
    expect(result.body.livekitUrl).toBe('wss://voice.example.test');
    expect(typeof result.body.token).toBe('string');
    expect(result.body.conversationId).toMatch(/^voice:/);
    expect(result.body.roomName).toMatch(/^voice-/);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: result.body.conversationId,
      livekitRoom: result.body.roomName,
      principalContactId: '11111111-1111-1111-1111-111111111111',
      metadata: { source: 'test' },
    }));
    expect(runtime.startSession).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0]).toBe('channel');
    expect(publish.mock.calls[0]![1].type).toBe('voice.session.started');
  });

  it('rejects session creation when VoiceRuntime is unavailable', async () => {
    const bridge = new VoiceSessionBridge();
    const { bus } = fakeBus();
    const { store, create } = fakeStore();
    const adapter = new VoiceAdapter({
      bus,
      logger,
      sessionBridge: bridge,
      sessionStore: store,
      livekitUrl: 'wss://voice.example.test',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
    });

    await adapter.start();
    const result = await bridge.getHandler()!.createSession({
      principalContactId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/unavailable/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('ends sessions and publishes ended', async () => {
    const bridge = new VoiceSessionBridge();
    const { bus, publish } = fakeBus();
    const { store, endSession } = fakeStore();
    const adapter = new VoiceAdapter({
      bus,
      logger,
      sessionBridge: bridge,
      sessionStore: store,
      livekitUrl: 'wss://voice.example.test',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
    });

    await adapter.start();
    const result = await bridge.getHandler()!.endSession('session-1');

    expect(result.status).toBe(200);
    expect(endSession).toHaveBeenCalledWith('session-1', 'console_hangup');
    const event = publish.mock.calls[0]![1];
    expect(event.type).toBe('voice.session.ended');
    if (event.type === 'voice.session.ended') {
      expect(event.payload.durationMs).toBe(5000);
    }
  });

  it('tears down the session when agent-token minting fails', async () => {
    const bridge = new VoiceSessionBridge();
    const { bus } = fakeBus();
    const { store, create, endSession } = fakeStore();
    const runtime = fakeRuntime();
    // Principal mint succeeds; the agent mint (identity 'curia-agent') throws —
    // by which point the row is persisted and voice.session.started is on the bus.
    vi.mocked(mintVoiceParticipantToken).mockImplementation(async (_creds, opts) => {
      if (opts.identity === 'curia-agent') throw new Error('jwt signing failed');
      return `token-${opts.identity}`;
    });

    const adapter = new VoiceAdapter({
      bus,
      logger,
      sessionBridge: bridge,
      sessionStore: store,
      livekitUrl: 'wss://voice.example.test',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
      voiceRuntime: runtime,
    });

    await adapter.start();
    const result = await bridge.getHandler()!.createSession({
      principalContactId: '11111111-1111-1111-1111-111111111111',
    });

    // Fail closed with 500; the runtime loop is never started; and the persisted
    // session is ended (via runtime.endSession) so it can't linger in 'starting'.
    expect(result.status).toBe(500);
    expect(create).toHaveBeenCalledOnce();
    // The session id is a randomUUID minted by the adapter — assert the same id
    // that was persisted is the one torn down.
    const createdId = create.mock.calls[0]![0].id;
    expect(runtime.startSession).not.toHaveBeenCalled();
    expect(runtime.endSession).toHaveBeenCalledWith(createdId, 'runtime_start_failed');
    // Teardown is delegated to the runtime (which owns store.endSession + the
    // ended event), so the adapter does not call the store directly here.
    expect(endSession).not.toHaveBeenCalled();
  });
});
