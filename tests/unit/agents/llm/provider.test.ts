import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../../../src/agents/llm/provider.js';

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
