import { describe, it, expect } from 'vitest';
import type { LLMProvider, ToolCall, LLMResponse } from '../../../../src/agents/llm/provider.js';

describe('LLMProvider interface', () => {
  it('can be implemented as a mock', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      async chat({ messages }) {
        return {
          type: 'text',
          content: `Echo: ${messages[messages.length - 1]?.content ?? ''}`,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const result = await mockProvider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.content).toBe('Echo: Hello');
    }
  });
});

describe('ToolCall type', () => {
  it('represents an LLM tool call request', () => {
    const call: ToolCall = { id: 'call-1', name: 'web-fetch', input: { url: 'https://example.com' } };
    expect(call.name).toBe('web-fetch');
  });
});

describe('LLMResponse tool_use variant', () => {
  it('carries tool calls with optional text', () => {
    const response: LLMResponse = {
      type: 'tool_use',
      toolCalls: [{ id: 'call-1', name: 'web-fetch', input: { url: 'https://example.com' } }],
      content: 'Let me look that up for you.',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    expect(response.type).toBe('tool_use');
    if (response.type === 'tool_use') {
      expect(response.toolCalls).toHaveLength(1);
    }
  });
});
