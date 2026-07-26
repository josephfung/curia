import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../bus/bus.js';
import type { BusEvent } from '../../bus/events.js';
import { createSilentLogger } from '../../logger.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent, Message } from '../../agents/llm/provider.js';
import { WorkingMemory } from '../../memory/working-memory.js';
import {
  VoiceRuntime,
  VOICE_SYSTEM_ADDENDUM,
  VOICE_TOOL_RESULT_POLICY,
  VOICE_DELEGATION_GUIDANCE,
} from './voice-runtime.js';
import type { VoiceToolBridge } from './voice-runtime.js';
import { FakeAudioTransport } from './fake-audio-transport.js';
import { FakeSttProvider } from './speech/fake-stt.js';
import type { PcmFrame, TextToSpeechProvider, TtsSynthesizeOptions } from './speech/types.js';
import { TtsHttpError } from './speech/types.js';
import type { VoiceSessionRecord, VoiceSessionStore } from './session-store.js';

const logger = createSilentLogger();
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'fake', actualModel: 'fake', providerRequestId: 'req_1' };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const replyScript = (text: string): LLMStreamEvent[] => [
  { type: 'text_delta', text: `${text} ` },
  { type: 'message_end', content: text, usage, provenance },
];

/** Fake streaming LLM provider driven by scripted event sequences. */
class FakeStreamProvider implements LLMProvider {
  readonly id = 'fake-stream';
  /** Messages passed to each stream() call, for context-assembly assertions. */
  readonly seenMessages: Message[][] = [];
  constructor(
    private readonly scripts: LLMStreamEvent[][],
    private readonly delayMs = 0,
  ) {}
  private call = 0;
  async chat(): Promise<LLMResponse> {
    return { type: 'text', content: '', usage, provenance };
  }
  async *stream(params: { messages?: Message[]; options?: Record<string, unknown> }): AsyncIterable<LLMStreamEvent> {
    this.seenMessages.push(params.messages ?? []);
    const script = this.scripts[this.call] ?? [];
    this.call += 1;
    const signal = params.options?.signal as AbortSignal | undefined;
    for (const event of script) {
      if (this.delayMs > 0) await delay(this.delayMs);
      if (signal?.aborted) return;
      yield event;
    }
  }
}

/** TTS that yields many frames slowly, so barge-in can interrupt mid-synthesis. */
class SlowTtsProvider implements TextToSpeechProvider {
  readonly id = 'slow-tts';
  readonly requests: TtsSynthesizeOptions[] = [];
  readonly cancelled = new Set<string>();
  constructor(private readonly frameCount = 20, private readonly perFrameMs = 5) {}
  async *synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame> {
    this.requests.push(opts);
    for (let i = 0; i < this.frameCount; i += 1) {
      await delay(this.perFrameMs);
      if (this.cancelled.has(opts.streamId) || opts.signal?.aborted) return;
      yield { pcm: new Int16Array(160), sampleRate: opts.sampleRate ?? 24000, channels: 1 };
    }
  }
  cancel(streamId: string): void {
    this.cancelled.add(streamId);
  }
}

/** In-memory VoiceSessionStore stand-in. */
function fakeStore(): { store: VoiceSessionStore; statuses: string[]; ended: string[]; endReasons: string[] } {
  const statuses: string[] = [];
  const ended: string[] = [];
  const endReasons: string[] = [];
  const rec = (id: string, status: string, endReason: string | null = null): VoiceSessionRecord => ({
    id,
    conversationId: `voice:${id}`,
    livekitRoom: `voice-${id}`,
    principalContactId: null,
    status: status as VoiceSessionRecord['status'],
    startedAt: new Date(Date.now() - 1000),
    endedAt: status === 'ended' ? new Date() : null,
    endReason: status === 'ended' ? (endReason ?? 'test') : null,
    metadata: {},
  });
  const store = {
    async updateStatus(id: string, status: string) {
      statuses.push(status);
      return rec(id, status);
    },
    async endSession(id: string, reason: string) {
      if (ended.includes(id)) return null;
      ended.push(id);
      endReasons.push(reason);
      return rec(id, 'ended', reason);
    },
  } as unknown as VoiceSessionStore;
  return { store, statuses, ended, endReasons };
}

/** TTS that throws on every synthesize() call (persistent provider failure). */
class FailingTtsProvider implements TextToSpeechProvider {
  readonly id = 'failing-tts';
  readonly failures: string[] = [];
  constructor(private readonly err: Error = new TtsHttpError(500, 'Cartesia TTS request failed with HTTP 500')) {}
  async *synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame> {
    this.failures.push(opts.text);
    throw this.err;
  }
  cancel(): void {}
}

/** TTS that fails a fixed number of times, then synthesizes normally. */
class FlakyThenOkTtsProvider implements TextToSpeechProvider {
  readonly id = 'flaky-tts';
  failures = 0;
  successes = 0;
  constructor(private readonly failCount: number) {}
  async *synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame> {
    if (this.failures < this.failCount) {
      this.failures += 1;
      throw new TtsHttpError(503, 'Cartesia TTS request failed with HTTP 503');
    }
    this.successes += 1;
    yield { pcm: new Int16Array(160), sampleRate: opts.sampleRate ?? 24000, channels: 1 };
  }
  cancel(): void {}
}

function makeRuntime(overrides: {
  llm: LLMProvider;
  tts?: TextToSpeechProvider;
  transport?: FakeAudioTransport;
  store?: VoiceSessionStore;
  invokeTool?: (call: never, ctx?: { conversationId: string; sessionId: string }) => Promise<{ content: string; is_error?: boolean }>;
  deleteRoom?: (roomName: string) => Promise<void>;
  workingMemory?: WorkingMemory;
  timezone?: string;
  historyReadTimeoutMs?: number;
  /** Late-bound coordinator bridge (tools + context providers), applied via configureTools(). */
  bridge?: VoiceToolBridge;
}) {
  const bus = new EventBus(logger);
  const events: BusEvent[] = [];
  bus.subscribe('inbound.message', 'system', async e => {
    events.push(e);
  });
  bus.subscribe('voice.session.ended', 'system', async e => {
    events.push(e);
  });
  const stt = new FakeSttProvider();
  const transport = overrides.transport ?? new FakeAudioTransport();
  const tts = overrides.tts ?? new SlowTtsProvider();
  const store = overrides.store ?? fakeStore().store;
  const runtime = new VoiceRuntime({
    bus,
    logger,
    sessionStore: store,
    stt,
    tts,
    llm: overrides.llm,
    model: 'fake',
    livekitUrl: 'ws://localhost',
    createTransport: () => transport,
    invokeTool: overrides.invokeTool as never,
    deleteRoom: overrides.deleteRoom,
    workingMemory: overrides.workingMemory,
    timezone: overrides.timezone,
    historyReadTimeoutMs: overrides.historyReadTimeoutMs,
  });
  if (overrides.bridge) runtime.configureTools(overrides.bridge);
  return { runtime, bus, events, stt, transport, tts, store };
}

describe('VoiceRuntime', () => {
  it('refuses a non-streaming LLM provider', () => {
    const nonStreaming: LLMProvider = {
      id: 'no-stream',
      async chat() {
        return { type: 'text', content: '', usage, provenance };
      },
    };
    expect(() => makeRuntime({ llm: nonStreaming })).toThrow(/stream/);
  });

  it('runs a full turn: publishes inbound.message and speaks TTS frames', async () => {
    const llm = new FakeStreamProvider([
      [
        { type: 'text_delta', text: 'Hi there. ' },
        { type: 'message_end', content: 'Hi there.', usage, provenance },
      ],
    ]);
    const { runtime, events, stt, transport } = makeRuntime({ llm, tts: new SlowTtsProvider(3, 1) });

    await runtime.startSession({
      sessionId: 's1',
      conversationId: 'voice:s1',
      roomName: 'voice-s1',
      agentToken: 'tok',
    });

    stt.emit({ text: 'hello curia', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s1');

    const inbound = events.find(e => e.type === 'inbound.message');
    expect(inbound).toBeDefined();
    expect((inbound as { payload: { channelId: string; content: string } }).payload.channelId).toBe('voice');
    expect((inbound as { payload: { content: string } }).payload.content).toBe('hello curia');
    expect(transport.publishedFrames.length).toBeGreaterThan(0);
  });

  it('barge-in cancels in-flight TTS and aborts the turn', async () => {
    // Long assistant reply, streamed slowly so we can interrupt.
    const llm = new FakeStreamProvider(
      [
        [
          { type: 'text_delta', text: 'This is a fairly long spoken answer. ' },
          { type: 'text_delta', text: 'It keeps going for a while longer. ' },
          { type: 'message_end', content: 'This is a fairly long spoken answer. It keeps going for a while longer.', usage, provenance },
        ],
      ],
      3,
    );
    const tts = new SlowTtsProvider(50, 5);
    const { runtime, stt, transport } = makeRuntime({ llm, tts });

    await runtime.startSession({
      sessionId: 's2',
      conversationId: 'voice:s2',
      roomName: 'voice-s2',
      agentToken: 'tok',
    });

    stt.emit({ text: 'tell me a long story', isFinal: true, speechFinal: true });

    // Let the assistant start speaking.
    await delay(40);
    const framesBeforeBarge = transport.publishedFrames.length;
    expect(framesBeforeBarge).toBeGreaterThan(0);

    // Principal interrupts (interim transcript while assistant is talking).
    // Must clear the confidence/length gate (min 3 chars).
    stt.emit({ text: 'actually wait', isFinal: false, confidence: 0.9 });

    await runtime.awaitIdle('s2');
    // TTS was cancelled for the in-flight stream.
    expect(tts.cancelled.size).toBeGreaterThan(0);
    const framesAfter = transport.publishedFrames.length;

    // Give any (incorrectly) un-cancelled synthesis time to keep publishing.
    await delay(60);
    expect(transport.publishedFrames.length).toBe(framesAfter);
  });

  it('ignores low-confidence / tiny interim transcripts for barge-in (echo guard)', async () => {
    const llm = new FakeStreamProvider(
      [
        [
          { type: 'text_delta', text: 'Speaking for a while. ' },
          { type: 'message_end', content: 'Speaking for a while.', usage, provenance },
        ],
      ],
      2,
    );
    const tts = new SlowTtsProvider(40, 8);
    const { runtime, stt, transport } = makeRuntime({ llm, tts });

    await runtime.startSession({
      sessionId: 's-echo',
      conversationId: 'voice:s-echo',
      roomName: 'voice-s-echo',
      agentToken: 'tok',
    });
    stt.emit({ text: 'say something', isFinal: true, speechFinal: true });
    await delay(40);
    expect(transport.publishedFrames.length).toBeGreaterThan(0);

    // Tiny + low-confidence interims must NOT cancel the assistant.
    stt.emit({ text: 'hi', isFinal: false, confidence: 0.9 }); // too short
    stt.emit({ text: 'hello there', isFinal: false, confidence: 0.1 }); // too low confidence
    await delay(20);
    expect(tts.cancelled.size).toBe(0);

    await runtime.awaitIdle('s-echo');
  });

  it('ends the session when the audio transport closes (ungraceful hangup)', async () => {
    const llm = new FakeStreamProvider([[{ type: 'message_end', content: 'ok', usage, provenance }]]);
    const deleteRoom = vi.fn(async () => {});
    const { runtime, events, transport } = makeRuntime({ llm, deleteRoom });

    await runtime.startSession({
      sessionId: 's-close',
      conversationId: 'voice:s-close',
      roomName: 'voice-s-close',
      agentToken: 'tok',
    });
    expect(runtime.activeSessionCount).toBe(1);

    transport.emitClose('principal_disconnected');
    // Allow the void endSession to settle.
    await delay(30);

    expect(runtime.activeSessionCount).toBe(0);
    expect(transport.disconnectCount).toBe(1);
    expect(events.filter(e => e.type === 'voice.session.ended')).toHaveLength(1);
    expect(deleteRoom).toHaveBeenCalledWith('voice-s-close');
  });

  it('endSession disconnects transport and publishes voice.session.ended once', async () => {
    const llm = new FakeStreamProvider([[{ type: 'message_end', content: 'ok', usage, provenance }]]);
    const { runtime, events, transport } = makeRuntime({ llm });

    await runtime.startSession({
      sessionId: 's3',
      conversationId: 'voice:s3',
      roomName: 'voice-s3',
      agentToken: 'tok',
    });
    expect(runtime.activeSessionCount).toBe(1);

    const ended = await runtime.endSession('s3', 'console_hangup');
    expect(ended).not.toBeNull();
    expect(transport.disconnectCount).toBe(1);
    expect(runtime.activeSessionCount).toBe(0);
    expect(events.filter(e => e.type === 'voice.session.ended').length).toBe(1);

    // Second end is a no-op for the ended event (store returns null).
    const again = await runtime.endSession('s3', 'console_hangup');
    expect(again).toBeNull();
    expect(events.filter(e => e.type === 'voice.session.ended').length).toBe(1);
  });

  it('endSession resolves (not rejects) when the store write fails', async () => {
    const llm = new FakeStreamProvider([[{ type: 'message_end', content: 'ok', usage, provenance }]]);
    // endSession() is fired-and-forgotten (`void this.endSession(...)`) from
    // stt.onError / transport.onClose, so a throwing store write would surface as
    // an unhandled rejection and crash the process. It must be swallowed + logged.
    const store = {
      async endSession() {
        throw new Error('db down');
      },
    } as unknown as VoiceSessionStore;
    const { runtime, transport } = makeRuntime({ llm, store });

    await runtime.startSession({
      sessionId: 's5',
      conversationId: 'voice:s5',
      roomName: 'voice-s5',
      agentToken: 'tok',
    });

    await expect(runtime.endSession('s5', 'stt_error')).resolves.toBeNull();
    // Transport teardown still ran before the failing store write.
    expect(transport.disconnectCount).toBe(1);
    expect(runtime.activeSessionCount).toBe(0);
  });

  it('ends the session with tts_error after repeated TTS synthesis failures (#1556)', async () => {
    const llm = new FakeStreamProvider([
      replyScript('First reply.'),
      replyScript('Second reply.'),
      replyScript('Third reply.'),
    ]);
    const tts = new FailingTtsProvider();
    const { store, endReasons } = fakeStore();
    const deleteRoom = vi.fn(async () => {});
    const { runtime, events, stt, transport } = makeRuntime({ llm, tts, store, deleteRoom });

    await runtime.startSession({
      sessionId: 's-tts-fail',
      conversationId: 'voice:s-tts-fail',
      roomName: 'voice-s-tts-fail',
      agentToken: 'tok',
    });

    stt.emit({ text: 'one', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s-tts-fail');
    expect(runtime.activeSessionCount).toBe(1);

    stt.emit({ text: 'two', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s-tts-fail');
    expect(runtime.activeSessionCount).toBe(1);

    stt.emit({ text: 'three', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s-tts-fail');
    // void endSession from the third failure — let it settle.
    await delay(30);

    expect(tts.failures.length).toBeGreaterThanOrEqual(3);
    expect(runtime.activeSessionCount).toBe(0);
    expect(transport.disconnectCount).toBe(1);
    expect(endReasons).toEqual(['tts_error']);
    const ended = events.filter(e => e.type === 'voice.session.ended');
    expect(ended).toHaveLength(1);
    expect((ended[0] as { payload: { reason: string } }).payload.reason).toBe('tts_error');
    expect(deleteRoom).toHaveBeenCalledWith('voice-s-tts-fail');
  });

  it('does not tear down on a single transient TTS failure (#1556)', async () => {
    const llm = new FakeStreamProvider([
      replyScript('First reply.'),
      replyScript('Second reply.'),
    ]);
    const tts = new FlakyThenOkTtsProvider(1);
    const { runtime, events, stt, transport } = makeRuntime({ llm, tts });

    await runtime.startSession({
      sessionId: 's-tts-blip',
      conversationId: 'voice:s-tts-blip',
      roomName: 'voice-s-tts-blip',
      agentToken: 'tok',
    });

    stt.emit({ text: 'one', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s-tts-blip');
    stt.emit({ text: 'two', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s-tts-blip');
    await delay(20);

    expect(tts.failures).toBe(1);
    expect(tts.successes).toBe(1);
    expect(runtime.activeSessionCount).toBe(1);
    expect(transport.publishedFrames.length).toBeGreaterThan(0);
    expect(events.filter(e => e.type === 'voice.session.ended')).toHaveLength(0);
  });

  it('ends immediately on a hard TTS auth/voice-id failure (#1556)', async () => {
    const llm = new FakeStreamProvider([replyScript('Hello.')]);
    const tts = new FailingTtsProvider(new TtsHttpError(401, 'Cartesia TTS request failed with HTTP 401'));
    const { store, endReasons } = fakeStore();
    const { runtime, events, stt } = makeRuntime({ llm, tts, store });

    await runtime.startSession({
      sessionId: 's-tts-hard',
      conversationId: 'voice:s-tts-hard',
      roomName: 'voice-s-tts-hard',
      agentToken: 'tok',
    });

    stt.emit({ text: 'hello', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s-tts-hard');
    await delay(30);

    expect(tts.failures).toHaveLength(1);
    expect(runtime.activeSessionCount).toBe(0);
    expect(endReasons).toEqual(['tts_error']);
    expect(events.filter(e => e.type === 'voice.session.ended')).toHaveLength(1);
  });

  it('does not count transport publish failures as TTS synthesis failures (#1556)', async () => {
    const llm = new FakeStreamProvider([
      replyScript('First reply.'),
      replyScript('Second reply.'),
      replyScript('Third reply.'),
    ]);
    // Healthy TTS — every synthesize succeeds. Transport publish throws every time.
    class ThrowingPublishTransport extends FakeAudioTransport {
      override async publishAudio(): Promise<void> {
        throw new Error('livekit publish failed');
      }
    }
    const transport = new ThrowingPublishTransport();
    const { store, endReasons } = fakeStore();
    const { runtime, events, stt } = makeRuntime({
      llm,
      tts: new SlowTtsProvider(2, 1),
      transport,
      store,
    });

    await runtime.startSession({
      sessionId: 's-pub-fail',
      conversationId: 'voice:s-pub-fail',
      roomName: 'voice-s-pub-fail',
      agentToken: 'tok',
    });

    for (const utter of ['one', 'two', 'three'] as const) {
      stt.emit({ text: utter, isFinal: true, speechFinal: true });
      await runtime.awaitIdle('s-pub-fail');
    }
    await delay(30);

    // Three publish-failed turns must not escalate to tts_error.
    expect(runtime.activeSessionCount).toBe(1);
    expect(endReasons).toEqual([]);
    expect(events.filter(e => e.type === 'voice.session.ended')).toHaveLength(0);
  });

  it('invokes tools during a voice turn via the runner tool loop', async () => {
    const llm = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [{ id: 'c1', name: 'lookup', input: {} }], usage, provenance }],
      [{ type: 'text_delta', text: 'Found it. ' }, { type: 'message_end', content: 'Found it.', usage, provenance }],
    ]);
    const invokeTool = vi.fn(async () => ({ content: 'result' }));
    const { runtime, stt } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1), invokeTool });

    await runtime.startSession({
      sessionId: 's4',
      conversationId: 'voice:s4',
      roomName: 'voice-s4',
      agentToken: 'tok',
    });
    stt.emit({ text: 'look something up', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('s4');

    expect(invokeTool).toHaveBeenCalledOnce();
  });
});

describe('VoiceRuntime brain/context parity (#1551)', () => {
  const reply = (text: string): LLMStreamEvent[] => [
    { type: 'text_delta', text: `${text} ` },
    { type: 'message_end', content: text, usage, provenance },
  ];

  /** Plain-string contents of a message list (voice turns never build block-array content here). */
  const textContents = (msgs: Message[]): string[] =>
    msgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

  async function start(runtime: VoiceRuntime, id: string): Promise<void> {
    await runtime.startSession({
      sessionId: id,
      conversationId: `voice:${id}`,
      roomName: `voice-${id}`,
      agentToken: 'tok',
    });
  }

  it('assembles the spoken-turn system prompt: identity, brevity, honesty, delegation + roster, time', async () => {
    const llm = new FakeStreamProvider([reply('Hello.')]);
    const bridge: VoiceToolBridge = {
      resolveVoiceTools: () => [],
      invokeTool: async () => ({ content: 'ok' }),
      identityBlock: () => '## Identity & Communication Contract\nYou are Vera, Chief of Staff.',
      specialistRoster: () => '- @calendar: Manages the calendar\n- @contacts: Contact intelligence',
    };
    const { runtime, stt } = makeRuntime({
      llm,
      tts: new SlowTtsProvider(2, 1),
      timezone: 'America/Toronto',
      bridge,
    });
    await start(runtime, 'sp1');
    stt.emit({ text: 'what is on my calendar tomorrow', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('sp1');

    const messages = llm.seenMessages[0]!;
    const system = messages[0]!;
    expect(system.role).toBe('system');
    const systemText = typeof system.content === 'string' ? system.content : '';
    // Persona/identity parity with the coordinator preamble.
    expect(systemText).toContain('You are Vera, Chief of Staff.');
    // Spoken brevity policy still applies with fuller context enabled.
    expect(systemText).toContain(VOICE_SYSTEM_ADDENDUM);
    // Honest-negative policy: failed checks are never narrated as empty results.
    expect(systemText).toContain(VOICE_TOOL_RESULT_POLICY);
    // Delegation guidance + roster so specialist domains are reachable from voice.
    expect(systemText).toContain(VOICE_DELEGATION_GUIDANCE);
    expect(systemText).toContain('## Available Specialists');
    expect(systemText).toContain('- @calendar: Manages the calendar');
    // Same date/timezone grounding the coordinator gets; dynamic block last so
    // the static prefix stays provider-cacheable.
    expect(systemText).toContain('## Current Date & Time');
    expect(systemText).toContain('Timezone: America/Toronto');
    expect(systemText.indexOf('## Current Date & Time'))
      .toBeGreaterThan(systemText.indexOf('## Available Specialists'));
    // The utterance is the final message, exactly once.
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'what is on my calendar tomorrow' });
    expect(messages.filter(m => m.content === 'what is on my calendar tomorrow')).toHaveLength(1);
  });

  it('degrades to the slim prompt when no bridge context or timezone is configured', async () => {
    const llm = new FakeStreamProvider([reply('Hi.')]);
    const { runtime, stt } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1) });
    await start(runtime, 'sp2');
    stt.emit({ text: 'hello', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('sp2');

    const system = llm.seenMessages[0]![0]!;
    expect(system.content).toBe(`${VOICE_SYSTEM_ADDENDUM}\n\n${VOICE_TOOL_RESULT_POLICY}`);
  });

  it('omits a throwing identity block and still runs the turn', async () => {
    const llm = new FakeStreamProvider([reply('Still here.')]);
    const bridge: VoiceToolBridge = {
      resolveVoiceTools: () => [],
      invokeTool: async () => ({ content: 'ok' }),
      identityBlock: () => {
        throw new Error('identity compile failed');
      },
      specialistRoster: () => '- @calendar: Manages the calendar',
    };
    const { runtime, stt, transport } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1), bridge });
    await start(runtime, 'sp3');
    stt.emit({ text: 'are you there', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('sp3');

    const system = llm.seenMessages[0]![0]!;
    expect(system.content).toContain(VOICE_SYSTEM_ADDENDUM);
    expect(system.content).toContain('## Available Specialists');
    expect(transport.publishedFrames.length).toBeGreaterThan(0);
  });

  it('sources spoken-turn context from working_memory, including turns persisted before this process', async () => {
    const wm = WorkingMemory.createInMemory();
    // Turns persisted mid-call by a previous process — must not be silently dropped.
    await wm.addTurn('voice:wm1', 'coordinator', { role: 'user', content: 'remember the budget is 50k' });
    await wm.addTurn('voice:wm1', 'coordinator', { role: 'assistant', content: 'Noted: the budget is 50k.' });

    const llm = new FakeStreamProvider([reply('It is 50k.')]);
    const { runtime, stt } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1), workingMemory: wm });
    await start(runtime, 'wm1');
    stt.emit({ text: 'what was the budget again', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm1');

    const messages = llm.seenMessages[0]!;
    const contents = textContents(messages);
    expect(contents).toContain('remember the budget is 50k');
    expect(contents).toContain('Noted: the budget is 50k.');
    // Current utterance appended exactly once, as the last message.
    expect(messages[messages.length - 1]!.content).toBe('what was the budget again');
    expect(contents.filter(c => c === 'what was the budget again')).toHaveLength(1);
  });

  it('keeps console history and spoken-turn context single-sourced across turns', async () => {
    const wm = WorkingMemory.createInMemory();
    const llm = new FakeStreamProvider([reply('Hi there.'), reply('Yes, still here.')]);
    const { runtime, stt } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1), workingMemory: wm });
    await start(runtime, 'wm2');

    stt.emit({ text: 'hello curia', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm2');
    stt.emit({ text: 'still with me', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm2');

    // Turn 2's LLM context contains turn 1 as reloaded from the store.
    const second = llm.seenMessages[1]!;
    const contents = textContents(second);
    expect(contents).toContain('hello curia');
    expect(contents).toContain('Hi there.');
    expect(second[second.length - 1]!.content).toBe('still with me');

    // The store holds exactly what the console history endpoint would read.
    const history = await wm.getHistory('voice:wm2', 'coordinator');
    expect(history).toEqual([
      { role: 'user', content: 'hello curia' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'still with me' },
      { role: 'assistant', content: 'Yes, still here.' },
    ]);
  });

  it('survives a throwing roster provider and an invalid timezone (slimmer prompt, turn completes)', async () => {
    const llm = new FakeStreamProvider([reply('Still speaking.')]);
    const bridge: VoiceToolBridge = {
      resolveVoiceTools: () => [],
      invokeTool: async () => ({ content: 'ok' }),
      identityBlock: () => '## Identity & Communication Contract\nYou are Vera, Chief of Staff.',
      specialistRoster: () => {
        throw new Error('registry down');
      },
    };
    const { runtime, stt, transport } = makeRuntime({
      llm,
      tts: new SlowTtsProvider(2, 1),
      timezone: 'Not/AZone',
      bridge,
    });
    await start(runtime, 'sp4');
    stt.emit({ text: 'are you still there', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('sp4');

    const system = llm.seenMessages[0]![0]!;
    const systemText = typeof system.content === 'string' ? system.content : '';
    // Healthy blocks still apply; the failing ones are omitted, not fatal.
    expect(systemText).toContain(VOICE_SYSTEM_ADDENDUM);
    expect(systemText).toContain('You are Vera, Chief of Staff.');
    expect(systemText).not.toContain('## Available Specialists');
    expect(systemText).not.toContain('## Current Date & Time');
    expect(transport.publishedFrames.length).toBeGreaterThan(0);
  });

  it('prefers in-process history when the store reads back empty after failed writes', async () => {
    // addTurn fails warn-only, so a clean read returns [] while session.history
    // still holds the conversation — the turn must not go amnesiac.
    const failingWrites = {
      addTurn: vi.fn(async () => {
        throw new Error('insert failed');
      }),
      getHistory: vi.fn(async () => []),
      purgeExpired: vi.fn(async () => 0),
    } as unknown as WorkingMemory;

    const llm = new FakeStreamProvider([reply('First answer.'), reply('Second answer.')]);
    const { runtime, stt } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1), workingMemory: failingWrites });
    await start(runtime, 'wm4');

    stt.emit({ text: 'first question', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm4');
    stt.emit({ text: 'second question', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm4');

    const second = llm.seenMessages[1]!;
    const contents = textContents(second);
    expect(contents).toContain('first question');
    expect(contents).toContain('First answer.');
    expect(second[second.length - 1]!.content).toBe('second question');
  });

  it('falls back to in-process history when the working_memory read exceeds the voice deadline', async () => {
    const stalled = {
      addTurn: vi.fn(async () => {}),
      // Never settles — only the deadline can unblock the turn.
      getHistory: vi.fn(() => new Promise(() => {})),
      purgeExpired: vi.fn(async () => 0),
    } as unknown as WorkingMemory;

    const llm = new FakeStreamProvider([reply('First answer.'), reply('Second answer.')]);
    const { runtime, stt, events } = makeRuntime({
      llm,
      tts: new SlowTtsProvider(2, 1),
      workingMemory: stalled,
      historyReadTimeoutMs: 40,
    });
    await start(runtime, 'wm5');

    stt.emit({ text: 'first question', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm5');
    stt.emit({ text: 'second question', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm5');

    // Both turns completed despite the stalled store...
    expect(events.filter(e => e.type === 'inbound.message')).toHaveLength(2);
    // ...and turn 2 still carried turn 1 via the in-process fallback.
    const second = llm.seenMessages[1]!;
    const contents = textContents(second);
    expect(contents).toContain('first question');
    expect(contents).toContain('First answer.');
    expect(second[second.length - 1]!.content).toBe('second question');
  });

  it('falls back to in-process history when the working_memory read fails', async () => {
    const failing = {
      addTurn: vi.fn(async () => {}),
      getHistory: vi.fn(async () => {
        throw new Error('db down');
      }),
      purgeExpired: vi.fn(async () => 0),
    } as unknown as WorkingMemory;

    const llm = new FakeStreamProvider([reply('First answer.'), reply('Second answer.')]);
    const { runtime, stt, events } = makeRuntime({ llm, tts: new SlowTtsProvider(2, 1), workingMemory: failing });
    await start(runtime, 'wm3');

    stt.emit({ text: 'first question', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm3');
    stt.emit({ text: 'second question', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('wm3');

    // Both turns completed despite the failing store...
    expect(events.filter(e => e.type === 'inbound.message')).toHaveLength(2);
    // ...and turn 2 still carried turn 1 via the in-process fallback.
    const second = llm.seenMessages[1]!;
    const contents = textContents(second);
    expect(contents).toContain('first question');
    expect(contents).toContain('First answer.');
    expect(second[second.length - 1]!.content).toBe('second question');
  });

  it('reaches specialist-delegated domains: calendar-tomorrow flows through the delegate tool', async () => {
    const calendarEvents = JSON.stringify({
      events: [
        { title: 'Board meeting', start: '2026-07-27T09:00:00-04:00' },
        { title: 'Lunch with Dana', start: '2026-07-27T12:00:00-04:00' },
      ],
    });
    const spoken = 'You have the board meeting at nine and lunch with Dana at noon.';
    const llm = new FakeStreamProvider([
      [{
        type: 'tool_use',
        toolCalls: [{
          id: 'c1',
          name: 'delegate',
          input: { agent: 'calendar', task: "What is on the principal's calendar tomorrow?" },
        }],
        usage,
        provenance,
      }],
      reply(spoken),
    ]);
    const invokeTool = vi.fn(async () => ({ content: calendarEvents }));
    const wm = WorkingMemory.createInMemory();
    const bridge: VoiceToolBridge = {
      resolveVoiceTools: () => [{
        name: 'delegate',
        description: 'Delegate a task to a specialist agent',
        input_schema: { type: 'object', properties: {} },
      }],
      invokeTool,
      specialistRoster: () => "- @calendar: Manages the principal's calendar",
    };
    const { runtime, stt } = makeRuntime({
      llm,
      tts: new SlowTtsProvider(2, 1),
      timezone: 'America/Toronto',
      workingMemory: wm,
      bridge,
    });
    await start(runtime, 'cal1');
    stt.emit({ text: 'what is on my calendar tomorrow', isFinal: true, speechFinal: true });
    await runtime.awaitIdle('cal1');

    // The turn had time grounding for "tomorrow" and the roster to know delegation exists.
    const system = llm.seenMessages[0]![0]!;
    expect(system.content).toContain('## Current Date & Time');
    expect(system.content).toContain("- @calendar: Manages the principal's calendar");

    // The delegate tool was invoked against the calendar specialist.
    expect(invokeTool).toHaveBeenCalledOnce();
    const [delegateCall] = invokeTool.mock.calls[0]! as unknown as [
      { name: string; input: { agent: string } },
      { conversationId: string; sessionId: string },
    ];
    expect(delegateCall.name).toBe('delegate');
    expect(delegateCall.input.agent).toBe('calendar');

    // The spoken answer reflects the delegated result and lands in the shared history.
    const history = await wm.getHistory('voice:cal1', 'coordinator');
    expect(history[history.length - 1]).toEqual({ role: 'assistant', content: spoken });
  });
});
