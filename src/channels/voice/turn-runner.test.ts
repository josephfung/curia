import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '../../logger.js';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamEvent,
  ToolCall,
} from '../../agents/llm/provider.js';
import { VoiceTurnRunner, StreamUnsupportedError, VoiceTurnError } from './turn-runner.js';

const logger = createSilentLogger();

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'fake', actualModel: 'fake', providerRequestId: 'req_1' };

/**
 * Fake streaming provider. Each call to stream() consumes the next scripted
 * sequence of events. `delayMs` inserts an await between yields so an abort can
 * interleave.
 */
class FakeStreamProvider implements LLMProvider {
  readonly id = 'fake-stream';
  streamCalls = 0;

  constructor(
    private readonly scripts: LLMStreamEvent[][],
    private readonly delayMs = 0,
  ) {}

  async chat(): Promise<LLMResponse> {
    return { type: 'text', content: '', usage, provenance };
  }

  async *stream(params: { options?: Record<string, unknown> }): AsyncIterable<LLMStreamEvent> {
    const script = this.scripts[this.streamCalls] ?? [];
    this.streamCalls += 1;
    const signal = params.options?.signal as AbortSignal | undefined;
    for (const event of script) {
      if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
      if (signal?.aborted) return;
      yield event;
    }
  }
}

/** Provider missing stream() — used to prove the constructor guard. */
class NoStreamProvider implements LLMProvider {
  readonly id = 'no-stream';
  async chat(): Promise<LLMResponse> {
    return { type: 'text', content: '', usage, provenance };
  }
}

function textDelta(text: string): LLMStreamEvent {
  return { type: 'text_delta', text };
}

describe('VoiceTurnRunner', () => {
  it('refuses a provider without stream()', () => {
    expect(
      () =>
        new VoiceTurnRunner({
          provider: new NoStreamProvider(),
          model: 'fake',
          logger,
          onSpeechText: async () => {},
        }),
    ).toThrow(StreamUnsupportedError);
  });

  it('sentence-chunks streamed text into onSpeechText', async () => {
    const provider = new FakeStreamProvider([
      [
        textDelta('Hello there. '),
        textDelta('How can I '),
        textDelta('help you today? '),
        { type: 'message_end', content: 'Hello there. How can I help you today?', usage, provenance },
      ],
    ]);
    const spoken: string[] = [];
    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      onSpeechText: async text => {
        spoken.push(text);
      },
    });

    const result = await runner.runTurn({
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });

    expect(spoken).toEqual(['Hello there.', 'How can I help you today?']);
    expect(result.aborted).toBe(false);
    expect(result.finalText).toBe('Hello there. How can I help you today?');
  });

  it('flushes a trailing partial sentence on message_end', async () => {
    const provider = new FakeStreamProvider([
      [textDelta('No terminator here'), { type: 'message_end', content: 'No terminator here', usage, provenance }],
    ]);
    const spoken: string[] = [];
    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      onSpeechText: async text => {
        spoken.push(text);
      },
    });

    await runner.runTurn({ messages: [], signal: new AbortController().signal });
    expect(spoken).toEqual(['No terminator here']);
  });

  it('runs the tool loop: filler, invoke, continue with results', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: { q: 'weather' } };
    const provider = new FakeStreamProvider([
      // Round 1: model narrates (streamed as deltas) then asks for a tool.
      [textDelta('Let me check. '), { type: 'tool_use', toolCalls: [toolCall], content: 'Let me check.', usage, provenance }],
      // Round 2: model produces the final answer.
      [textDelta('It is sunny. '), { type: 'message_end', content: 'It is sunny.', usage, provenance }],
    ]);

    const spoken: string[] = [];
    const fillers: string[] = [];
    const invokeTool = vi.fn(async (_call: ToolCall) => ({ content: 'sunny, 25C' }));

    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      tools: [{ name: 'lookup', description: 'lookup', input_schema: { type: 'object', properties: {} } }],
      invokeTool,
      onFiller: async text => {
        fillers.push(text);
      },
      onSpeechText: async text => {
        spoken.push(text);
      },
    });

    const result = await runner.runTurn({ messages: [{ role: 'user', content: 'weather?' }], signal: new AbortController().signal });

    expect(invokeTool).toHaveBeenCalledOnce();
    expect(invokeTool).toHaveBeenCalledWith(toolCall);
    expect(fillers).toEqual(['One moment.']);
    // Preceding text ("Let me check.") is spoken before the filler, then the answer.
    expect(spoken).toContain('Let me check.');
    expect(spoken).toContain('It is sunny.');
    expect(result.toolRounds).toBe(1);
    expect(result.finalText).toBe('It is sunny.');
    expect(provider.streamCalls).toBe(2);
  });

  it('uses a placeholder tool result when invokeTool is not provided', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    let capturedResultContent: string | undefined;
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], usage, provenance }],
      [{ type: 'message_end', content: 'ok', usage, provenance }],
    ]);
    // Wrap stream to capture the tool_result content passed on the second call.
    const origStream = provider.stream.bind(provider);
    provider.stream = async function* (params: { messages?: unknown[]; options?: Record<string, unknown> }) {
      if (provider.streamCalls === 1 && Array.isArray(params.messages)) {
        const lastMsg = params.messages[params.messages.length - 1] as { content: Array<{ content?: string }> };
        capturedResultContent = lastMsg.content[0]?.content;
      }
      yield* origStream(params as never);
    } as never;

    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      onSpeechText: async () => {},
    });

    await runner.runTurn({ messages: [], signal: new AbortController().signal });
    expect(capturedResultContent).toContain('not wired');
  });

  it('throws VoiceTurnError on a terminal error event', async () => {
    const provider = new FakeStreamProvider([
      [
        {
          type: 'error',
          error: {
            type: 'PROVIDER_ERROR',
            source: 'fake-stream',
            message: 'boom',
            retryable: true,
            context: {},
            timestamp: new Date(),
          },
        },
      ],
    ]);
    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      onSpeechText: async () => {},
    });

    await expect(
      runner.runTurn({ messages: [], signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(VoiceTurnError);
  });

  it('converts a throwing invokeTool into a tool_result error and continues', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    let capturedResult: { content?: string; is_error?: boolean } | undefined;
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], usage, provenance }],
      [{ type: 'message_end', content: 'recovered', usage, provenance }],
    ]);
    const origStream = provider.stream.bind(provider);
    provider.stream = async function* (params: { messages?: unknown[]; options?: Record<string, unknown> }) {
      if (provider.streamCalls === 1 && Array.isArray(params.messages)) {
        const lastMsg = params.messages[params.messages.length - 1] as {
          content: Array<{ content?: string; is_error?: boolean }>;
        };
        capturedResult = lastMsg.content[0];
      }
      yield* origStream(params as never);
    } as never;

    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      invokeTool: async () => {
        throw new Error('boom');
      },
      onSpeechText: async () => {},
    });

    const result = await runner.runTurn({ messages: [], signal: new AbortController().signal });
    expect(capturedResult?.content).toContain("Tool 'lookup' failed: boom");
    expect(capturedResult?.is_error).toBe(true);
    expect(result.finalText).toBe('recovered');
    expect(result.toolRounds).toBe(1);
  });

  it('accumulates spoken text and speaks a fallback when the tool loop exhausts', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    // Eight tool_use rounds with no message_end → hit MAX_TOOL_ROUNDS.
    const scripts: LLMStreamEvent[][] = Array.from({ length: 8 }, () => [
      { type: 'tool_use', toolCalls: [toolCall], usage, provenance },
    ]);
    const provider = new FakeStreamProvider(scripts);
    const spoken: string[] = [];
    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      invokeTool: async () => ({ content: 'ok' }),
      onFiller: async () => {},
      onSpeechText: async text => {
        spoken.push(text);
      },
    });

    const result = await runner.runTurn({ messages: [], signal: new AbortController().signal });
    expect(result.toolRounds).toBe(8);
    expect(spoken).toContain('Sorry, I could not finish that — please try again.');
    expect(result.finalText).toContain('Sorry, I could not finish that — please try again.');
  });

  it('stops cleanly on abort and does not flush the trailing partial sentence', async () => {
    // First a complete sentence (spoken), then a partial that must NOT be flushed
    // once the signal aborts. Delay each yield so the abort lands mid-stream.
    const provider = new FakeStreamProvider(
      [[textDelta('First sentence. '), textDelta('Second partial'), { type: 'message_end', content: 'x', usage, provenance }]],
      5,
    );
    const spoken: string[] = [];
    const controller = new AbortController();
    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      onSpeechText: async text => {
        spoken.push(text);
        // Abort as soon as the first completed sentence is produced.
        controller.abort();
      },
    });

    const result = await runner.runTurn({ messages: [], signal: controller.signal });
    expect(result.aborted).toBe(true);
    // The completed sentence was spoken; the trailing partial was discarded.
    expect(spoken).toEqual(['First sentence.']);
    expect(spoken).not.toContain('Second partial');
  });

  it('returns aborted immediately when the signal is already aborted', async () => {
    const provider = new FakeStreamProvider([[textDelta('never. '), { type: 'message_end', content: 'x', usage, provenance }]]);
    const controller = new AbortController();
    controller.abort();
    const spoken: string[] = [];
    const runner = new VoiceTurnRunner({
      provider,
      model: 'fake',
      logger,
      onSpeechText: async text => {
        spoken.push(text);
      },
    });

    const result = await runner.runTurn({ messages: [], signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(provider.streamCalls).toBe(0);
    expect(spoken).toEqual([]);
  });
});
