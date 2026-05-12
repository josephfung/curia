// anthropic.test.ts — verifies cache_control placement in API calls.
//
// We mock the Anthropic SDK client so tests run without a real API key.
// The mock captures every call to client.messages.create() and lets us
// assert exactly what parameters were sent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import { createSilentLogger } from '../../logger.js';

// vi.mock is hoisted above variable declarations, so mockCreate must be
// declared with vi.hoisted() to be available inside the mock factory.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  // Arrow functions are not constructable, so we use a class here.
  // AnthropicProvider calls `new Anthropic({ apiKey })` in its constructor.
  default: class {
    messages = { create: mockCreate };
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

describe('AnthropicProvider — provenance and cache tokens', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('returns provenance with requestedModel, actualModel, and providerRequestId on text response', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
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

    const provider = new AnthropicProvider('test-key', createSilentLogger());
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Search something' }],
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' as const, properties: {} } }],
    });

    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;
    expect(result.provenance.requestedModel).toBe('claude-sonnet-4-6'); // default model
    expect(result.provenance.actualModel).toBe('claude-sonnet-4-6');
    expect(result.provenance.providerRequestId).toBe('msg_tool_456');
  });

  it('defaults cache token fields to 0 when API returns null', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });

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

    const provider = new AnthropicProvider('test-key', createSilentLogger());
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.usage.cacheCreationInputTokens).toBe(1500);
    expect(result.usage.cacheReadInputTokens).toBe(300);
  });
});

describe('AnthropicProvider — prompt caching', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('passes system content as TextBlockParam[] with cache_control', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
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
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.system).toBeUndefined();
  });

  it('concatenates multiple system messages into one block with cache_control', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
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

  it('adds cache_control only to the last tool when multiple tools provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
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
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'only-tool', description: 'The one', input_schema: { type: 'object' as const, properties: {} } },
      ],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits tools key entirely when no tools provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.tools).toBeUndefined();
  });
});
