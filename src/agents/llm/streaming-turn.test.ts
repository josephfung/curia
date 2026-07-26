// streaming-turn.test.ts — unit coverage for the shared streaming tool-loop (#1552).

import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '../../logger.js';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamEvent,
  ToolCall,
} from './provider.js';
import {
  DEFAULT_STREAMING_MAX_ROUNDS,
  StreamUnsupportedError,
  assertStreamingProvider,
  runStreamingToolLoop,
} from './streaming-turn.js';
import { buildAssistantToolUseMessage, buildUserToolResultMessage } from './tool-loop-messages.js';

const logger = createSilentLogger();
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'fake', actualModel: 'fake', providerRequestId: 'req_1' };

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
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal?.aborted) return;
      yield event;
    }
  }
}

class NoStreamProvider implements LLMProvider {
  readonly id = 'no-stream';
  async chat(): Promise<LLMResponse> {
    return { type: 'text', content: '', usage, provenance };
  }
}

function textDelta(text: string): LLMStreamEvent {
  return { type: 'text_delta', text };
}

describe('runStreamingToolLoop (#1552)', () => {
  it('refuses a provider without stream()', async () => {
    expect(() => assertStreamingProvider(new NoStreamProvider())).toThrow(StreamUnsupportedError);
    await expect(
      runStreamingToolLoop([], {
        provider: new NoStreamProvider(),
        model: 'fake',
        maxRounds: 2,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(StreamUnsupportedError);
  });

  it('streams text_delta then returns on message_end', async () => {
    const provider = new FakeStreamProvider([
      [
        textDelta('Hello '),
        textDelta('world.'),
        { type: 'message_end', content: 'Hello world.', usage, provenance },
      ],
    ]);
    const deltas: string[] = [];
    const result = await runStreamingToolLoop([{ role: 'user', content: 'hi' }], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: new AbortController().signal,
      hooks: {
        onTextDelta: (text) => {
          deltas.push(text);
        },
      },
    });

    expect(deltas).toEqual(['Hello ', 'world.']);
    expect(result.stopReason).toBe('message_end');
    expect(result.finalText).toBe('Hello world.');
    expect(result.streamedText).toBe('Hello world.');
    expect(result.aborted).toBe(false);
    expect(result.toolRounds).toBe(0);
  });

  it('runs tool_use → invokeTool → continues with tool_result shape', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: { q: 'weather' } };
    const provider = new FakeStreamProvider([
      [
        textDelta('Checking. '),
        { type: 'tool_use', toolCalls: [toolCall], content: 'Checking.', usage, provenance },
      ],
      [{ type: 'message_end', content: 'Sunny.', usage, provenance }],
    ]);

    const beforeTools = vi.fn();
    const invokeTool = vi.fn(async () => ({ content: 'sunny, 25C' }));
    let secondCallMessages: unknown[] | undefined;
    const origStream = provider.stream.bind(provider);
    provider.stream = async function* (params: {
      messages?: unknown[];
      options?: Record<string, unknown>;
    }) {
      if (provider.streamCalls === 1) {
        // Snapshot — workingMessages is mutated after this round completes.
        secondCallMessages = [...(params.messages ?? [])];
      }
      yield* origStream(params as never);
    } as never;

    const result = await runStreamingToolLoop([{ role: 'user', content: 'weather?' }], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: new AbortController().signal,
      tools: [{ name: 'lookup', description: 'lookup', input_schema: { type: 'object', properties: {} } }],
      invokeTool,
      hooks: { onBeforeTools: beforeTools },
      logger,
    });

    expect(beforeTools).toHaveBeenCalledOnce();
    expect(beforeTools).toHaveBeenCalledWith({
      toolCalls: [toolCall],
      content: 'Checking.',
    });
    expect(invokeTool).toHaveBeenCalledWith(toolCall);
    expect(result.toolRounds).toBe(1);
    expect(result.stopReason).toBe('message_end');
    expect(result.finalText).toBe('Sunny.');
    expect(provider.streamCalls).toBe(2);
    // Terminal assistant reply is appended so messages is a complete transcript.
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'Sunny.' });

    // Shape contract: second stream call must carry assistant tool_use + user tool_result.
    expect(secondCallMessages).toEqual([
      { role: 'user', content: 'weather?' },
      buildAssistantToolUseMessage([toolCall], 'Checking.'),
      buildUserToolResultMessage([{ id: 'call_1', content: 'sunny, 25C' }]),
    ]);
  });

  it('uses missingInvokeToolResult when invokeTool is absent', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    let captured: { content?: string; is_error?: boolean } | undefined;
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], usage, provenance }],
      [{ type: 'message_end', content: 'ok', usage, provenance }],
    ]);
    const origStream = provider.stream.bind(provider);
    provider.stream = async function* (params: {
      messages?: unknown[];
      options?: Record<string, unknown>;
    }) {
      if (provider.streamCalls === 1 && Array.isArray(params.messages)) {
        const lastMsg = params.messages[params.messages.length - 1]! as {
          content: Array<{ content?: string; is_error?: boolean }>;
        };
        captured = lastMsg.content[0]!;
      }
      yield* origStream(params as never);
    } as never;

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: new AbortController().signal,
      missingInvokeToolResult: 'Tool execution is not wired for this streaming turn.',
    });

    expect(captured?.content).toContain('not wired');
    expect(captured?.is_error).toBe(true);
    expect(result.finalText).toBe('ok');
    expect(result.toolRounds).toBe(1);
  });

  it('returns empty_stream when the iterable ends with no terminal event', async () => {
    const provider = new FakeStreamProvider([[textDelta('orphan text')]]);
    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: 2,
      signal: new AbortController().signal,
      logger,
    });

    expect(result.stopReason).toBe('empty_stream');
    expect(result.streamedText).toBe('orphan text');
    expect(result.finalText).toBe('orphan text');
    expect(result.exhausted).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('preserves empty message_end content on finalText (no streamedText fallback)', async () => {
    const provider = new FakeStreamProvider([
      [
        textDelta('Pre-tool. '),
        {
          type: 'tool_use',
          toolCalls: [{ id: 'call_1', name: 'lookup', input: {} }],
          content: 'Pre-tool.',
          usage,
          provenance,
        },
      ],
      [
        textDelta('Post-tool spoken. '),
        { type: 'message_end', content: '', usage, provenance },
      ],
    ]);

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: new AbortController().signal,
      invokeTool: async () => ({ content: 'ok' }),
    });

    expect(result.stopReason).toBe('message_end');
    // Callers (voice) must fall back to their own delivered text — not streamedText.
    expect(result.finalText).toBe('');
    expect(result.streamedText).toBe('Pre-tool. Post-tool spoken. ');
    // Transcript still gets a usable assistant turn via streamedText fallback.
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Pre-tool. Post-tool spoken. ',
    });
  });

  it('stops cleanly on abort mid-stream', async () => {
    const provider = new FakeStreamProvider(
      [
        [
          textDelta('First. '),
          textDelta('Second partial'),
          { type: 'message_end', content: 'x', usage, provenance },
        ],
      ],
      5,
    );
    const controller = new AbortController();
    const deltas: string[] = [];

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: controller.signal,
      hooks: {
        onTextDelta: (text) => {
          deltas.push(text);
          if (text === 'First. ') controller.abort();
        },
      },
    });

    expect(result.aborted).toBe(true);
    expect(result.stopReason).toBe('aborted');
    expect(deltas).toEqual(['First. ']);
    expect(deltas).not.toContain('Second partial');
  });

  it('returns aborted immediately when the signal is already aborted', async () => {
    const provider = new FakeStreamProvider([
      [textDelta('never'), { type: 'message_end', content: 'x', usage, provenance }],
    ]);
    const controller = new AbortController();
    controller.abort();

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: 4,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.stopReason).toBe('aborted');
    expect(provider.streamCalls).toBe(0);
  });

  it('returns stream_error without throwing', async () => {
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

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: 2,
      signal: new AbortController().signal,
      logger,
    });

    expect(result.stopReason).toBe('stream_error');
    expect(result.error?.message).toBe('boom');
  });

  it('converts a throwing invokeTool into a tool_result error and continues', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    let captured: { content?: string; is_error?: boolean } | undefined;
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], usage, provenance }],
      [{ type: 'message_end', content: 'recovered', usage, provenance }],
    ]);
    const origStream = provider.stream.bind(provider);
    provider.stream = async function* (params: {
      messages?: unknown[];
      options?: Record<string, unknown>;
    }) {
      if (provider.streamCalls === 1 && Array.isArray(params.messages)) {
        const lastMsg = params.messages[params.messages.length - 1]! as {
          content: Array<{ content?: string; is_error?: boolean }>;
        };
        captured = lastMsg.content[0]!;
      }
      yield* origStream(params as never);
    } as never;

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: new AbortController().signal,
      invokeTool: async () => {
        throw new Error('boom');
      },
      logger,
    });

    expect(captured?.content).toContain("Tool 'lookup' failed: boom");
    expect(captured?.is_error).toBe(true);
    expect(result.finalText).toBe('recovered');
    expect(result.toolRounds).toBe(1);
  });

  it('exhausts at maxRounds and reports exhausted', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    const scripts: LLMStreamEvent[][] = Array.from({ length: DEFAULT_STREAMING_MAX_ROUNDS }, () => [
      { type: 'tool_use', toolCalls: [toolCall], usage, provenance },
    ]);
    const provider = new FakeStreamProvider(scripts);

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: new AbortController().signal,
      invokeTool: async () => ({ content: 'ok' }),
    });

    expect(result.exhausted).toBe(true);
    expect(result.stopReason).toBe('exhausted');
    expect(result.toolRounds).toBe(DEFAULT_STREAMING_MAX_ROUNDS);
    expect(provider.streamCalls).toBe(DEFAULT_STREAMING_MAX_ROUNDS);
  });

  it('rejects non-positive maxRounds', async () => {
    await expect(
      runStreamingToolLoop([], {
        provider: new FakeStreamProvider([]),
        model: 'fake',
        maxRounds: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/maxRounds/);
  });
});
