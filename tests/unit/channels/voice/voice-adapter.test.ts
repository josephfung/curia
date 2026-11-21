import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, EventType, Layer } from '../../../../src/bus/events.js';
import type { VoiceSessionStore } from '../../../../src/channels/voice/session-store.js';
import type { VoiceRuntime } from '../../../../src/channels/voice/voice-runtime.js';
import { VoiceSessionBridge } from '../../../../src/channels/voice/session-bridge.js';
import { VoiceAdapter } from '../../../../src/channels/voice/voice-adapter.js';
import { mintVoiceParticipantToken } from '../../../../src/channels/voice/livekit/token.js';
import { partnerCaller, principalCaller } from '../../../../src/channels/voice/test-fixtures.js';
import type { AgendaStore } from '../../../../src/meetings/agenda-store.js';
import type { AgendaDoc } from '../../../../src/meetings/types.js';

// Mock JWT minting so tests don't need real keys and can simulate a signing
// failure on the agent token (the second mint) independently of the principal.
vi.mock('../../../../src/channels/voice/livekit/token.js', () => ({
  mintVoiceParticipantToken: vi.fn(async (_creds: unknown, opts: { identity: string }) => `token-${opts.identity}`),
}));

const logger = pino({ level: 'silent' });
const PRINCIPAL_ID = '11111111-1111-1111-1111-111111111111';

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
    callerContactId?: string;
    metadata?: Record<string, unknown>;
  }) => ({
    id: input.id ?? 'session-1',
    conversationId: input.conversationId,
    livekitRoom: input.livekitRoom,
    callerContactId: input.callerContactId ?? null,
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
    callerContactId: null,
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
  it('installs a handler that creates sessions, mints a token with the resolved contact id, and publishes started', async () => {
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

    const caller = principalCaller();
    const result = await handler!.createSession({
      caller,
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
      callerContactId: PRINCIPAL_ID,
      metadata: { source: 'test' },
    }));
    expect(mintVoiceParticipantToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identity: PRINCIPAL_ID, name: 'Joseph' }),
    );
    expect(runtime.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ caller }),
    );
    expect(publish.mock.calls[0]![0]).toBe('channel');
    expect(publish.mock.calls[0]![1].type).toBe('voice.session.started');
  });

  it('mints LiveKit identity from a non-principal contact id (not the literal principal)', async () => {
    const bridge = new VoiceSessionBridge();
    const { bus } = fakeBus();
    const { store } = fakeStore();
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

    const caller = partnerCaller();
    await bridge.getHandler()!.createSession({ caller });

    expect(mintVoiceParticipantToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: caller.contactId,
        name: 'Alex Partner',
      }),
    );
    // Must not mint the hardcoded 'principal' identity.
    const identities = vi.mocked(mintVoiceParticipantToken).mock.calls
      .map(c => c[1]?.identity)
      .filter(id => id !== 'curia-agent');
    expect(identities).not.toContain('principal');
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
      caller: principalCaller(),
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
      caller: principalCaller(),
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

  // #2359: console and PWA calls start from a parked agenda the same way a
  // Signal call does, through the shared helpers in session-agendas.ts.
  describe('parked agendas', () => {
    const agendaId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    function parkedAgenda(): AgendaDoc {
      return {
        path: `/meetings/agendas/${agendaId}.md`,
        version: 1,
        agendaId,
        title: 'Board prep',
        topics: ['runway'],
        role: null,
        context: 'Cover the runway.',
        source: 'principal',
        sensitivity: 'internal',
        scheduledFor: null,
        history: [],
        status: 'pending',
        expiresAt: '2099-11-04T16:00:00.000Z',
        inCallSession: null,
        calendarEventId: null,
        calendarId: null,
        ownerTaskId: null,
        nudgedAt: null,
        eventState: null,
      };
    }

    function fakeAgendaStore() {
      const doc = parkedAgenda();
      const cullExpired = vi.fn(async () => 0);
      const listPending = vi.fn(async () => [doc]);
      const lock = vi.fn(async () => ({ ok: true as const, agenda: doc }));
      const settle = vi.fn(async () => 'settled' as const);
      return {
        store: { cullExpired, listPending, lock, settle } as unknown as AgendaStore,
        cullExpired,
        listPending,
        lock,
        settle,
      };
    }

    async function startedAdapter(agendaStore: AgendaStore, store = fakeStore().store, bus = fakeBus().bus) {
      const bridge = new VoiceSessionBridge();
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
        agendaStore,
      });
      await adapter.start();
      return { handler: bridge.getHandler()!, runtime };
    }

    it('a principal call locks the due agenda, records the preload and starts from it', async () => {
      const agendas = fakeAgendaStore();
      const { store, create } = fakeStore();
      const { handler, runtime } = await startedAdapter(agendas.store, store);

      const result = await handler.createSession({ caller: principalCaller() });

      expect(result.status).toBe(201);
      const sessionId = create.mock.calls[0]![0].id;
      // The lock records this session, so session-ended settles it (pending → in_call → done).
      expect(agendas.lock).toHaveBeenCalledWith(agendaId, sessionId, expect.any(Date));
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { agendas: [expect.objectContaining({ agendaId })] },
      }));
      const start = vi.mocked(runtime.startSession).mock.calls[0]![0];
      expect(start.agendas?.loaded).toEqual([expect.objectContaining({ agendaId, title: 'Board prep' })]);
      expect(start.agendas?.index).toEqual([]);
    });

    it('a non-principal caller never loads principal agendas', async () => {
      const agendas = fakeAgendaStore();
      const { store, create } = fakeStore();
      const { handler, runtime } = await startedAdapter(agendas.store, store);

      await handler.createSession({ caller: partnerCaller(), metadata: { source: 'test' } });

      expect(agendas.cullExpired).not.toHaveBeenCalled();
      expect(agendas.listPending).not.toHaveBeenCalled();
      expect(agendas.lock).not.toHaveBeenCalled();
      expect(create.mock.calls[0]![0].metadata).toEqual({ source: 'test' });
      expect(vi.mocked(runtime.startSession).mock.calls[0]![0].agendas).toBeUndefined();
    });

    it('releases the lock when the session row cannot be created', async () => {
      const agendas = fakeAgendaStore();
      const { store, create } = fakeStore();
      create.mockRejectedValueOnce(new Error('insert failed'));
      const { handler, runtime } = await startedAdapter(agendas.store, store);

      await expect(handler.createSession({ caller: principalCaller() })).rejects.toThrow('insert failed');

      const sessionId = create.mock.calls[0]![0].id;
      expect(agendas.settle).toHaveBeenCalledWith(agendaId, sessionId, { kind: 'return' });
      expect(runtime.startSession).not.toHaveBeenCalled();
    });

    it('releases the lock and ends the row when voice.session.started cannot be published', async () => {
      // A failed publish means the bus is down, so the ended event that would
      // normally let the minutes pipeline settle the lock may never arrive.
      const agendas = fakeAgendaStore();
      const { store, create } = fakeStore();
      const { bus, publish } = fakeBus();
      publish.mockRejectedValueOnce(new Error('audit write failed'));
      const { handler, runtime } = await startedAdapter(agendas.store, store, bus);

      const result = await handler.createSession({ caller: principalCaller() });

      expect(result.status).toBe(500);
      const sessionId = create.mock.calls[0]![0].id;
      expect(agendas.settle).toHaveBeenCalledWith(agendaId, sessionId, { kind: 'return' });
      expect(runtime.endSession).toHaveBeenCalledWith(sessionId, 'runtime_start_failed');
      expect(runtime.startSession).not.toHaveBeenCalled();
    });

    it('drops a client-supplied agendas key from a non-principal row', async () => {
      const agendas = fakeAgendaStore();
      const { store, create } = fakeStore();
      const { handler } = await startedAdapter(agendas.store, store);

      await handler.createSession({ caller: partnerCaller(), metadata: { source: 'test', agendas: ['forged'] } });

      expect(create.mock.calls[0]![0].metadata).toEqual({ source: 'test' });
    });
  });
});
