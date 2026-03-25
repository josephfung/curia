// anthropic.ts — Anthropic Claude implementation of LLMProvider.
//
// Key design decisions:
//   1. System messages are extracted and passed as the top-level `system`
//      parameter, which is what the Anthropic API requires. If we left them
//      in the messages array the API would return a validation error.
//   2. Errors are caught here and returned as LLMResponse { type: 'error' }
//      so callers never have to wrap chat() in try/catch.
//   3. Model is configurable via options.model so a single provider instance
//      can be used with different Claude versions without re-instantiation.

import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResponse, Message } from './provider.js';
import type { Logger } from '../../logger.js';

export class AnthropicProvider implements LLMProvider {
  id = 'anthropic';
  private client: Anthropic;
  private logger: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.client = new Anthropic({ apiKey });
    this.logger = logger;
  }

  async chat({
    messages,
    options,
  }: {
    messages: Message[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    // Anthropic requires the system prompt as a separate top-level parameter,
    // not as an element in the messages array. We extract it here so agent
    // code can use a uniform Message[] convention without knowing this detail.
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Default to the latest Claude Sonnet; callers can override via options.model.
    // Using a default here ensures we never accidentally call without a model.
    const model = (options?.model as string) ?? 'claude-sonnet-4-20250514';

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 4096,
        system: systemMessage?.content,
        messages: conversationMessages,
      });

      // response.content is an array of content blocks (text, tool_use, etc.).
      // We extract the first text block; if the model returns only tool_use
      // blocks (e.g., in a tool-calling flow), content will be an empty string.
      // Future work: extend LLMResponse to carry tool_use blocks natively.
      const textContent = response.content.find((c) => c.type === 'text');

      this.logger.debug(
        {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        'Anthropic API call completed',
      );

      return {
        type: 'text',
        content: textContent?.text ?? '',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Anthropic error';
      this.logger.error({ err, model }, 'Anthropic API call failed');
      // Return error as a value so callers don't need try/catch.
      return { type: 'error', error: message };
    }
  }
}
