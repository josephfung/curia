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
  llmResponseAsStream,
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
    expect(invokeTool).toHaveBeenCalledWith(
      toolCall,
      expect.objectContaining({ messages: expect.any(Array) }),
    );
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
    // Terminal assistant uses THIS ROUND's deltas only — pre-tool narration is
    // already on the prior tool_use assistant turn and must not be duplicated.
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Post-tool spoken. ',
    });
  });

  it('closes unanswered tool_use ids with cancelled results on abort mid-invoke', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'lookup', input: { q: 'a' } },
      { id: 'call_2', name: 'lookup', input: { q: 'b' } },
    ];
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls, usage, provenance }],
    ]);
    const controller = new AbortController();
    let invokeCount = 0;

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
      signal: controller.signal,
      invokeTool: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          controller.abort();
          return { content: 'first-ok' };
        }
        return { content: 'should-not-run' };
      },
      logger,
    });

    expect(result.aborted).toBe(true);
    expect(result.stopReason).toBe('aborted');
    expect(invokeCount).toBe(1);
    // Assistant tool_use + user tool_result pairing must both be present.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('assistant');
    expect(result.messages[1]).toEqual(
      buildUserToolResultMessage([
        { id: 'call_1', content: 'first-ok' },
        { id: 'call_2', content: 'Tool execution cancelled (turn aborted).', isError: true },
      ]),
    );
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

  it('accepts openStream without provider.stream (chat-compatible adapter #1563)', async () => {
    const openStream = vi.fn(async function* () {
      yield textDelta('via ');
      yield { type: 'message_end' as const, content: 'via adapter', usage, provenance };
    });

    const result = await runStreamingToolLoop([{ role: 'user', content: 'hi' }], {
      provider: new NoStreamProvider(),
      model: 'fake',
      maxRounds: 2,
      signal: new AbortController().signal,
      openStream,
    });

    expect(openStream).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('message_end');
    expect(result.finalText).toBe('via adapter');
  });

  it('onToolUse returning stop exits before invokeTool (stopReason stopped)', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], usage, provenance }],
    ]);
    const invokeTool = vi.fn(async () => ({ content: 'should not run' }));

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: 3,
      signal: new AbortController().signal,
      invokeTool,
      hooks: {
        onToolUse: async () => 'stop',
      },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('stopped');
    expect(result.toolRounds).toBe(0);
  });

  it('afterTools returning stop exits after tool results are appended', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], content: 'checking', usage, provenance }],
      [{ type: 'message_end', content: 'should not reach', usage, provenance }],
    ]);

    const result = await runStreamingToolLoop([], {
      provider,
      model: 'fake',
      maxRounds: 3,
      signal: new AbortController().signal,
      invokeTool: async () => ({ content: '{"ok":true}' }),
      hooks: {
        afterTools: async () => 'stop',
      },
    });

    expect(result.stopReason).toBe('stopped');
    expect(result.toolRounds).toBe(1);
    expect(provider.streamCalls).toBe(1);
    // Assistant tool_use + user tool_result must both be present.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual(buildAssistantToolUseMessage([toolCall], 'checking'));
    expect(result.messages[1]).toEqual(
      buildUserToolResultMessage([{ id: 'call_1', content: '{"ok":true}' }]),
    );
  });

  it('beforeRound receives mutable working messages each LLM round', async () => {
    const toolCall: ToolCall = { id: 'call_1', name: 'lookup', input: {} };
    const provider = new FakeStreamProvider([
      [{ type: 'tool_use', toolCalls: [toolCall], usage, provenance }],
      [{ type: 'message_end', content: 'done', usage, provenance }],
    ]);
    const rounds: number[] = [];

    await runStreamingToolLoop([{ role: 'user', content: 'hi' }], {
      provider,
      model: 'fake',
      maxRounds: 3,
      signal: new AbortController().signal,
      invokeTool: async (_call, ctx) => {
        ctx?.messages.push({ role: 'system', content: 'injected' });
        return { content: 'ok' };
      },
      hooks: {
        beforeRound: async ({ round, messages: msgs }) => {
          rounds.push(round);
          if (round === 1) {
            expect(msgs.some((m) => m.role === 'system' && m.content === 'injected')).toBe(true);
          }
        },
      },
    });

    expect(rounds).toEqual([0, 1]);
  });
});

describe('llmResponseAsStream (#1563)', () => {
  it('maps text responses to text_delta + message_end', async () => {
    const events: LLMStreamEvent[] = [];
    for await (const event of llmResponseAsStream({
      type: 'text',
      content: 'hello',
      usage,
      provenance,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'message_end', content: 'hello', usage, provenance },
    ]);
  });

  it('maps empty text to message_end only', async () => {
    const events: LLMStreamEvent[] = [];
    for await (const event of llmResponseAsStream({
      type: 'text',
      content: '',
      usage,
      provenance,
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'message_end', content: '', usage, provenance }]);
  });

  it('maps tool_use and error responses', async () => {
    const toolCall: ToolCall = { id: 'c1', name: 'x', input: {} };
    const toolEvents: LLMStreamEvent[] = [];
    for await (const event of llmResponseAsStream({
      type: 'tool_use',
      toolCalls: [toolCall],
      content: 'preamble',
      usage,
      provenance,
    })) {
      toolEvents.push(event);
    }
    expect(toolEvents).toEqual([
      {
        type: 'tool_use',
        toolCalls: [toolCall],
        content: 'preamble',
        usage,
        provenance,
      },
    ]);

    const err = {
      type: 'RATE_LIMIT' as const,
      source: 'mock',
      message: 'slow down',
      retryable: true,
      context: {},
      timestamp: new Date(),
    };
    const errEvents: LLMStreamEvent[] = [];
    for await (const event of llmResponseAsStream({ type: 'error', error: err })) {
      errEvents.push(event);
    }
    expect(errEvents).toEqual([{ type: 'error', error: err }]);
  });
});
