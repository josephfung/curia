// anthropic.ts — Anthropic Claude implementation of LLMProvider.
//
// Key design decisions:
//   1. System messages are extracted and passed as the top-level `system`
//      parameter, which is what the Anthropic API requires. If we left them
//      in the messages array the API would return a validation error.
//      The runtime injects multiple role:'system' entries (main prompt,
//      sender context, bullpen context) — we concatenate all of them here
//      rather than silently dropping everything after the first one.
//   2. Errors are caught here and returned as LLMResponse { type: 'error' }
//      so callers never have to wrap chat() in try/catch.
//   3. Model is configurable via options.model so a single provider instance
//      can be used with different Claude versions without re-instantiation.

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolUseBlock, TextBlock, TextBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { LLMProvider, LLMResponse, LLMUsage, Message, ToolCall, ToolDefinition, ToolResult } from './provider.js';
import type { Logger } from '../../logger.js';
import { classifyError } from '../../errors/classify.js';

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
    tools,
    toolResults,
    options,
  }: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    // Anthropic requires the system prompt as a separate top-level parameter,
    // not as an element in the messages array. We extract it here so agent
    // code can use a uniform Message[] convention without knowing this detail.
    //
    // The runtime injects multiple role:'system' entries into the messages array
    // (main system prompt, sender context block, bullpen context block). We
    // concatenate them all here so none are silently dropped.
    const systemContent = messages
      .filter((m) => m.role === 'system')
      .map((m) => {
        if (typeof m.content !== 'string') {
          // System messages must be plain strings. ContentBlock[] in a system role
          // is not supported by the Anthropic API. Log at error so this is
          // discoverable if a future caller passes structured content here.
          this.logger.error(
            { contentType: typeof m.content },
            'System message has non-string content — skipping; caller must pass plain strings for system role',
          );
          return '';
        }
        return m.content;
      })
      .filter(Boolean)
      .join('\n\n');

    // Build the Anthropic message array from our provider-neutral Message type.
    // Messages with string content are simple text; messages with ContentBlock[]
    // carry tool_use or tool_result blocks for multi-turn tool-use conversations.
    const conversationMessages: MessageParam[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role as 'user' | 'assistant', content: m.content };
        }
        // ContentBlock[] — map our provider-neutral blocks to Anthropic SDK shapes
        return {
          role: m.role as 'user' | 'assistant',
          content: m.content.map(block => {
            if (block.type === 'tool_use') {
              return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
            }
            if (block.type === 'tool_result') {
              return { type: 'tool_result' as const, tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error };
            }
            // TextContent
            return { type: 'text' as const, text: block.text };
          }),
        } as MessageParam;
      });

    // Legacy toolResults parameter — append as a user turn if provided.
    // Prefer building tool_result blocks directly in the messages array instead.
    if (toolResults && toolResults.length > 0) {
      const toolResultBlocks: ToolResultBlockParam[] = toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.id,
        content: tr.content,
        is_error: tr.is_error,
      }));
      conversationMessages.push({ role: 'user', content: toolResultBlocks });
    }

    // Default to the latest Claude Sonnet; callers can override via options.model.
    // Using a default here ensures we never accidentally call without a model.
    const model = (options?.model as string) ?? 'claude-sonnet-4-6';

    try {
      const createParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 4096,
        // Wrap the concatenated system string in a TextBlockParam array with a
        // cache_control breakpoint. This tells Anthropic to cache everything up
        // to this block, saving ~5K tokens of system prompt cost on repeat calls.
        // Omit the key entirely when there is no system content (same as before).
        system: systemContent
          ? [{ type: 'text' as const, text: systemContent, cache_control: { type: 'ephemeral' as const } } satisfies TextBlockParam]
          : undefined,
        messages: conversationMessages,
      };

      // Only attach the tools array when tools are provided — the API rejects
      // an empty tools array, so we omit the key entirely when there are none.
      if (tools && tools.length > 0) {
        // Type explicitly as Tool[] so that spreading cache_control onto the last
        // element is accepted by TypeScript — the inferred type from .map() is
        // narrower and doesn't include the optional cache_control field.
        const mappedTools: Anthropic.Messages.Tool[] = tools.map(t => ({
          name: t.name,
          description: t.description,
          // Cast required because ToolDefinition.input_schema is a narrower shape
          // than the SDK's polymorphic Tool['input_schema'] union type.
          input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
        }));
        // Mark the last tool with a cache_control breakpoint so the entire tool
        // list is captured in a single cache slot. The coordinator's tool list is
        // stable (48 pinned skills), so this achieves near-100% hit rate within
        // the 5-minute TTL and saves ~10K tokens per call.
        // Mutate in place rather than spread-reassign — the spread pattern widens
        // the inferred type and makes required fields optional, breaking assignability.
        mappedTools[mappedTools.length - 1]!.cache_control = { type: 'ephemeral' as const };
        createParams.tools = mappedTools;
      }

      const response = await this.client.messages.create(createParams);

      this.logger.debug(
        {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          stopReason: response.stop_reason,
        },
        'Anthropic API call completed',
      );

      const usage: LLMUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };

      // Use type guard functions for narrowing — avoids casting and is safer
      // than checking c.type === 'tool_use' without narrowing to ToolUseBlock.
      const toolUseBlocks = response.content.filter(
        (c): c is ToolUseBlock => c.type === 'tool_use',
      );
      if (toolUseBlocks.length > 0) {
        const toolCalls: ToolCall[] = toolUseBlocks.map((block) => ({
          id: block.id,
          name: block.name,
          // block.input is typed as unknown by the SDK; we assert the shape
          // we expect since all well-formed tool inputs are plain objects.
          input: block.input as Record<string, unknown>,
        }));

        // The model may emit a text preamble alongside tool calls (e.g.
        // "Let me look that up…"). Preserve it so callers can surface it.
        const textBlock = response.content.find(
          (c): c is TextBlock => c.type === 'text',
        );

        return {
          type: 'tool_use',
          toolCalls,
          content: textBlock?.text,
          usage,
        };
      }

      // response.content is an array of content blocks (text, tool_use, etc.).
      // We extract the first text block; if the model returns only tool_use
      // blocks, content will be an empty string.
      const textContent = response.content.find(
        (c): c is TextBlock => c.type === 'text',
      );
      const content = textContent?.text ?? '';
      if (!content) {
        // Log at error level — an empty text response means the user will receive a blank reply.
        // The runtime catches this and returns a fallback message, but this event indicates
        // the model ended its turn (stop_reason) without producing any user-facing text.
        this.logger.error({ model, stopReason: response.stop_reason }, 'LLM returned empty text response');
      }
      return {
        type: 'text',
        content,
        usage,
      };
    } catch (err) {
      this.logger.error({ err, model }, 'Anthropic API call failed');
      // Classify the error into a structured AgentError so the runtime
      // can make informed retry and budget decisions.
      return { type: 'error', error: classifyError(err, 'anthropic') };
    }
  }
}
