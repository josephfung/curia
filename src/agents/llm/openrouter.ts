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
//   5. Streaming uses OpenRouter's OpenAI-compatible chunk protocol.

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion } from 'openai/resources/chat/completions/completions.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent, LLMUsage, LLMCallProvenance, Message, ContentBlock, ToolCall, ToolDefinition, ToolResult } from './provider.js';
import type { Logger } from '../../logger.js';
import { classifyError } from '../../errors/classify.js';
import type { ModelRegistry } from './model-registry.js';

/**
 * Best-effort message extraction, mirroring classify.ts's own logic so the
 * enriched message keeps the original wrapper text (e.g. "400 Provider returned
 * error") as its prefix.
 */
function extractRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'OpenRouter request failed';
}

/**
 * OpenRouter wraps upstream provider (Google, Anthropic, DeepSeek, …) failures
 * as a terse top-level message ("Provider returned error") and buries the real
 * cause in `error.metadata`. The OpenAI SDK surfaces that body on the thrown
 * APIError as `err.error.metadata.{provider_name, raw}`. Without pulling it out,
 * a scheduled job's `last_error` reads only "400 Provider returned error" — the
 * actual reason (e.g. a Gemini-incompatible tool schema) is lost, which is how a
 * broken tier can silently suspend an agent's jobs for a week.
 *
 * Returns the upstream provider name and a human-readable reason, or undefined
 * when the error is not an OpenRouter-shaped provider error.
 */
function extractOpenRouterProviderError(
  err: unknown,
  logger: Logger,
): { providerName?: string; detail: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const body = (err as { error?: unknown }).error;
  if (typeof body !== 'object' || body === null) return undefined;
  const metadata = (body as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;

  const rawProvider = (metadata as { provider_name?: unknown }).provider_name;
  const providerName = typeof rawProvider === 'string' && rawProvider ? rawProvider : undefined;

  const rawUpstream = (metadata as { raw?: unknown }).raw;
  if (typeof rawUpstream !== 'string' || !rawUpstream) {
    // No upstream body — only useful if we at least learned the provider name.
    return providerName ? { providerName, detail: 'no upstream detail provided' } : undefined;
  }

  // `raw` is usually a JSON string of the upstream provider's own error body.
  // Prefer its nested `.error.message`; fall back to the raw string verbatim.
  let detail = rawUpstream;
  try {
    const parsed: unknown = JSON.parse(rawUpstream);
    const nested = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof nested === 'string' && nested) detail = nested;
  } catch {
    // Not JSON — the raw string is the best detail we have. classify.ts
    // truncates and PII-scrubs it downstream, so passing it through is safe.
    // This is an expected branch (some providers return a plain-string `raw`),
    // not an error condition, so log at debug rather than swallowing silently.
    logger.debug(
      { rawPreview: rawUpstream.slice(0, 200) },
      'OpenRouter metadata.raw is not JSON — using the verbatim string as the error detail',
    );
  }

  // Cap the detail so a large unparsed upstream blob can't push the actual
  // reason past classify.ts's 400-char message truncation — that would
  // reproduce, in milder form, the very burial this extraction fixes. The
  // caller leads the message with this detail, so the head always survives.
  const MAX_DETAIL_LENGTH = 300;
  if (detail.length > MAX_DETAIL_LENGTH) {
    detail = `${detail.slice(0, MAX_DETAIL_LENGTH)}…`;
  }

  return { providerName, detail };
}

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

  private buildCreateParams({
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
  }, operation: 'chat' | 'stream'): {
    createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    model: string;
    signal?: AbortSignal;
  } {
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
            // Exhaustive guard — log if a new ContentBlock variant is added
            // but not handled here, so the gap is discoverable.
            this.logger.warn({ blockType: (block as { type: string }).type }, 'Unknown content block type in user message — skipped');
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
    if (!model) {
      throw new Error(`OpenRouterProvider.${operation}() requires a model — no model was provided and no default is configured`);
    }

    // Per-model output cap from the registry. Fall back to 4096 for unknown models.
    const modelMeta = this.modelRegistry.getModel(model);
    const modelMaxTokens = modelMeta?.maxOutputTokens ?? 4096;
    if (!modelMeta) {
      this.logger.warn({ model, fallbackMaxTokens: 4096 }, 'Model not in registry — using fallback maxOutputTokens');
    }
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

    // Honor an optional AbortSignal passed via options.signal so callers can
    // cancel an in-flight request instead of orphaning it.
    const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
    return { createParams, model, signal };
  }

  private usageFromCompletion(response: ChatCompletion): LLMUsage {
    return {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  private provenanceFromCompletion(response: ChatCompletion, requestedModel: string): LLMCallProvenance {
    return {
      requestedModel,
      actualModel: response.model,
      providerRequestId: response.id,
    };
  }

  private parseToolCallInput(toolName: string, serializedArguments: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedArguments);
    } catch {
      throw new Error(
        `Tool call "${toolName}" has malformed JSON arguments: ${serializedArguments.slice(0, 200)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Tool call "${toolName}" returned non-object arguments: ${serializedArguments}`);
    }
    return parsed as Record<string, unknown>;
  }

  private classifyProviderError(err: unknown) {
    // Pull OpenRouter's buried upstream-provider detail up into the error
    // message before classification, so `last_error` (and the LLM-facing
    // <task_error> block) carry the real cause instead of the opaque
    // "400 Provider returned error" wrapper.
    const providerDetail = extractOpenRouterProviderError(err, this.logger);
    const errorForClassification = providerDetail
      ? Object.assign(
          // Lead with the distilled upstream reason so it survives the
          // downstream 400-char truncation; the opaque wrapper trails.
          new Error(
            `${providerDetail.providerName ?? 'upstream provider'}: ${providerDetail.detail} (${extractRawMessage(err)})`,
          ),
          // Preserve status/code so classifyError still maps the HTTP status
          // (400 → VALIDATION_ERROR, 5xx → PROVIDER_ERROR, etc.) correctly.
          {
            status: (err as { status?: unknown }).status,
            code: (err as { code?: unknown }).code,
          },
        )
      : err;

    const classified = classifyError(errorForClassification, 'openrouter');
    if (providerDetail?.providerName) {
      classified.context.providerName = providerDetail.providerName;
    }
    return classified;
  }

  async chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    let model: string | undefined = params.model ?? (typeof params.options?.model === 'string' ? params.options.model : undefined);

    try {
      const built = this.buildCreateParams(params, 'chat');
      model = built.model;
      const { createParams, signal } = built;
      const response: ChatCompletion = await this.client.chat.completions.create(createParams, signal ? { signal } : undefined);

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

      // Warn loudly when the model hit the max_tokens cap — the output is
      // incomplete. Callers get back a partial response with no error flag, so
      // without this warning there is no signal that truncation occurred.
      if (choice.finish_reason === 'length') {
        this.logger.warn(
          {
            model,
            outputTokens: response.usage?.completion_tokens ?? 0,
            finishReason: 'length',
          },
          'OpenRouter response truncated by max_tokens cap — output is incomplete. Consider increasing responseReserve or reducing input context.',
        );
      }

      const usage = this.usageFromCompletion(response);
      const provenance = this.provenanceFromCompletion(response, model);

      // Check for tool calls in the response.
      const toolCalls = choice.message.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        // Filter to function-type tool calls only. The OpenAI SDK's
        // ChatCompletionMessageToolCall is a union that includes a custom
        // tool call variant without a `function` property — narrow first.
        const functionCalls = toolCalls.filter(
          (tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function',
        );
        const mappedToolCalls: ToolCall[] = functionCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: this.parseToolCallInput(tc.function.name, tc.function.arguments),
        }));

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
      return { type: 'error', error: this.classifyProviderError(err) };
    }
  }

  async *stream(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): AsyncIterable<LLMStreamEvent> {
    type PendingToolCall = {
      id?: string;
      name: string;
      arguments: string;
    };

    let model: string | undefined = params.model ?? (typeof params.options?.model === 'string' ? params.options.model : undefined);

    // Abort handle for the SDK stream, captured once it's created and invoked in the
    // finally below so the underlying fetch Response / ReadableStream is released on
    // EVERY exit path — normal completion, a thrown error, an AbortSignal firing, or a
    // consumer that stops iterating this generator early (which runs the finally via
    // the generator's .return()). An undrained SDK stream retains its response buffers
    // on the V8 heap; under the scheduler's steady background LLM calls that would
    // accumulate until an OOM restart. Parity with the Anthropic path (#1648/#1651).
    // The OpenAI SDK exposes stream.controller (AbortController); abort() is idempotent,
    // so calling it after the stream has already completed is a harmless no-op.
    let abortStream: (() => void) | undefined;

    try {
      const built = this.buildCreateParams(params, 'stream');
      model = built.model;
      const { createParams, signal } = built;
      const streamParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        ...createParams,
        stream: true,
        stream_options: { include_usage: true },
      };
      const stream = await this.client.chat.completions.create(streamParams, signal ? { signal } : undefined);
      abortStream = () => stream.controller.abort();

      let content = '';
      let usage: LLMUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      let providerRequestId = '';
      let actualModel = model;
      let seenChunk = false;
      let finishReason: string | null = null;
      const toolCallDeltas = new Map<number, PendingToolCall>();

      for await (const chunk of stream) {
        seenChunk = true;
        providerRequestId = chunk.id || providerRequestId;
        actualModel = chunk.model || actualModel;

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          };
        }

        for (const choice of chunk.choices) {
          finishReason = choice.finish_reason ?? finishReason;
          const textDelta = choice.delta.content;
          if (textDelta) {
            content += textDelta;
            yield { type: 'text_delta', text: textDelta };
          }

          for (const toolCallDelta of choice.delta.tool_calls ?? []) {
            const pending = toolCallDeltas.get(toolCallDelta.index) ?? { name: '', arguments: '' };
            if (toolCallDelta.id) pending.id = toolCallDelta.id;
            if (toolCallDelta.function?.name) pending.name += toolCallDelta.function.name;
            if (toolCallDelta.function?.arguments) pending.arguments += toolCallDelta.function.arguments;
            toolCallDeltas.set(toolCallDelta.index, pending);
          }
        }
      }

      if (!seenChunk) {
        throw new Error('OpenRouter stream returned no chunks');
      }

      this.logger.debug(
        {
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          finishReason,
        },
        'OpenRouter streaming API call completed',
      );

      if (finishReason === 'length') {
        this.logger.warn(
          {
            model,
            outputTokens: usage.outputTokens,
            finishReason: 'length',
          },
          'OpenRouter streamed response truncated by max_tokens cap — output is incomplete. Consider increasing responseReserve or reducing input context.',
        );
      }

      const provenance: LLMCallProvenance = {
        requestedModel: model,
        actualModel,
        providerRequestId,
      };
      const toolCalls: ToolCall[] = Array.from(toolCallDeltas.entries())
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([index, pending]) => {
          if (!pending.id) {
            throw new Error(`Streamed tool call at index ${index} is missing id`);
          }
          if (!pending.name) {
            throw new Error(`Streamed tool call at index ${index} is missing function name`);
          }
          return {
            id: pending.id,
            name: pending.name,
            input: this.parseToolCallInput(pending.name, pending.arguments),
          };
        });

      if (toolCalls.length > 0) {
        yield {
          type: 'tool_use',
          toolCalls,
          content: content || undefined,
          usage,
          provenance,
        };
        return;
      }

      if (!content) {
        this.logger.error(
          { model, finishReason },
          'LLM returned empty streamed text response',
        );
      }
      yield {
        type: 'message_end',
        content,
        usage,
        provenance,
      };
    } catch (err) {
      this.logger.error({ err, model }, 'OpenRouter streaming API call failed');
      yield { type: 'error', error: this.classifyProviderError(err) };
    } finally {
      // Best-effort cleanup; never let an abort() failure mask the real result or error.
      if (abortStream) {
        try {
          abortStream();
        } catch (abortErr) {
          // warn (not debug): abort() IS the leak fix, so a persistent failure here means
          // the stream leak has silently returned — we want that visible in prod, and it
          // only ever logs when cleanup genuinely fails (never on the happy path).
          this.logger.warn({ abortErr, model }, 'OpenRouter stream cleanup abort() failed');
        }
      }
    }
  }
}
