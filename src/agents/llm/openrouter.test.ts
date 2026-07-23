// openrouter.test.ts — tests for the OpenRouter LLM provider.
//
// Mocks the openai SDK so tests run without a real API key.
// Follows the same pattern as anthropic.test.ts: vi.hoisted mockCreate,
// vi.mock to stub the SDK, and createSilentLogger for silent logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterProvider } from './openrouter.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';

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

    // Usage — cache tokens always 0 for OpenRouter
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
