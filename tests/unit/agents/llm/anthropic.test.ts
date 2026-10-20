// anthropic.test.ts — verifies cache_control placement in API calls.
//
// We mock the Anthropic SDK client so tests run without a real API key.
// The mock captures every call to client.messages.create() and lets us
// assert exactly what parameters were sent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { LLMStreamEvent, Message } from '../../../../src/agents/llm/provider.js';
import { buildAssistantToolUseMessage, buildUserToolResultMessage } from '../../../../src/agents/llm/tool-loop-messages.js';

// vi.mock is hoisted above variable declarations, so mockCreate must be
// declared with vi.hoisted() to be available inside the mock factory.
const mockCreate = vi.hoisted(() => vi.fn());
const mockStream = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  // Arrow functions are not constructable, so we use a class here.
  // AnthropicProvider calls `new Anthropic({ apiKey })` in its constructor.
  default: class {
    messages = { create: mockCreate, stream: mockStream };
  },
}));

// A valid text-only Anthropic API response. Used as the default mock return.
// Includes id, model, and cache token fields to match the full Anthropic SDK shape.
const makeTextResponse = () => ({
  id: 'msg_test_123',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  stop_reason: 'end_turn',
});

function makeStream(events: unknown[], finalMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
    // The provider calls stream.abort() in a finally to release the underlying fetch
    // Response/ReadableStream on every exit path (leak fix #1648). Mock it so streaming
    // tests still pass and cleanup can be asserted.
    abort: vi.fn(),
  };
}

async function collectStream(iterable: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('AnthropicProvider — provenance and cache tokens', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('returns provenance with requestedModel, actualModel, and providerRequestId on text response', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      options: { model: 'claude-opus-4-6' },
    });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.provenance.requestedModel).toBe('claude-opus-4-6');
    expect(result.provenance.actualModel).toBe('claude-sonnet-4-6'); // from mock response.model
    expect(result.provenance.providerRequestId).toBe('msg_test_123');
  });

  it('returns provenance on tool_use response', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg_tool_456',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'test' } }],
      usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      stop_reason: 'tool_use',
    });

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Search something' }],
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' as const, properties: {} } }],
    });

    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;
    expect(result.provenance.requestedModel).toBe('claude-sonnet-4-6');
    expect(result.provenance.actualModel).toBe('claude-sonnet-4-6');
    expect(result.provenance.providerRequestId).toBe('msg_tool_456');
  });

  it('defaults cache token fields to 0 when API returns null', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'claude-sonnet-4-6' });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.usage.cacheCreationInputTokens).toBe(0);
    expect(result.usage.cacheReadInputTokens).toBe(0);
  });

  it('captures non-zero cache tokens from the API response', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg_cache_789',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'cached' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1500, cache_read_input_tokens: 300 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'claude-sonnet-4-6' });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.usage.cacheCreationInputTokens).toBe(1500);
    expect(result.usage.cacheReadInputTokens).toBe(300);
  });

  it('uses explicit model param over options.model', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'claude-haiku-4-5',
      options: { model: 'claude-opus-4-6' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('claude-haiku-4-5');
  });

  it('falls back to options.model when model param is not provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      options: { model: 'claude-opus-4-6' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-4-6');
  });

  it('returns an error response when neither model param nor options.model is provided', async () => {
    // The guard is inside the try block so the error is caught and returned as
    // { type: 'error', ... } rather than thrown — preserving the LLMResponse contract.
    // The runtime always provides model via resolvedModel — a missing model indicates
    // a bug at the call site.
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.error.message).toMatch('AnthropicProvider.chat() requires a model');
    }
  });
});

describe('AnthropicProvider — prompt caching', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('passes system content as TextBlockParam[] with cache_control', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('omits system key entirely when no system messages', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.system).toBeUndefined();
  });

  it('concatenates multiple system messages into one block with cache_control', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'Part one.' },
        { role: 'system', content: 'Part two.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.system).toEqual([
      { type: 'text', text: 'Part one.\n\nPart two.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('passes user/assistant turns through 1:1 — consecutive user turns are not normalized (#1767)', async () => {
    // The Anthropic adapter does not merge or drop consecutive same-role turns.
    // The SDK will glue them silently; the runtime must not feed it this shape.
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'STALE_FAILED_PROMPT_xyz' },
        { role: 'user', content: 'fresh follow-up question' },
      ],
    });

    const params = mockCreate.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(params.messages).toEqual([
      { role: 'user', content: 'STALE_FAILED_PROMPT_xyz' },
      { role: 'user', content: 'fresh follow-up question' },
    ]);
  });

  it('forwards a post-failure runtime sequence without consecutive user turns (#1767)', async () => {
    // Shape the runtime now assembles after a failed call: the failed question
    // paired with the user-facing error text, then the new user message.
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'STALE_FAILED_PROMPT_xyz' },
        { role: 'assistant', content: "I'm sorry, I was unable to process that request. Please try again." },
        { role: 'user', content: 'fresh follow-up question' },
      ],
    });

    const params = mockCreate.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(params.messages.some((m) => m.content.includes('_curia_protocol'))).toBe(false);
    for (let i = 1; i < params.messages.length; i++) {
      expect(params.messages[i]!.role).not.toBe(params.messages[i - 1]!.role);
    }
  });

  it('adds cache_control only to the last tool when multiple tools provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'tool-a', description: 'First', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'tool-b', description: 'Second', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'tool-c', description: 'Third', input_schema: { type: 'object' as const, properties: {} } },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.tools[0].cache_control).toBeUndefined();
    expect(params.tools[1].cache_control).toBeUndefined();
    expect(params.tools[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('adds cache_control to the single tool when only one tool provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'only-tool', description: 'The one', input_schema: { type: 'object' as const, properties: {} } },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits tools key entirely when no tools provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.tools).toBeUndefined();
  });
});

describe('AnthropicProvider — temperature', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('sends temperature on chat when options.temperature is a finite number', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      options: { temperature: 0 },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.temperature).toBe(0);
  });

  it('omits temperature on chat when options.temperature is unset', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params).not.toHaveProperty('temperature');
  });

  it('warns and omits temperature when options.temperature is non-numeric', async () => {
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const provider = new AnthropicProvider('test-key', logger, new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      options: { temperature: 'hot' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params).not.toHaveProperty('temperature');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 'hot' }),
      expect.stringContaining('non-numeric options.temperature'),
    );
  });

  it('sends temperature on the streaming path when set', async () => {
    mockStream.mockReturnValue(makeStream([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    ], makeTextResponse()));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await collectStream(provider.stream({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      options: { temperature: 0 },
    }));

    const params = mockStream.mock.calls[0]![0];
    expect(params.temperature).toBe(0);
  });

  it('omits temperature on the streaming path when unset', async () => {
    mockStream.mockReturnValue(makeStream([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    ], makeTextResponse()));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await collectStream(provider.stream({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    }));

    const params = mockStream.mock.calls[0]![0];
    expect(params).not.toHaveProperty('temperature');
  });
});

// Haiku 5.5 400s on non-default sampling parameters and thinks by default (#2077).
describe('AnthropicProvider — claude-haiku-5-5 request shape', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it.each([0, 0.7, 1])('omits temperature %s on chat', async (temperature) => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      options: { temperature },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('omits temperature on the streaming path', async () => {
    mockStream.mockReturnValue(makeStream([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    ], makeTextResponse()));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await collectStream(provider.stream({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      options: { temperature: 0 },
    }));

    expect(mockStream.mock.calls[0]![0]).not.toHaveProperty('temperature');
  });

  it('sends thinking disabled on chat and stream', async () => {
    mockStream.mockReturnValue(makeStream([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    ], makeTextResponse()));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Hello' }] });
    await collectStream(provider.stream({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Hello' }] }));

    expect(mockCreate.mock.calls[0]![0].thinking).toEqual({ type: 'disabled' });
    expect(mockStream.mock.calls[0]![0].thinking).toEqual({ type: 'disabled' });
  });

  it('keeps the caller max_tokens cap (classify sends 10)', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'yes or no?' }],
      options: { max_tokens: 10 },
    });

    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(10);
  });

  it('leaves claude-haiku-4-5 requests unchanged: temperature sent, no thinking key', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Hello' }],
      options: { temperature: 0 },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.temperature).toBe(0);
    expect(params).not.toHaveProperty('thinking');
  });
});

describe('AnthropicProvider — stream', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  it('yields text deltas followed by a message_end event from finalMessage()', async () => {
    mockStream.mockReturnValue(makeStream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    ], {
      id: 'msg_stream_123',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 11, output_tokens: 4, cache_creation_input_tokens: null, cache_read_input_tokens: 2 },
      stop_reason: 'end_turn',
    }));

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'claude-sonnet-4-6',
    }));

    expect(events).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'message_end',
        content: 'hello',
        usage: { inputTokens: 11, outputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 2 },
        provenance: { requestedModel: 'claude-sonnet-4-6', actualModel: 'claude-sonnet-4-6', providerRequestId: 'msg_stream_123' },
      },
    ]);
  });

  it('yields tool_use at the end when finalMessage() contains tool_use blocks', async () => {
    mockStream.mockReturnValue(makeStream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
    ], {
      id: 'msg_stream_tool',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'curia' } },
      ],
      usage: { input_tokens: 21, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'tool_use',
    }));

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Search' }],
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' as const, properties: {} } }],
    }));

    expect(events[0]).toEqual({ type: 'text_delta', text: 'Let me check.' });
    expect(events[1]).toEqual({
      type: 'tool_use',
      toolCalls: [{ id: 'toolu_1', name: 'search', input: { query: 'curia' } }],
      content: 'Let me check.',
      usage: { inputTokens: 21, outputTokens: 9, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: { requestedModel: 'claude-sonnet-4-6', actualModel: 'claude-sonnet-4-6', providerRequestId: 'msg_stream_tool' },
    });
  });

  it('passes AbortSignal through to messages.stream()', async () => {
    mockStream.mockReturnValue(makeStream([], {
      id: 'msg_abort',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
    }));
    const controller = new AbortController();
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));

    await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'claude-sonnet-4-6',
      options: { signal: controller.signal },
    }));

    expect(mockStream.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  // Leak fix (#1648): the provider must release the underlying SDK MessageStream (its
  // fetch Response/ReadableStream) on every exit path, or undrained streams retain their
  // response ArrayBuffers on the heap. See anthropics/claude-code#33380.
  const streamFinal = () => ({
    id: 'msg_cleanup',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: 'end_turn',
  });

  it('aborts the underlying stream after normal completion (releases the response buffer)', async () => {
    const stream = makeStream(
      [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
      streamFinal(),
    );
    mockStream.mockReturnValue(stream);

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'claude-sonnet-4-6' }));

    expect(stream.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying stream when the consumer stops iterating early', async () => {
    const stream = makeStream(
      [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } },
      ],
      streamFinal(),
    );
    mockStream.mockReturnValue(stream);

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    // Break after the first event: the async generator's finally must still run and
    // abort the SDK stream, otherwise its Response buffer leaks.
    const seen: LLMStreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'claude-sonnet-4-6' })) {
      seen.push(event);
      break;
    }

    expect(seen).toHaveLength(1);
    expect(stream.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying stream and yields an error when iteration throws', async () => {
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error('mid-stream boom')),
        };
      },
      finalMessage: vi.fn(),
      abort: vi.fn(),
    };
    mockStream.mockReturnValue(stream);

    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'claude-sonnet-4-6' }));

    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('AnthropicProvider — reasoning tokens (ADR-048 §5)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  const withThinkingTokens = (thinkingTokens: number | null) => ({
    ...makeTextResponse(),
    usage: {
      input_tokens: 10,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens_details: thinkingTokens === null ? null : { thinking_tokens: thinkingTokens },
    },
  });

  it('reports output_tokens_details.thinking_tokens as reasoningTokens', async () => {
    mockCreate.mockResolvedValue(withThinkingTokens(37));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'claude-haiku-5-5' });
    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.usage.reasoningTokens).toBe(37);
    expect(result.usage.outputTokens).toBe(50);
  });

  it('reports a zero count as 0', async () => {
    mockCreate.mockResolvedValue(withThinkingTokens(0));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'claude-haiku-5-5' });
    expect(result.type === 'text' && result.usage.reasoningTokens).toBe(0);
  });

  it('leaves reasoningTokens unset when the API omits output_tokens_details', async () => {
    mockCreate.mockResolvedValue(withThinkingTokens(null));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'claude-sonnet-4-6' });
    expect(result.type === 'text' && 'reasoningTokens' in result.usage).toBe(false);
  });

  it('reports thinking tokens from a streamed finalMessage()', async () => {
    mockStream.mockReturnValue(makeStream([], withThinkingTokens(21)));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'claude-haiku-5-5',
    }));
    const end = events.at(-1);
    expect(end?.type === 'message_end' && end.usage.reasoningTokens).toBe(21);
  });
});

describe('AnthropicProvider — reasoning pass-back (ADR-048 §1)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  const tools = [{ name: 'lookup', description: 'Look up', input_schema: { type: 'object' as const, properties: {} } }];
  const thinking = { type: 'thinking', thinking: 'Check the calendar first.', signature: 'sig-1' };
  const redacted = { type: 'redacted_thinking', data: 'ENCRYPTED' };

  function toolUseResponse(model: string, reasoning: unknown[], id = 'toolu_1') {
    return {
      id: `msg_${id}`,
      model,
      content: [...reasoning, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id, name: 'lookup', input: {} }],
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      stop_reason: 'tool_use',
    };
  }

  /** Run one round: the response for `messages`, and the messages for the next request. */
  async function round(provider: AnthropicProvider, model: string, messages: Message[], system = 'You are Curia.', roundTools = tools) {
    const result = await provider.chat({ messages: [{ role: 'system', content: system }, ...messages], tools: roundTools, model });
    if (result.type !== 'tool_use') throw new Error(`expected tool_use, got ${result.type}`);
    const call = result.toolCalls[0]!;
    return {
      result,
      next: [
        ...messages,
        buildAssistantToolUseMessage(result.toolCalls, result.content, result.reasoningBlocks),
        buildUserToolResultMessage([{ id: call.id, content: 'result' }]),
      ],
    };
  }

  /** Content block types of each assistant message in a captured request. */
  function assistantBlockTypes(callIndex: number): string[][] {
    const params = mockCreate.mock.calls[callIndex]![0] as { messages: Array<{ role: string; content: Array<{ type: string }> | string }> };
    return params.messages
      .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
      .map((m) => (m.content as Array<{ type: string }>).map((b) => b.type));
  }

  it('captures thinking and redacted_thinking in order, and sends them back first and unmodified', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolUseResponse('claude-sonnet-4-6', [thinking, redacted]));
    const first = await round(provider, 'claude-sonnet-4-6', [{ role: 'user', content: 'Plan my day' }]);
    expect(first.result.reasoningBlocks?.map((b) => b.data)).toEqual([thinking, redacted]);
    expect(first.result.reasoning).toBe('Check the calendar first.');

    mockCreate.mockResolvedValueOnce(makeTextResponse());
    await provider.chat({ messages: first.next, tools, model: 'claude-sonnet-4-6' });
    const sent = mockCreate.mock.calls[1]![0] as { messages: Array<{ role: string; content: unknown }> };
    const assistant = sent.messages[1]!.content as unknown[];
    expect(assistant.slice(0, 2)).toEqual([thinking, redacted]);
    expect(assistantBlockTypes(1)).toEqual([['thinking', 'redacted_thinking', 'text', 'tool_use']]);
  });

  it('drops reasoning written by another model', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolUseResponse('claude-sonnet-4-6', [thinking]));
    const first = await round(provider, 'claude-sonnet-4-6', [{ role: 'user', content: 'Plan my day' }]);

    mockCreate.mockResolvedValueOnce(makeTextResponse());
    await provider.chat({ messages: first.next, tools, model: 'claude-opus-4-6' });
    expect(assistantBlockTypes(1)).toEqual([['text', 'tool_use']]);
  });

  it('records signature-only thinking as encrypted reasoning for the archive', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [{ type: 'thinking', thinking: '', signature: 'sig' }]));
    const { result } = await round(provider, 'claude-haiku-5-5', [{ role: 'user', content: 'Hi' }]);
    expect(result.reasoning).toBeUndefined();
    expect(result.reasoningOmitted).toBe('encrypted');
  });

  describe('prefix guard', () => {
    it('stamps blocks from a prefix-bound model with the request hash, and not others', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking]));
      const bound = await round(provider, 'claude-haiku-5-5', [{ role: 'user', content: 'Hi' }]);
      expect(bound.result.reasoningBlocks?.[0]?.prefixHash).toMatch(/^[0-9a-f]{64}$/);

      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-sonnet-4-6', [thinking]));
      const unbound = await round(provider, 'claude-sonnet-4-6', [{ role: 'user', content: 'Hi' }]);
      expect(unbound.result.reasoningBlocks?.[0]?.prefixHash).toBeUndefined();
    });

    it('sends every block while the prefix is unchanged', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking], 'toolu_1'));
      const r1 = await round(provider, 'claude-haiku-5-5', [{ role: 'user', content: 'Hi' }]);
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking], 'toolu_2'));
      const r2 = await round(provider, 'claude-haiku-5-5', r1.next);
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      await provider.chat({ messages: [{ role: 'system', content: 'You are Curia.' }, ...r2.next], tools, model: 'claude-haiku-5-5' });
      expect(assistantBlockTypes(2)).toEqual([
        ['thinking', 'text', 'tool_use'],
        ['thinking', 'text', 'tool_use'],
      ]);
    });

    it('drops every block after the system prompt changes', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking], 'toolu_1'));
      const r1 = await round(provider, 'claude-haiku-5-5', [{ role: 'user', content: 'Hi' }]);
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking], 'toolu_2'));
      const r2 = await round(provider, 'claude-haiku-5-5', r1.next);
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      // The Bullpen refresh replaces a system message between rounds.
      await provider.chat({ messages: [{ role: 'system', content: 'You are Curia.\n[Bullpen] new thread' }, ...r2.next], tools, model: 'claude-haiku-5-5' });
      expect(assistantBlockTypes(2)).toEqual([['text', 'tool_use'], ['text', 'tool_use']]);
    });

    it('drops every block after the tool list changes', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking]));
      const r1 = await round(provider, 'claude-haiku-5-5', [{ role: 'user', content: 'Hi' }]);
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      // Tool discovery adds a tool mid-loop.
      const discovered = [...tools, { name: 'calendar', description: 'Calendar', input_schema: { type: 'object' as const, properties: {} } }];
      await provider.chat({ messages: [{ role: 'system', content: 'You are Curia.' }, ...r1.next], tools: discovered, model: 'claude-haiku-5-5' });
      expect(assistantBlockTypes(1)).toEqual([['text', 'tool_use']]);
    });

    it('keeps blocks before an edited message and drops the ones after it', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking], 'toolu_1'));
      const r1 = await round(provider, 'claude-haiku-5-5', [{ role: 'user', content: 'Hi' }]);
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-haiku-5-5', [thinking], 'toolu_2'));
      const r2 = await round(provider, 'claude-haiku-5-5', r1.next);
      // Edit the first tool result, which sits between the two assistant turns.
      const edited = r2.next.map((m, i) => (i === 2 ? buildUserToolResultMessage([{ id: 'toolu_1', content: 'shortened' }]) : m));
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      await provider.chat({ messages: [{ role: 'system', content: 'You are Curia.' }, ...edited], tools, model: 'claude-haiku-5-5' });
      expect(assistantBlockTypes(2)).toEqual([['thinking', 'text', 'tool_use'], ['text', 'tool_use']]);
    });

    it('does not check models that do not bind thinking to the prefix', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      mockCreate.mockResolvedValueOnce(toolUseResponse('claude-sonnet-4-6', [thinking]));
      const r1 = await round(provider, 'claude-sonnet-4-6', [{ role: 'user', content: 'Hi' }]);
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      await provider.chat({ messages: [{ role: 'system', content: 'Changed system' }, ...r1.next], tools, model: 'claude-sonnet-4-6' });
      expect(assistantBlockTypes(1)).toEqual([['thinking', 'text', 'tool_use']]);
    });

    it('treats a block with no recorded hash as stale on a prefix-bound model', async () => {
      const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      const unstamped = buildAssistantToolUseMessage(
        [{ id: 'toolu_1', name: 'lookup', input: {} }],
        undefined,
        [{ type: 'reasoning', provider: 'anthropic', model: 'claude-haiku-5-5', data: thinking }],
      );
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }, unstamped, buildUserToolResultMessage([{ id: 'toolu_1', content: 'r' }])],
        tools,
        model: 'claude-haiku-5-5',
      });
      expect(assistantBlockTypes(0)).toEqual([['tool_use']]);
    });
  });

  it('carries thinking from a streamed tool_use turn', async () => {
    mockStream.mockReturnValue(makeStream([], toolUseResponse('claude-sonnet-4-6', [thinking])));
    const provider = new AnthropicProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Hi' }], tools, model: 'claude-sonnet-4-6' }));
    const toolUse = events.at(-1);
    expect(toolUse?.type === 'tool_use' && toolUse.reasoningBlocks?.map((b) => b.data)).toEqual([thinking]);
  });
});
