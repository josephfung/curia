// openrouter.test.ts — tests for the OpenRouter LLM provider.
//
// Mocks the openai SDK so tests run without a real API key.
// Follows the same pattern as anthropic.test.ts: vi.hoisted mockCreate,
// vi.mock to stub the SDK, and createSilentLogger for silent logging.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import {
  isRetryableOpenRouterError,
  mergeReasoningDetailDeltas,
  OPENROUTER_MAX_ATTEMPTS,
  OpenRouterProvider,
  openRouterRetryDelayMs,
  upstreamProviderFrom,
  usageFromOpenRouter,
} from '../../../../src/agents/llm/openrouter.js';
import { buildAssistantToolUseMessage, buildUserToolResultMessage } from '../../../../src/agents/llm/tool-loop-messages.js';
import { buildLlmArchiveResponse } from '../../../../src/audit/llm-archive-response.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { LLMResponse, LLMStreamEvent, Message } from '../../../../src/agents/llm/provider.js';

// vi.mock is hoisted above variable declarations, so mockCreate must be
// declared with vi.hoisted() to be available inside the mock factory.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', async (importOriginal) => ({
  // Keep the real error classes: chat() decides what to retry with instanceof.
  ...(await importOriginal<typeof import('openai')>()),
  // The OpenRouterProvider calls `new OpenAI({ apiKey, baseURL })` in its
  // constructor. Arrow functions are not constructable, so we use a class.
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

/** An SDK APIError for an HTTP status, with optional response headers. */
function apiError(status: number, headers: Record<string, string> = {}): APIError {
  return APIError.generate(status, { error: { message: `status ${status}` } }, undefined, new Headers(headers));
}

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

  it('leaves reasoningTokens unset when the response reports no count, and keeps a reported zero', () => {
    expect(usageFromOpenRouter({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })).not.toHaveProperty('reasoningTokens');
    expect(usageFromOpenRouter({
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
      completion_tokens_details: { reasoning_tokens: 0 },
    }).reasoningTokens).toBe(0);
  });

  it('returns zeros for missing usage', () => {
    expect(usageFromOpenRouter(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
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
      { type: 'request_started', maxTokens: expect.any(Number) },
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'message_end',
        content: 'hello',
        usage: { inputTokens: 12, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: { requestedModel: 'openai/gpt-4o', actualModel: 'openai/gpt-4o', providerRequestId: 'chatcmpl-stream-123', attempts: 1, failedAttemptsMs: 0 },
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

    expect(events[0]).toEqual({ type: 'request_started', maxTokens: expect.any(Number) });
    expect(events[1]).toEqual({ type: 'text_delta', text: 'Checking. ' });
    expect(events[2]).toEqual({ type: 'output_started' });
    expect(events.filter((e) => e.type === 'output_started')).toHaveLength(1);
    expect(events[3]).toEqual({
      type: 'tool_use',
      toolCalls: [{ id: 'call_1', name: 'search', input: { query: 'curia' } }],
      content: 'Checking. ',
      usage: { inputTokens: 22, outputTokens: 8, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: { requestedModel: 'openai/gpt-4o', actualModel: 'openai/gpt-4o', providerRequestId: 'chatcmpl-stream-tool', attempts: 1, failedAttemptsMs: 0 },
    });
  });

  it('stream emits request_started with the sent max_tokens, then one reasoning_delta per delta.reasoning or reasoning_details text', async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id: 'chatcmpl-stream-reason',
      model: 'deepseek/deepseek-v4-pro',
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      usage: null,
      object: 'chat.completion.chunk',
      created: 1700000000,
    });
    mockCreate.mockResolvedValue(makeStream([
      chunk({ reasoning: 'first ' }),
      // Carries both: delta.reasoning wins, so this emits once.
      chunk({ reasoning: 'second ', reasoning_details: [{ type: 'reasoning.text', text: 'second ' }] }),
      // Details only.
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'third' }, { type: 'reasoning.encrypted', data: 'xx' }] }),
      // An empty delta.reasoning does not hide the details text.
      chunk({ reasoning: '', reasoning_details: [{ type: 'reasoning.text', text: 'fourth' }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] }, 'tool_calls'),
    ]));

    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Search' }],
      model: 'deepseek/deepseek-v4-pro',
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' as const, properties: {} } }],
    }));

    expect(events[0]).toEqual({ type: 'request_started', maxTokens: 32_768 });
    expect(events.filter((e) => e.type === 'request_started')).toHaveLength(1);
    expect(events.slice(1, 5)).toEqual([
      { type: 'reasoning_delta', text: 'first ' },
      { type: 'reasoning_delta', text: 'second ' },
      { type: 'reasoning_delta', text: 'third' },
      { type: 'reasoning_delta', text: 'fourth' },
    ]);
    // output_started once, on the first tool-call chunk, before the final tool_use.
    expect(events[5]).toEqual({ type: 'output_started' });
    expect(events.filter((e) => e.type === 'output_started')).toHaveLength(1);
    expect(events[6]!.type).toBe('tool_use');
    expect(events).toHaveLength(7);
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(32_768);
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

    expect(mockCreate.mock.calls[0]![1]).toEqual({ signal: controller.signal, maxRetries: 0 });
  });

  it('turns off SDK retries on the stream request, so retries are counted where they happen (#1915)', async () => {
    mockCreate.mockResolvedValue(makeStream([
      {
        id: 'chatcmpl-noretry',
        model: 'openai/gpt-4o',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
    ]));
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'openai/gpt-4o' }));

    expect(mockCreate.mock.calls[0]![1]).toEqual({ maxRetries: 0 });
    const end = events.at(-1);
    if (end?.type !== 'message_end') throw new Error(`expected message_end, got ${end?.type}`);
    expect(end.provenance).toMatchObject({ attempts: 1, failedAttemptsMs: 0 });
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
    // Break after the first text delta (request_started precedes it): the async generator's
    // finally must still run and abort the SDK stream, otherwise its Response buffer leaks.
    const seen: LLMStreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'Hello' }], model: 'openai/gpt-4o' })) {
      seen.push(event);
      if (event.type === 'text_delta') break;
    }

    expect(seen).toHaveLength(2);
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
        // The ciphertext rides on reasoningBlocks for pass-back to the same
        // model (ADR-048 §1); what the archive stores never contains it.
        if (result?.type === 'tool_use') {
          expect(JSON.stringify(result.reasoningBlocks)).toContain('CIPHERTEXT-DO-NOT-STORE');
        } else {
          expect(JSON.stringify(result)).not.toContain('CIPHERTEXT-DO-NOT-STORE');
        }
        if (result && result.type !== 'error' && result.type !== 'text_delta' && result.type !== 'request_started' && result.type !== 'reasoning_delta' && result.type !== 'output_started') {
          expect(JSON.stringify(buildLlmArchiveResponse(result))).not.toContain('CIPHERTEXT-DO-NOT-STORE');
        }
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

describe('OpenRouterProvider — upstream endpoint (ADR-048 §5)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('reads the provider field defensively', () => {
    expect(upstreamProviderFrom({ provider: 'CoreWeave' })).toBe('CoreWeave');
    expect(upstreamProviderFrom({ provider: '' })).toBeUndefined();
    expect(upstreamProviderFrom({ provider: 7 })).toBeUndefined();
    expect(upstreamProviderFrom({})).toBeUndefined();
  });

  it('carries the response provider on chat() provenance', async () => {
    mockCreate.mockResolvedValue({ ...makeTextResponse(), provider: 'DeepSeek' });
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'google/gemini-2.0-flash-001' });
    expect(result.type === 'text' && result.provenance.upstreamProvider).toBe('DeepSeek');
  });

  it('omits upstreamProvider when the response has none', async () => {
    mockCreate.mockResolvedValue(makeTextResponse());
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'google/gemini-2.0-flash-001' });
    expect(result.type === 'text' && 'upstreamProvider' in result.provenance).toBe(false);
  });

  it('carries the provider from stream chunks', async () => {
    mockCreate.mockResolvedValue(makeStream([
      {
        id: 'gen-1',
        model: 'deepseek/deepseek-v4.1-flash',
        provider: 'CoreWeave',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }],
        usage: null,
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
      {
        id: 'gen-1',
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        object: 'chat.completion.chunk',
        created: 1700000000,
      },
    ]));
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'deepseek/deepseek-v4.1-flash',
    }));
    const end = events.at(-1);
    expect(end?.type === 'message_end' && end.provenance.upstreamProvider).toBe('CoreWeave');
  });
});

describe('OpenRouterProvider — reasoning pass-back (ADR-048 §1)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  const MODEL = 'deepseek/deepseek-v4.1-flash';
  const tools = [{ name: 'lookup', description: 'Look up', input_schema: { type: 'object' as const, properties: {} } }];
  // What a non-streamed response carries: one text entry with a signature, one encrypted entry.
  const details = [
    { type: 'reasoning.text', text: 'Check the calendar first.', signature: 'sig-1', id: 'r1', format: 'unknown', index: 0 },
    { type: 'reasoning.encrypted', data: 'ENCRYPTED', id: 'r2', format: 'unknown', index: 1 },
  ];

  function toolCallResponse(extra: Record<string, unknown>) {
    return {
      id: 'gen-1',
      model: MODEL,
      choices: [{
        index: 0,
        finish_reason: 'tool_calls' as const,
        message: {
          role: 'assistant' as const,
          content: null,
          refusal: null,
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } }],
          ...extra,
        },
        logprobs: null,
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      object: 'chat.completion' as const,
      created: 1700000000,
    };
  }

  function nextMessages(result: LLMResponse): Message[] {
    if (result.type !== 'tool_use') throw new Error(`expected tool_use, got ${result.type}`);
    return [
      { role: 'user', content: 'Plan my day' },
      buildAssistantToolUseMessage(result.toolCalls, result.content, result.reasoningBlocks),
      buildUserToolResultMessage([{ id: 'call_1', content: 'result' }]),
    ];
  }

  function sentAssistant(callIndex: number): Record<string, unknown> {
    const params = mockCreate.mock.calls[callIndex]![0] as { messages: Array<Record<string, unknown>> };
    return params.messages.find((m) => m.role === 'assistant')!;
  }

  it('sends reasoning_details back unmodified on the next request', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolCallResponse({ reasoning: 'Check the calendar first.', reasoning_details: details }));
    const first = await provider.chat({ messages: [{ role: 'user', content: 'Plan my day' }], tools, model: MODEL });

    mockCreate.mockResolvedValueOnce(makeTextResponse());
    await provider.chat({ messages: nextMessages(first), tools, model: MODEL });
    const assistant = sentAssistant(1);
    expect(assistant.reasoning_details).toEqual(details);
    expect(assistant).not.toHaveProperty('reasoning');
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it('falls back to the bare reasoning string when no details came', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolCallResponse({ reasoning: 'Only a string.' }));
    const first = await provider.chat({ messages: [{ role: 'user', content: 'Plan my day' }], tools, model: MODEL });

    mockCreate.mockResolvedValueOnce(makeTextResponse());
    await provider.chat({ messages: nextMessages(first), tools, model: MODEL });
    expect(sentAssistant(1).reasoning).toBe('Only a string.');
    expect(sentAssistant(1)).not.toHaveProperty('reasoning_details');
  });

  it('sends nothing extra when the turn carried no reasoning', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolCallResponse({}));
    const first = await provider.chat({ messages: [{ role: 'user', content: 'Plan my day' }], tools, model: MODEL });
    expect(first.type === 'tool_use' && first.reasoningBlocks).toBeUndefined();

    mockCreate.mockResolvedValueOnce(makeTextResponse());
    await provider.chat({ messages: nextMessages(first), tools, model: MODEL });
    expect(sentAssistant(1)).not.toHaveProperty('reasoning_details');
    expect(sentAssistant(1)).not.toHaveProperty('reasoning');
  });

  it('drops reasoning written by another model', async () => {
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    mockCreate.mockResolvedValueOnce(toolCallResponse({ reasoning_details: details }));
    const first = await provider.chat({ messages: [{ role: 'user', content: 'Plan my day' }], tools, model: MODEL });

    mockCreate.mockResolvedValueOnce(makeTextResponse());
    await provider.chat({ messages: nextMessages(first), tools, model: 'openai/gpt-4o' });
    expect(sentAssistant(1)).not.toHaveProperty('reasoning_details');
  });

  it('rebuilds streamed reasoning_details into the non-streamed shape', async () => {
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      id: 'gen-2',
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
      usage: null,
      object: 'chat.completion.chunk',
      created: 1700000000,
      ...extra,
    });
    mockCreate.mockResolvedValueOnce(makeStream([
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'Check the ', id: 'r1', format: 'unknown', index: 0, signature: null }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'calendar first.', index: 0, format: 'unknown', signature: null }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: '', index: 0, signature: 'sig-1' }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENCRY', id: 'r2', format: 'unknown', index: 1 }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'PTED', index: 1 }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }),
      { id: 'gen-2', model: MODEL, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, object: 'chat.completion.chunk', created: 1700000000 },
    ]));
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    const events = await collectStream(provider.stream({ messages: [{ role: 'user', content: 'Plan my day' }], tools, model: MODEL }));
    const toolUse = events.at(-1);
    expect(toolUse?.type).toBe('tool_use');
    if (toolUse?.type !== 'tool_use') return;
    expect(toolUse.reasoningBlocks).toEqual([{ type: 'reasoning', provider: 'openrouter', model: MODEL, data: { reasoning_details: details } }]);
  });

  it('merges fragments by id when there is no index, and by type otherwise', () => {
    const merged: Array<Record<string, unknown>> = [];
    mergeReasoningDetailDeltas(merged, [{ type: 'reasoning.summary', summary: 'A', id: 's1' }]);
    mergeReasoningDetailDeltas(merged, [{ type: 'reasoning.summary', summary: 'B', id: 's1' }]);
    mergeReasoningDetailDeltas(merged, [{ type: 'reasoning.text', text: 'x' }]);
    mergeReasoningDetailDeltas(merged, [{ type: 'reasoning.text', text: 'y' }]);
    mergeReasoningDetailDeltas(merged, 'not an array');
    expect(merged).toEqual([
      { type: 'reasoning.summary', summary: 'AB', id: 's1' },
      { type: 'reasoning.text', text: 'xy' },
    ]);
  });
});

describe('OpenRouterProvider — reasoning effort (ADR-048 §2)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  const provider = (registry = new ModelRegistry(createSilentLogger())) => new OpenRouterProvider('test-key', createSilentLogger(), registry);
  const sent = () => mockCreate.mock.calls[0]![0] as Record<string, unknown>;

  it('sends no reasoning key when unset', async () => {
    const result = await provider().chat({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }] });
    expect(sent()).not.toHaveProperty('reasoning');
    expect(result.type === 'text' && 'reasoningEffort' in result.provenance).toBe(false);
  });

  it('sends reasoning.effort for an effort the model lists, and records it', async () => {
    const result = await provider().chat({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }], options: { reasoning: { effort: 'low' } } });
    expect(sent().reasoning).toEqual({ effort: 'low' });
    expect(result.type === 'text' && result.provenance.reasoningEffort).toBe('low');
  });

  it('leaves out an effort the model does not list, so the judges on Gemini are unchanged', async () => {
    const result = await provider().chat({ model: 'google/gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'Hi' }], options: { reasoning: { effort: 'none' } } });
    expect(sent()).not.toHaveProperty('reasoning');
    expect(result.type === 'text' && 'reasoningEffort' in result.provenance).toBe(false);
  });

  it('sends nothing to a model with no reasoning entry', async () => {
    await provider().chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }], options: { reasoning: { effort: 'low' } } });
    expect(sent()).not.toHaveProperty('reasoning');
  });

  it('maps none to enabled: false where a model lists it', async () => {
    const registry = new ModelRegistry(createSilentLogger());
    vi.spyOn(registry, 'honorsReasoningEffort').mockReturnValue(true);
    await provider(registry).chat({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }], options: { reasoning: { effort: 'none' } } });
    expect(sent().reasoning).toEqual({ enabled: false });
  });

  it('sends the effort on streamed requests and records it', async () => {
    mockCreate.mockResolvedValueOnce(makeStream([
      { id: 'gen-3', model: 'deepseek/deepseek-v4.1-flash', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }], usage: null, object: 'chat.completion.chunk', created: 1700000000 },
      { id: 'gen-3', model: 'deepseek/deepseek-v4.1-flash', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, object: 'chat.completion.chunk', created: 1700000000 },
    ]));
    const events = await collectStream(provider().stream({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }], options: { reasoning: { effort: 'max' } } }));
    expect(sent().reasoning).toEqual({ effort: 'max' });
    const end = events.at(-1);
    expect(end?.type === 'message_end' && end.provenance.reasoningEffort).toBe('max');
  });
});

// chat() owns retries instead of the openai SDK, so each one is logged and
// counted on llm.call rather than hidden inside one call's latency (#1915).
describe('OpenRouter retry rule', () => {
  it('retries connection errors, timeouts, 408, 409, 429 and 5xx', () => {
    expect(isRetryableOpenRouterError(new APIConnectionError({ message: 'socket hang up' }))).toBe(true);
    expect(isRetryableOpenRouterError(new APIConnectionTimeoutError())).toBe(true);
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(isRetryableOpenRouterError(apiError(status)), String(status)).toBe(true);
    }
  });

  it('does not retry client errors, caller aborts or non-SDK errors', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableOpenRouterError(apiError(status)), String(status)).toBe(false);
    }
    expect(isRetryableOpenRouterError(new APIUserAbortError())).toBe(false);
    expect(isRetryableOpenRouterError(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
  });

  it('obeys an explicit x-should-retry header either way', () => {
    expect(isRetryableOpenRouterError(apiError(400, { 'x-should-retry': 'true' }))).toBe(true);
    expect(isRetryableOpenRouterError(apiError(503, { 'x-should-retry': 'false' }))).toBe(false);
  });

  it('backs off from 0.5s, doubling to an 8s cap, with up to 25% jitter off', () => {
    const noJitter = () => 0;
    expect(openRouterRetryDelayMs(apiError(503), 1, noJitter)).toBe(500);
    expect(openRouterRetryDelayMs(apiError(503), 2, noJitter)).toBe(1000);
    expect(openRouterRetryDelayMs(apiError(503), 6, noJitter)).toBe(8000);
    expect(openRouterRetryDelayMs(apiError(503), 1, () => 1)).toBe(375);
  });

  it('waits what retry-after-ms or retry-after asks for, up to 60s', () => {
    expect(openRouterRetryDelayMs(apiError(429, { 'retry-after-ms': '1200' }), 1)).toBe(1200);
    expect(openRouterRetryDelayMs(apiError(429, { 'retry-after': '3' }), 1)).toBe(3000);
    expect(openRouterRetryDelayMs(apiError(429, { 'retry-after': '120' }), 1, () => 0)).toBe(500);
  });
});

describe('OpenRouterProvider chat() retries', () => {
  const provider = () => new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
  const chat = (p = provider()) => p.chat({ messages: [{ role: 'user', content: 'Hello' }], model: 'google/gemini-2.0-flash-001' });

  beforeEach(() => {
    mockCreate.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns off the SDK retries on its own requests', async () => {
    mockCreate.mockResolvedValue(makeTextResponse());
    await chat();
    expect(mockCreate.mock.calls[0]![1]).toMatchObject({ maxRetries: 0 });
  });

  it('records one attempt and no failed time on a first-try success', async () => {
    mockCreate.mockResolvedValue(makeTextResponse());
    const result = await chat();
    expect(result.type === 'text' && result.provenance).toMatchObject({ attempts: 1, failedAttemptsMs: 0 });
  });

  it('retries a timeout, then records both attempts and the time the first one cost', async () => {
    mockCreate.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(600_000);
      throw new APIConnectionTimeoutError();
    });
    mockCreate.mockResolvedValueOnce(makeTextResponse());

    const pending = chat();
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.provenance.attempts).toBe(2);
    // The 600s attempt plus a backoff of 375–500ms.
    expect(result.provenance.failedAttemptsMs).toBeGreaterThanOrEqual(600_375);
    expect(result.provenance.failedAttemptsMs).toBeLessThanOrEqual(600_500);
  });

  it(`gives up after ${OPENROUTER_MAX_ATTEMPTS} attempts and reports how many it made`, async () => {
    mockCreate.mockRejectedValue(apiError(503));

    const pending = chat();
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(mockCreate).toHaveBeenCalledTimes(OPENROUTER_MAX_ATTEMPTS);
    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    expect(result.error.type).toBe('PROVIDER_ERROR');
    expect(result.error.context.attempts).toBe(OPENROUTER_MAX_ATTEMPTS);
  });

  it('does not retry a client error', async () => {
    mockCreate.mockRejectedValue(apiError(400));
    const result = await chat();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.type === 'error' && result.error.context.attempts).toBe(1);
  });

  // The coordinator on 2026-10-22 reasoned through all 32,768 output tokens and
  // returned nothing; the principal got "I wasn't able to formulate a response".
  const emptyAtCap = (outputTokens: number) => ({
    ...makeTextResponse(),
    choices: [{
      index: 0,
      finish_reason: 'length' as const,
      message: { role: 'assistant' as const, content: '', tool_calls: undefined, refusal: null },
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: outputTokens,
      total_tokens: 100 + outputTokens,
      completion_tokens_details: { reasoning_tokens: outputTokens },
    },
  });

  it('retries a response that hit max_tokens with no answer, counting its tokens', async () => {
    mockCreate.mockResolvedValueOnce(emptyAtCap(32_768));
    mockCreate.mockResolvedValueOnce(makeTextResponse());

    const result = await chat();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.content).toBe('hello from openrouter');
    expect(result.provenance.attempts).toBe(2);
    // The empty attempt was billed, so llm.call's tokens and cost include it.
    expect(result.usage).toMatchObject({ inputTokens: 110, outputTokens: 32_773, reasoningTokens: 32_768 });
  });

  it('returns the last empty response when every attempt hits the cap', async () => {
    mockCreate.mockResolvedValue(emptyAtCap(1_000));

    const result = await chat();

    expect(mockCreate).toHaveBeenCalledTimes(OPENROUTER_MAX_ATTEMPTS);
    expect(result.type === 'text' && result.content).toBe('');
    expect(result.type === 'text' && result.provenance.attempts).toBe(OPENROUTER_MAX_ATTEMPTS);
    expect(result.type === 'text' && result.usage.outputTokens).toBe(3_000);
  });

  it('falls back to the billed empty response when the retry after it errors', async () => {
    mockCreate.mockResolvedValueOnce(emptyAtCap(32_768));
    mockCreate.mockResolvedValueOnce(emptyAtCap(1_000));
    mockCreate.mockRejectedValueOnce(apiError(400));

    const result = await chat();

    expect(mockCreate).toHaveBeenCalledTimes(3);
    // The pre-retry outcome, so llm.call still records every billed token.
    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.content).toBe('');
    expect(result.provenance.attempts).toBe(3);
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 33_768, reasoningTokens: 33_768 });
  });

  it('does not retry a truncated response that still has an answer', async () => {
    mockCreate.mockResolvedValue({
      ...emptyAtCap(1_000),
      choices: [{
        index: 0,
        finish_reason: 'length' as const,
        message: { role: 'assistant' as const, content: 'partial but usable', tool_calls: undefined, refusal: null },
        logprobs: null,
      }],
    });

    const result = await chat();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.type === 'text' && result.content).toBe('partial but usable');
  });

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController();
    mockCreate.mockImplementation(async () => {
      controller.abort();
      throw apiError(503);
    });

    const pending = provider().chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'google/gemini-2.0-flash-001',
      options: { signal: controller.signal },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.type).toBe('error');
  });

  it('sends a tool result, then a later user text, as tool then user', async () => {
    mockCreate.mockResolvedValue(makeTextResponse());
    const model = 'google/gemini-2.0-flash-001';
    const provider = new OpenRouterProvider('test-key', createSilentLogger(), new ModelRegistry(createSilentLogger()));
    await provider.chat({
      model,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              provider: 'openrouter',
              model,
              data: { reasoning: 'check the thread' },
            },
            { type: 'tool_use', id: 'call-1', name: 'browser-navigate', input: { url: 'https://example.com' } },
          ],
        },
        buildUserToolResultMessage([{ id: 'call-1', content: 'page' }]),
        { role: 'user', content: [{ type: 'text', text: 'use email' }] },
      ],
    });
    const sent = mockCreate.mock.calls[0]![0] as {
      messages: Array<{ role: string; content?: unknown; reasoning?: string; tool_call_id?: string }>;
    };
    expect(sent.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(sent.messages[0]!.reasoning).toBe('check the thread');
    expect(sent.messages[1]!.tool_call_id).toBe('call-1');
    expect(JSON.stringify(sent.messages[2]!.content)).toContain('use email');
    expect(sent.messages[2]!.role).toBe('user');
  });
});
