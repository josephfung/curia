import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../bus/bus.js';
import type { BusEvent } from '../../bus/events.js';
import { createSilentLogger } from '../../logger.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent } from '../../agents/llm/provider.js';
import { VoiceRuntime } from './voice-runtime.js';
import { FakeAudioTransport } from './fake-audio-transport.js';
import { FakeSttProvider } from './speech/fake-stt.js';
import type { PcmFrame, TextToSpeechProvider, TtsSynthesizeOptions } from './speech/types.js';
import type { VoiceSessionRecord, VoiceSessionStore } from './session-store.js';

const logger = createSilentLogger();
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'fake', actualModel: 'fake', providerRequestId: 'req_1' };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Fake streaming LLM provider driven by scripted event sequences. */
class FakeStreamProvider implements LLMProvider {
  readonly id = 'fake-stream';
  constructor(
    private readonly scripts: LLMStreamEvent[][],
    private readonly delayMs = 0,
  ) {}
  private call = 0;
  async chat(): Promise<LLMResponse> {
    return { type: 'text', content: '', usage, provenance };
  }
  async *stream(params: { options?: Record<string, unknown> }): AsyncIterable<LLMStreamEvent> {
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
function fakeStore(): { store: VoiceSessionStore; statuses: string[]; ended: string[] } {
  const statuses: string[] = [];
  const ended: string[] = [];
  const rec = (id: string, status: string): VoiceSessionRecord => ({
    id,
    conversationId: `voice:${id}`,
    livekitRoom: `voice-${id}`,
    principalContactId: null,
    status: status as VoiceSessionRecord['status'],
    startedAt: new Date(Date.now() - 1000),
    endedAt: status === 'ended' ? new Date() : null,
    endReason: status === 'ended' ? 'test' : null,
    metadata: {},
  });
  const store = {
    async updateStatus(id: string, status: string) {
      statuses.push(status);
      return rec(id, status);
    },
    async endSession(id: string) {
      if (ended.includes(id)) return null;
      ended.push(id);
      return rec(id, 'ended');
    },
  } as unknown as VoiceSessionStore;
  return { store, statuses, ended };
}

function makeRuntime(overrides: {
  llm: LLMProvider;
  tts?: TextToSpeechProvider;
  transport?: FakeAudioTransport;
  store?: VoiceSessionStore;
  invokeTool?: (call: never, ctx?: { conversationId: string; sessionId: string }) => Promise<{ content: string; is_error?: boolean }>;
  deleteRoom?: (roomName: string) => Promise<void>;
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
  });
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
