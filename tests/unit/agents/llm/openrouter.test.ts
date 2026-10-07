// openrouter.test.ts — tests for the OpenRouter LLM provider.
//
// Mocks the openai SDK so tests run without a real API key.
// Follows the same pattern as anthropic.test.ts: vi.hoisted mockCreate,
// vi.mock to stub the SDK, and createSilentLogger for silent logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterProvider, usageFromOpenRouter } from '../../../../src/agents/llm/openrouter.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { LLMStreamEvent } from '../../../../src/agents/llm/provider.js';

// vi.mock is hoisted above variable declarations, so mockCreate must be
// declared with vi.hoisted() to be available inside the mock factory.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  // The OpenRouterProvider calls `new OpenAI({ apiKey, baseURL })` in its
  // constructor. Arrow functions are not constructable, so we use a class.
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

// A valid text-only OpenAI chat completion response shape.
// id and model match OpenRouter's response format.
const makeTextResponse = () => ({
  id: 'chatcmpl-test-123',
  model: 'google/gemini-2.0-flash-001',
  choices: [
    {
      index: 0,
      finish_reason: 'stop' as const,
      message: {
        role: 'assistant' as const,
        content: 'hello from openrouter',
        tool_calls: undefined,
        refusal: null,
      },
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  object: 'chat.completion' as const,
  created: 1700000000,
});

function makeStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    // The provider calls stream.controller.abort() in a finally to release the
    // underlying fetch Response/ReadableStream on every exit path (leak fix #1648/#1651).
    // Mirror the OpenAI SDK Stream's `controller: AbortController` so streaming tests
    // still run and cleanup can be asserted.
    controller: { abort: vi.fn() },
  };
}

async function collectStream(iterable: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('OpenRouterProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('returns correct LLMResponse shape for a text response with usage and provenance', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
    });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;

    // Content
    expect(result.content).toBe('hello from openrouter');

    // Usage — no prompt_tokens_details, so no cache tokens
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    });

    // Provenance
    expect(result.provenance.requestedModel).toBe('google/gemini-2.0-flash-001');
    expect(result.provenance.actualModel).toBe('google/gemini-2.0-flash-001');
    expect(result.provenance.providerRequestId).toBe('chatcmpl-test-123');
  });

  it('maps tool calls to Curia ToolCall shape', async () => {
    mockCreate.mockResolvedValue({
      id: 'chatcmpl-tool-456',
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"query":"test"}',
                },
              },
            ],
          },
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      object: 'chat.completion',
      created: 1700000000,
    });

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Search something' }],
      model: 'openai/gpt-4o',
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' as const, properties: {} } }],
    });

    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_abc123',
      name: 'search',
      input: { query: 'test' },
    });

    // Content should be undefined when no text preamble
    expect(result.content).toBeUndefined();

    // Provenance
    expect(result.provenance.requestedModel).toBe('openai/gpt-4o');
    expect(result.provenance.actualModel).toBe('openai/gpt-4o');
    expect(result.provenance.providerRequestId).toBe('chatcmpl-tool-456');
  });

  it('handles mixed response (text + tool calls)', async () => {
    mockCreate.mockResolvedValue({
      id: 'chatcmpl-mixed-789',
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Let me look that up for you.',
            refusal: null,
            tool_calls: [
              {
                id: 'call_def456',
                type: 'function',
                function: {
                  name: 'lookup',
                  arguments: '{"id":"42"}',
                },
              },
            ],
          },
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      object: 'chat.completion',
      created: 1700000000,
    });

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Look up item 42' }],
      model: 'openai/gpt-4o',
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' as const, properties: {} } }],
    });

    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;

    // Both content and toolCalls should be populated
    expect(result.content).toBe('Let me look that up for you.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('lookup');
    expect(result.toolCalls[0]!.input).toEqual({ id: '42' });
  });

  it('catches exceptions and returns classified error response', async () => {
    const apiError = Object.assign(new Error('API request failed'), { status: 500 });
    mockCreate.mockRejectedValue(apiError);

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') return;

    expect(result.error.type).toBe('PROVIDER_ERROR');
    expect(result.error.source).toBe('openrouter');
  });

  it('surfaces OpenRouter upstream provider_error detail in the classified error message', async () => {
    // OpenRouter wraps upstream provider (Google/Anthropic/etc.) failures as a
    // terse "400 Provider returned error", burying the real cause in
    // err.error.metadata. This is exactly the shape the OpenAI SDK's APIError
    // carries for an OpenRouter 400 whose upstream Google request was rejected.
    const upstreamRaw = JSON.stringify({
      error: {
        code: 400,
        message:
          '* GenerateContentRequest.tools[0].function_declarations[31].parameters.required[0]: property is not defined',
        status: 'INVALID_ARGUMENT',
      },
    });
    const apiError = Object.assign(new Error('400 Provider returned error'), {
      status: 400,
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: { provider_name: 'Google', raw: upstreamRaw },
      },
    });
    mockCreate.mockRejectedValue(apiError);

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-3.1-flash-lite',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    // The upstream provider name and the underlying reason must both survive
    // into last_error so the next failure isn't a week-long silent suspension.
    // The reason leads (so it survives truncation); the wrapper trails.
    expect(result.error.message).toMatch(/^Google: /);
    expect(result.error.message).toContain('property is not defined');
    expect(result.error.message).toContain('400 Provider returned error');
    expect(result.error.context.providerName).toBe('Google');
    // Status-derived classification must be unchanged by the enrichment.
    expect(result.error.type).toBe('VALIDATION_ERROR');
  });

  it('caps an oversized non-JSON upstream raw body so the reason is not truncated away', async () => {
    // When metadata.raw is not JSON, we fall back to the raw string. A large
    // blob must be capped so the leading provider+reason survives classify.ts's
    // 400-char message truncation.
    const hugeRaw = 'x'.repeat(5000);
    const apiError = Object.assign(new Error('400 Provider returned error'), {
      status: 400,
      error: { metadata: { provider_name: 'Google', raw: hugeRaw } },
    });
    mockCreate.mockRejectedValue(apiError);

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-3.1-flash-lite',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    expect(result.error.message).toMatch(/^Google: /);
    expect(result.error.message).toContain('…');
  });

  it('returns error when no model is provided', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    expect(result.error.message).toMatch(/requires a model/);
  });

  it('concatenates multiple system messages into a single system role message', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'google/gemini-2.0-flash-001',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    // System messages should be merged into a single system role entry
    const systemMessages = params.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe('You are helpful.\n\nBe concise.');

    // Non-system messages should follow
    const nonSystemMessages = params.messages.filter((m: { role: string }) => m.role !== 'system');
    expect(nonSystemMessages).toHaveLength(1);
    expect(nonSystemMessages[0].role).toBe('user');
  });

  it('maps image content to OpenAI image_url format', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model: 'google/gemini-2.0-flash-001',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUg==',
              },
            },
          ],
        },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    const userMsg = params.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toHaveLength(2);

    // Text part should be mapped directly
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'What is in this image?' });

    // Image part should be mapped to OpenAI image_url format with data URI
    expect(userMsg.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
    });
  });

  it('populates provenance with actualModel from response when it differs from requested', async () => {
    // OpenRouter may route to a different model variant than requested
    mockCreate.mockResolvedValue({
      id: 'chatcmpl-alias-001',
      model: 'google/gemini-2.0-flash-001:free',  // actual model differs
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'aliased response',
            tool_calls: undefined,
            refusal: null,
          },
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      object: 'chat.completion',
      created: 1700000000,
    });

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
    });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;

    // requestedModel is what we asked for; actualModel is what OpenRouter responded with
    expect(result.provenance.requestedModel).toBe('google/gemini-2.0-flash-001');
    expect(result.provenance.actualModel).toBe('google/gemini-2.0-flash-001:free');
    expect(result.provenance.providerRequestId).toBe('chatcmpl-alias-001');
  });

  it('falls back to options.model when model param is not provided', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      options: { model: 'openai/gpt-4o' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('openai/gpt-4o');
  });

  it('uses explicit model param over options.model', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'deepseek/deepseek-chat-v3-0324',
      options: { model: 'openai/gpt-4o' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('deepseek/deepseek-chat-v3-0324');
  });

  it('logs warn when finish_reason is "length" (response truncated by max_tokens cap)', async () => {
    mockCreate.mockResolvedValue({
      ...makeTextResponse(),
      choices: [
        {
          index: 0,
          finish_reason: 'length',  // model hit the output token cap
          message: {
            role: 'assistant' as const,
            content: 'This response was cut off mid-',
            tool_calls: undefined,
            refusal: null,
          },
          logprobs: null,
        },
      ],
    });

    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const provider = new OpenRouterProvider('test-key', logger, new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Write a long essay' }],
      model: 'google/gemini-2.0-flash-001',
    });

    // Response should still be returned as text — truncation doesn't cause an error
    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.content).toBe('This response was cut off mid-');

    // Warn must fire with finish_reason and model in the log bindings
    expect(warnSpy).toHaveBeenCalledOnce();
    const [bindings, message] = warnSpy.mock.calls[0]! as [Record<string, unknown>, string];
    expect(bindings).toMatchObject({ model: 'google/gemini-2.0-flash-001', finishReason: 'length' });
    expect(message).toMatch(/truncated/);
  });

  it('does not log warn for normal stop finish_reason', async () => {
    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const provider = new OpenRouterProvider('test-key', logger, new ModelRegistry(createSilentLogger()));
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
    });

    // No warn should fire for a clean stop
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// Usage payloads in OpenRouter's documented shape (openrouter.ai/docs: prompt
// caching and usage accounting). prompt_tokens is the whole prompt; the cached
// share is broken out in prompt_tokens_details (#1962).
const CACHE_HIT_USAGE = {
  prompt_tokens: 10339,
  completion_tokens: 60,
  total_tokens: 10399,
  prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 0 },
};
const CACHE_WRITE_USAGE = {
  prompt_tokens: 194,
  completion_tokens: 2,
  total_tokens: 196,
  completion_tokens_details: { reasoning_tokens: 0 },
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 },
  cost: 0.95,
};

describe('usageFromOpenRouter', () => {
  it('splits cache reads out of prompt_tokens on a cached completion', () => {
    expect(usageFromOpenRouter(CACHE_HIT_USAGE)).toEqual({
      inputTokens: 21,
      outputTokens: 60,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10318,
      reasoningTokens: 0,
    });
  });

  it('splits cache writes out of prompt_tokens', () => {
    expect(usageFromOpenRouter(CACHE_WRITE_USAGE)).toEqual({
      inputTokens: 94,
      outputTokens: 2,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('reports all input as uncached when prompt_tokens_details is absent', () => {
    expect(usageFromOpenRouter({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('never reports negative input when cached counts exceed prompt_tokens', () => {
    const usage = usageFromOpenRouter({
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 8 } as { cached_tokens: number },
    });
    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadInputTokens).toBe(8);
    expect(usage.cacheCreationInputTokens).toBe(8);
  });

  it('returns zeros for missing usage', () => {
    expect(usageFromOpenRouter(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('records reasoning_tokens without removing them from outputTokens', () => {
    expect(usageFromOpenRouter({
      prompt_tokens: 10,
      completion_tokens: 50,
      total_tokens: 60,
      completion_tokens_details: { reasoning_tokens: 42 },
    })).toMatchObject({ outputTokens: 50, reasoningTokens: 42 });
  });
});

describe('OpenRouterProvider — cache usage', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('reports cache reads from chat() on a text response', async () => {
    mockCreate.mockResolvedValue({ ...makeTextResponse(), usage: CACHE_HIT_USAGE });
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
    });
    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.usage.cacheReadInputTokens).toBe(10318);
    expect(result.usage.inputTokens).toBe(21);
  });

  it('reports cache reads from chat() on a tool_use response', async () => {
    const response = makeTextResponse();
    mockCreate.mockResolvedValue({
      ...response,
      choices: [{
        ...response.choices[0]!,
        finish_reason: 'tool_calls' as const,
        message: {
          ...response.choices[0]!.message,
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        },
      }],
      usage: CACHE_HIT_USAGE,
    });
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
    });
    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;
    expect(result.usage.cacheReadInputTokens).toBe(10318);
  });

  it('reports cache reads and writes from stream()', async () => {
    mockCreate.mockResolvedValue(makeStream([
      {
        id: 'chatcmpl-stream-cache',
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop', logprobs: null }],
        usage: null,
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
      {
        id: 'chatcmpl-stream-cache',
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [],
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 40,
          total_tokens: 5040,
          prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 600 },
        },
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
    ]));
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'deepseek/deepseek-v4.1-flash',
    }));
    const end = events.at(-1);
    expect(end?.type).toBe('message_end');
    if (end?.type !== 'message_end') return;
    expect(end.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cacheCreationInputTokens: 600,
      cacheReadInputTokens: 4000,
      reasoningTokens: 0,
    });
  });
});

describe('OpenRouterProvider — stream', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('yields content deltas followed by a message_end event with final usage', async () => {
    mockCreate.mockResolvedValue(makeStream([
      {
        id: 'chatcmpl-stream-123',
        model: 'openai/gpt-4o',
        choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null, logprobs: null }],
        usage: null,
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
      {
        id: 'chatcmpl-stream-123',
        model: 'openai/gpt-4o',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop', logprobs: null }],
        usage: null,
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
      {
        id: 'chatcmpl-stream-123',
        model: 'openai/gpt-4o',
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
    ]));

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'openai/gpt-4o',
    }));

    expect(events).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'message_end',
        content: 'hello',
        usage: { inputTokens: 12, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
        provenance: { requestedModel: 'openai/gpt-4o', actualModel: 'openai/gpt-4o', providerRequestId: 'chatcmpl-stream-123' },
      },
    ]);
    const params = mockCreate.mock.calls[0]![0];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it('accumulates index-based tool call deltas and yields one tool_use event', async () => {
    mockCreate.mockResolvedValue(makeStream([
      {
        id: 'chatcmpl-stream-tool',
        model: 'openai/gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              content: 'Checking. ',
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query"' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
        usage: null,
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
      {
        id: 'chatcmpl-stream-tool',
        model: 'openai/gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"curia"}' } }],
            },
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
        usage: null,
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
      {
        id: 'chatcmpl-stream-tool',
        model: 'openai/gpt-4o',
        choices: [],
        usage: { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 },
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
    ]));

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Search' }],
      model: 'openai/gpt-4o',
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' as const, properties: {} } }],
    }));

    expect(events[0]).toEqual({ type: 'text_delta', text: 'Checking. ' });
    expect(events[1]).toEqual({
      type: 'tool_use',
      toolCalls: [{ id: 'call_1', name: 'search', input: { query: 'curia' } }],
      content: 'Checking. ',
      usage: { inputTokens: 22, outputTokens: 8, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
      provenance: { requestedModel: 'openai/gpt-4o', actualModel: 'openai/gpt-4o', providerRequestId: 'chatcmpl-stream-tool' },
    });
  });

  describe('temperature', () => {
    it('sends temperature on chat when options.temperature is a finite number', async () => {
      const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      await provider.chat({
        model: 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: 'Hello' }],
        options: { temperature: 0 },
      });

      const params = mockCreate.mock.calls[0]![0];
      expect(params.temperature).toBe(0);
    });

    it('omits temperature on chat when options.temperature is unset', async () => {
      const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      await provider.chat({
        model: 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const params = mockCreate.mock.calls[0]![0];
      expect(params).not.toHaveProperty('temperature');
    });

    it('warns and omits temperature when options.temperature is non-numeric', async () => {
      const logger = createSilentLogger();
      const warn = vi.spyOn(logger, 'warn');
      const provider = new OpenRouterProvider('test-key', logger, new ModelRegistry(createSilentLogger()));
      await provider.chat({
        model: 'google/gemini-2.0-flash-001',
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
      mockCreate.mockResolvedValue(makeStream([
        {
          id: 'chatcmpl-temp',
          model: 'openai/gpt-4o',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          object: 'chat.completion.chunk',
          created: 1700000000,
        },
      ]));
      const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      await collectStream(provider.stream({
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'openai/gpt-4o',
        options: { temperature: 0 },
      }));

      const params = mockCreate.mock.calls[0]![0];
      expect(params.temperature).toBe(0);
      expect(params.stream).toBe(true);
    });

    it('omits temperature on the streaming path when unset', async () => {
      mockCreate.mockResolvedValue(makeStream([
        {
          id: 'chatcmpl-temp-unset',
          model: 'openai/gpt-4o',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          object: 'chat.completion.chunk',
          created: 1700000000,
        },
      ]));
      const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
      await collectStream(provider.stream({
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'openai/gpt-4o',
      }));

      const params = mockCreate.mock.calls[0]![0];
      expect(params).not.toHaveProperty('temperature');
    });
  });

  it('passes AbortSignal through to chat.completions.create()', async () => {
    mockCreate.mockResolvedValue(makeStream([
      {
        id: 'chatcmpl-abort',
        model: 'openai/gpt-4o',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
    ]));
    const controller = new AbortController();
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));

    await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'openai/gpt-4o',
      options: { signal: controller.signal },
    }));

    expect(mockCreate.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  // Leak-parity fix (#1651, mirrors #1648): the provider must release the underlying
  // OpenAI SDK Stream (its fetch Response/ReadableStream) on every exit path via
  // stream.controller.abort(), or an undrained stream retains its response buffers on
  // the V8 heap. Exercised by voice in prod today.
  const okChunk = () => ({
    id: 'chatcmpl-cleanup',
    model: 'openai/gpt-4o',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    object: 'chat.completion.chunk',
    created: 1700000000,
  });

  it('aborts the underlying stream after normal completion (releases the response buffer)', async () => {
    const stream = makeStream([okChunk()]);
    mockCreate.mockResolvedValue(stream);

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'openai/gpt-4o' }));

    expect(stream.controller.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying stream when the consumer stops iterating early', async () => {
    const stream = makeStream([
      {
        id: 'chatcmpl-early', model: 'openai/gpt-4o',
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null, logprobs: null }],
        usage: null, object: 'chat.completion.chunk', created: 1700000000,
      },
      {
        id: 'chatcmpl-early', model: 'openai/gpt-4o',
        choices: [{ index: 0, delta: { content: 'b' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, object: 'chat.completion.chunk', created: 1700000000,
      },
    ]);
    mockCreate.mockResolvedValue(stream);

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    // Break after the first event: the async generator's finally must still run and
    // abort the SDK stream, otherwise its Response buffer leaks.
    const seen: LLMStreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'openai/gpt-4o' })) {
      seen.push(event);
      break;
    }

    expect(seen).toHaveLength(1);
    expect(stream.controller.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying stream and yields an error when iteration throws', async () => {
    const stream = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('mid-stream boom')) };
      },
      controller: { abort: vi.fn() },
    };
    mockCreate.mockResolvedValue(stream);

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'openai/gpt-4o' }));

    expect(stream.controller.abort).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });
});

const REASONING_MODEL = 'deepseek/deepseek-v4.1-flash';

function reasoningUsage(reasoningTokens: number) {
  return {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

function chatCompletion(message: Record<string, unknown>, reasoningTokens: number, finish: 'stop' | 'tool_calls' = 'stop') {
  return {
    id: 'chatcmpl-reason',
    model: REASONING_MODEL,
    choices: [{
      index: 0,
      finish_reason: finish,
      message: {
        role: 'assistant',
        content: 'done',
        refusal: null,
        ...message,
      },
      logprobs: null,
    }],
    usage: reasoningUsage(reasoningTokens),
    object: 'chat.completion' as const,
    created: 1700000000,
  };
}

function streamChunks(
  deltas: Array<Record<string, unknown>>,
  reasoningTokens: number,
  finish: 'stop' | 'tool_calls',
) {
  const contentDeltas = deltas.length > 0 ? deltas : [{}];
  return makeStream([
    ...contentDeltas.map((delta, index) => ({
      id: 'chatcmpl-reason-stream',
      model: REASONING_MODEL,
      choices: [{
        index: 0,
        delta,
        finish_reason: index === contentDeltas.length - 1 ? finish : null,
        logprobs: null,
      }],
      usage: null,
      object: 'chat.completion.chunk',
      created: 1700000000,
    })),
    {
      id: 'chatcmpl-reason-stream',
      model: REASONING_MODEL,
      choices: [],
      usage: reasoningUsage(reasoningTokens),
      object: 'chat.completion.chunk',
      created: 1700000000,
    },
  ]);
}

describe('OpenRouterProvider — reasoning (#2042)', () => {
  const provider = () => new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));

  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe.each(['text', 'tool_use'] as const)('%s', (kind) => {
    const toolMessage = kind === 'tool_use'
      ? {
          content: 'Checking the thread.',
          tool_calls: [{
            id: 'call_reason',
            type: 'function',
            function: { name: 'email-send', arguments: '{"to":"a@b.test"}' },
          }],
        }
      : { content: 'The answer is 4.' };

    const toolDeltas = kind === 'tool_use'
      ? [
          { content: 'Checking the thread.' },
          {
            tool_calls: [{
              index: 0,
              id: 'call_reason',
              type: 'function',
              function: { name: 'email-send', arguments: '{"to":"a@b.test"}' },
            }],
          },
        ]
      : [{ content: 'The answer is 4.' }];

    const finish = kind === 'tool_use' ? 'tool_calls' as const : 'stop' as const;

    async function read(extras: Array<Record<string, unknown>>, reasoningTokens: number) {
      mockCreate.mockResolvedValueOnce(chatCompletion({ ...toolMessage, ...extras[0] }, reasoningTokens, finish));
      const chat = await provider().chat({
        messages: [{ role: 'user', content: 'Hello' }],
        model: REASONING_MODEL,
      });
      mockCreate.mockResolvedValueOnce(streamChunks(
        toolDeltas.map((delta, index) => ({ ...delta, ...(extras[index] ?? {}) })),
        reasoningTokens,
        finish,
      ));
      const events = await collectStream(provider().stream({
        messages: [{ role: 'user', content: 'Hello' }],
        model: REASONING_MODEL,
      }));
      const streamed = events.at(-1);
      return { chat, streamed };
    }

    it('reads message.reasoning and the reasoning-token count on chat and stream', async () => {
      const reasoningDelta = kind === 'tool_use'
        ? [{ reasoning: 'Look up ' }, { reasoning: 'the address.' }]
        : [{ reasoning: 'Add the numbers.' }];
      const { chat, streamed } = await read(
        kind === 'tool_use'
          ? [{ reasoning: 'Look up the address.' }, {}]
          : [{ reasoning: 'Add the numbers.' }],
        11,
      );
      // Re-run stream with split reasoning deltas. The shared helper puts the
      // whole string on the first chat message and the first stream delta.
      mockCreate.mockReset();
      mockCreate.mockResolvedValueOnce(streamChunks(
        toolDeltas.map((delta, index) => ({ ...delta, ...(reasoningDelta[index] ?? {}) })),
        11,
        finish,
      ));
      const split = await collectStream(provider().stream({
        messages: [{ role: 'user', content: 'Hello' }],
        model: REASONING_MODEL,
      }));

      for (const result of [chat, streamed, split.at(-1)]) {
        expect(result && 'reasoning' in result ? result.reasoning : undefined).toBe(
          kind === 'tool_use' ? 'Look up the address.' : 'Add the numbers.',
        );
        expect(result && 'usage' in result ? result.usage?.reasoningTokens : undefined).toBe(11);
        expect(result && 'reasoningOmitted' in result ? result.reasoningOmitted : undefined).toBeUndefined();
      }
      if (kind === 'tool_use') {
        expect(chat).toMatchObject({ type: 'tool_use', content: 'Checking the thread.' });
        expect(streamed).toMatchObject({ type: 'tool_use', content: 'Checking the thread.' });
      } else {
        expect(chat).toMatchObject({ type: 'text', content: 'The answer is 4.' });
        expect(streamed).toMatchObject({ type: 'message_end', content: 'The answer is 4.' });
      }
    });

    it('falls back to reasoning_details text and summary when message.reasoning is absent', async () => {
      const details = [
        { type: 'reasoning.summary', summary: 'Short version.', id: 'sum-1' },
        { type: 'reasoning.text', text: 'Longer trace.', id: 'txt-1' },
      ];
      const { chat, streamed } = await read(
        [{ reasoning_details: details }, { reasoning_details: [{ type: 'reasoning.text', text: ' continues', id: 'txt-1' }] }],
        6,
      );
      expect(chat).toMatchObject({
        reasoning: 'Short version.\nLonger trace.',
        usage: { reasoningTokens: 6 },
      });
      // Tool-use streams a second delta that continues the same text block.
      // A text response has one delta, so it keeps the two complete entries.
      expect(streamed).toMatchObject({
        reasoning: kind === 'tool_use'
          ? 'Short version.\nLonger trace. continues'
          : 'Short version.\nLonger trace.',
        usage: { reasoningTokens: 6 },
      });
    });

    it('records encrypted-only details without storing the ciphertext', async () => {
      const { chat, streamed } = await read(
        [{
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'CIPHERTEXT-DO-NOT-STORE', id: 'enc-1' }],
        }],
        8,
      );
      for (const result of [chat, streamed]) {
        expect(result).toMatchObject({ reasoningOmitted: 'encrypted', usage: { reasoningTokens: 8 } });
        expect(result && 'reasoning' in result ? result.reasoning : undefined).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('CIPHERTEXT-DO-NOT-STORE');
      }
    });

    it('records nothing when the model returned no reasoning', async () => {
      const { chat, streamed } = await read([{}], 0);
      for (const result of [chat, streamed]) {
        expect(result && 'reasoning' in result ? result.reasoning : undefined).toBeUndefined();
        expect(result && 'reasoningOmitted' in result ? result.reasoningOmitted : undefined).toBeUndefined();
        expect(result && 'usage' in result ? result.usage?.reasoningTokens : undefined).toBe(0);
      }
    });
  });

  it('records an empty omission when reasoning tokens arrive with no text', async () => {
    mockCreate.mockResolvedValue(streamChunks([{ content: 'ok' }], 5, 'stop'));
    const events = await collectStream(provider().stream({
      messages: [{ role: 'user', content: 'Hello' }],
      model: REASONING_MODEL,
    }));
    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'message_end', reasoningOmitted: 'empty', usage: { reasoningTokens: 5 } });
    expect(end && 'reasoning' in end ? end.reasoning : undefined).toBeUndefined();
  });

  it('prefers message.reasoning over reasoning_details', async () => {
    mockCreate.mockResolvedValue(chatCompletion({
      content: '4',
      reasoning: 'from the field',
      reasoning_details: [{ type: 'reasoning.text', text: 'from the details', id: 'txt-1' }],
    }, 3));
    const result = await provider().chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: REASONING_MODEL,
    });
    expect(result).toMatchObject({ reasoning: 'from the field' });
  });

  it('warns once per model when reasoning tokens come back with no readable text', async () => {
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
      child() { return logger; },
    } as unknown as import('../../../../src/logger.js').Logger;
    const omitting = new OpenRouterProvider('test-key', logger, new ModelRegistry(logger));
    const empty = chatCompletion({ content: 'ok' }, 4);
    empty.model = 'deepseek/deepseek-v4-pro-0813';
    mockCreate.mockResolvedValue(empty);
    await omitting.chat({ messages: [{ role: 'user', content: 'Hello' }], model: 'deepseek/deepseek-v4-pro-0813' });
    await omitting.chat({ messages: [{ role: 'user', content: 'Hello' }], model: 'deepseek/deepseek-v4-pro-0813' });
    const encrypted = chatCompletion({
      content: 'ok',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'sealed' }],
    }, 2);
    encrypted.model = 'deepseek/deepseek-v4-pro';
    mockCreate.mockResolvedValue(encrypted);
    await omitting.chat({ messages: [{ role: 'user', content: 'Hello' }], model: 'deepseek/deepseek-v4-pro' });

    const omissionWarns = warn.mock.calls.filter((call) =>
      String(call[1]).includes('no readable reasoning'),
    );
    expect(omissionWarns).toHaveLength(2);
    expect(omissionWarns[0]?.[0]).toMatchObject({ model: 'deepseek/deepseek-v4-pro-0813', reasoningOmitted: 'empty' });
    expect(omissionWarns[1]?.[0]).toMatchObject({ model: 'deepseek/deepseek-v4-pro', reasoningOmitted: 'encrypted' });
  });
});
