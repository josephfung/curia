// openrouter.ts — OpenRouter implementation of LLMProvider.
//
// Uses the openai SDK pointed at OpenRouter's OpenAI-compatible API.
//
// Key design decisions:
//   1. System messages are extracted and concatenated into a single system
//      role message at the start of the conversation, matching the OpenAI
//      chat format. Multiple system messages are joined with double newlines.
//   2. Curia's ContentBlock types are mapped to OpenAI SDK shapes (text,
//      image_url, tool messages). Images use data URIs for base64 sources.
//   3. Cache tokens are always 0 — OpenRouter doesn't support Anthropic-style
//      prompt caching.
//   4. Errors are caught and returned as LLMResponse { type: 'error' } so
//      callers never need try/catch around chat().
//   5. No streaming — all calls use the non-streaming create endpoint.

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion } from 'openai/resources/chat/completions/completions.js';
import type { LLMProvider, LLMResponse, LLMUsage, LLMCallProvenance, Message, ContentBlock, ToolCall, ToolDefinition, ToolResult } from './provider.js';
import type { Logger } from '../../logger.js';
import { classifyError } from '../../errors/classify.js';
import type { ModelRegistry } from './model-registry.js';

export class OpenRouterProvider implements LLMProvider {
  id = 'openrouter';
  private client: OpenAI;
  private logger: Logger;
  private readonly modelRegistry: ModelRegistry;

  constructor(apiKey: string, logger: Logger, modelRegistry: ModelRegistry) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    this.logger = logger;
    this.modelRegistry = modelRegistry;
  }

  async chat({
    messages,
    tools,
    toolResults,
    model: modelOverride,
    options,
  }: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    // Extract and concatenate all system messages into a single system role
    // entry. The OpenAI API accepts system messages inline (unlike Anthropic),
    // but we still merge them for consistency — the runtime injects multiple
    // role:'system' entries (main prompt, sender context, bullpen context).
    const systemContent = messages
      .filter((m) => m.role === 'system')
      .map((m) => {
        if (typeof m.content !== 'string') {
          // System messages must be plain strings. Log at error level so this
          // is discoverable if a future caller passes structured content.
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

    // Build the OpenAI message array from our provider-neutral Message type.
    const conversationMessages: ChatCompletionMessageParam[] = [];

    // Add the merged system message as a single entry at the start.
    if (systemContent) {
      conversationMessages.push({ role: 'system', content: systemContent });
    }

    // Map non-system messages to OpenAI SDK shapes.
    for (const m of messages) {
      if (m.role === 'system') continue;

      if (typeof m.content === 'string') {
        conversationMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        });
        continue;
      }

      // ContentBlock[] — map our provider-neutral blocks to OpenAI SDK shapes.
      // Tool-result blocks become separate tool-role messages (OpenAI format).
      // Tool-use blocks in assistant messages need to become tool_calls.
      if (m.role === 'assistant') {
        // Assistant messages may contain tool_use and text blocks.
        const toolUseBlocks = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
        const textBlocks = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
        const textContent = textBlocks.map(b => b.text).join('') || null;

        if (toolUseBlocks.length > 0) {
          conversationMessages.push({
            role: 'assistant',
            content: textContent,
            tool_calls: toolUseBlocks.map(b => ({
              id: b.id,
              type: 'function' as const,
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            })),
          });
        } else {
          conversationMessages.push({
            role: 'assistant',
            content: textContent ?? '',
          });
        }
        continue;
      }

      // User messages — may contain text, image, or tool_result blocks.
      // tool_result blocks become separate tool-role messages in OpenAI format.
      // They must precede any user-role content in the message sequence because
      // the OpenAI protocol requires tool results to follow the assistant turn
      // that requested them, before the next user turn.
      const toolResultBlocks = m.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
      );
      const otherBlocks = m.content.filter(b => b.type !== 'tool_result');

      // Push tool_result blocks as tool-role messages first.
      for (const tr of toolResultBlocks) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }

      // Then push non-tool-result content as a user message.
      if (otherBlocks.length > 0) {
        conversationMessages.push({
          role: 'user',
          content: otherBlocks.map(block => {
            if (block.type === 'text') {
              return { type: 'text' as const, text: block.text };
            }
            if (block.type === 'image') {
              // Map Curia's image source to OpenAI's image_url format.
              // Base64 sources become data URIs; URL sources pass through directly.
              const url = block.source.type === 'base64'
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source.url;
              return {
                type: 'image_url' as const,
                image_url: { url },
              };
            }
            // tool_use blocks in a user message would be unusual — pass as text fallback
            if (block.type === 'tool_use') {
              return { type: 'text' as const, text: JSON.stringify(block) };
            }
            // Exhaustive guard — should never reach here
            return { type: 'text' as const, text: '' };
          }),
        });
      }
    }

    // Legacy toolResults parameter — append as tool-role messages if provided.
    // Prefer building tool_result blocks directly in the messages array instead.
    if (toolResults && toolResults.length > 0) {
      for (const tr of toolResults) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: tr.content,
        });
      }
    }

    // Prefer the explicit model param; fall back to options.model for backward compatibility.
    const optionsModel = typeof options?.model === 'string' ? options.model : undefined;
    const model = modelOverride ?? optionsModel;

    try {
      if (!model) {
        throw new Error('OpenRouterProvider.chat() requires a model — no model was provided and no default is configured');
      }

      // Per-model output cap from the registry. Fall back to 4096 for unknown models.
      const modelMaxTokens = this.modelRegistry.getModel(model)?.maxOutputTokens ?? 4096;
      // Honor the caller's max_tokens request, but never exceed the model's cap.
      const callerMaxTokens = typeof options?.max_tokens === 'number' && Number.isFinite(options.max_tokens)
        ? Math.max(1, Math.floor(options.max_tokens as number))
        : undefined;

      const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model,
        max_tokens: callerMaxTokens !== undefined ? Math.min(callerMaxTokens, modelMaxTokens) : modelMaxTokens,
        messages: conversationMessages,
      };

      // Only attach the tools array when tools are provided — the API rejects
      // an empty tools array, so we omit the key entirely when there are none.
      if (tools && tools.length > 0) {
        createParams.tools = tools.map((t): ChatCompletionTool => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema as OpenAI.FunctionParameters,
          },
        }));
      }

      const response: ChatCompletion = await this.client.chat.completions.create(createParams);

      // Extract the first choice — OpenRouter always returns at least one.
      const choice = response.choices[0];
      if (!choice) {
        throw new Error('OpenRouter returned empty choices array');
      }

      this.logger.debug(
        {
          model,
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          finishReason: choice.finish_reason,
        },
        'OpenRouter API call completed',
      );

      // OpenRouter doesn't support Anthropic-style prompt caching.
      // Cache token fields are always 0.
      const usage: LLMUsage = {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      // Provenance captures what model was requested vs. what actually ran.
      // OpenRouter may route to a different model variant (e.g. adding :free suffix).
      const provenance: LLMCallProvenance = {
        requestedModel: model,
        actualModel: response.model,
        providerRequestId: response.id,
      };

      // Check for tool calls in the response.
      const toolCalls = choice.message.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        const mappedToolCalls: ToolCall[] = toolCalls.map((tc) => {
          // Parse the JSON arguments string into a plain object.
          // The OpenAI SDK returns arguments as a JSON string.
          const parsed: unknown = JSON.parse(tc.function.arguments);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`Tool call "${tc.function.name}" returned non-object arguments: ${tc.function.arguments}`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            input: parsed as Record<string, unknown>,
          };
        });

        return {
          type: 'tool_use',
          toolCalls: mappedToolCalls,
          // Preserve text content alongside tool calls if present.
          content: choice.message.content ?? undefined,
          usage,
          provenance,
        };
      }

      // Pure text response.
      const content = choice.message.content ?? '';
      if (!content) {
        this.logger.error(
          { model, finishReason: choice.finish_reason },
          'LLM returned empty text response',
        );
      }

      return {
        type: 'text',
        content,
        usage,
        provenance,
      };
    } catch (err) {
      this.logger.error({ err, model }, 'OpenRouter API call failed');
      // Classify the error into a structured AgentError so the runtime
      // can make informed retry and budget decisions.
      return { type: 'error', error: classifyError(err, 'openrouter') };
    }
  }
}
