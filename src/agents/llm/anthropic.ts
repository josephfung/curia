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
import type {
  ContentBlockParam,
  Message as AnthropicMessage,
  MessageParam,
  RedactedThinkingBlockParam,
  TextBlock,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { LLMProvider, LLMReasoning, LLMResponse, LLMStreamEvent, LLMUsage, LLMCallProvenance, Message, ReasoningContent, ToolCall, ToolDefinition, ToolResult } from './provider.js';
import type { Logger } from '../../logger.js';
import { classifyError } from '../../errors/classify.js';
import type { ModelRegistry } from './model-registry.js';
import { resolveTemperature } from './sampling-options.js';
import { PrefixHasher, sendableReasoningBlocks } from './reasoning-blocks.js';

/**
 * The Anthropic thinking block a passed-back reasoning block holds, rebuilt
 * field for field as the API returned it. Undefined for anything else; a
 * thinking block with no signature would be rejected, so it is not sent.
 */
function thinkingParamFrom(data: unknown): ThinkingBlockParam | RedactedThinkingBlockParam | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const block = data as Record<string, unknown>;
  if (block.type === 'thinking' && typeof block.thinking === 'string'
    && typeof block.signature === 'string' && block.signature) {
    return { type: 'thinking', thinking: block.thinking, signature: block.signature };
  }
  if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
    return { type: 'redacted_thinking', data: block.data };
  }
  return undefined;
}

/** Hash of a request's system, tools and every message, as sent. */
function requestPrefixHash(params: Anthropic.Messages.MessageCreateParamsNonStreaming): string {
  const hasher = new PrefixHasher(params.system, params.tools);
  for (const message of params.messages) hasher.addMessage(message);
  return hasher.digestNow();
}

/**
 * Index of the first message whose passed-back thinking answered a different
 * prefix than the one now in front of it, or undefined when every block still
 * matches. A block with no recorded hash counts as stale.
 */
function firstStaleReasoningTurn(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  reasoningTurns: ReadonlyMap<number, readonly ReasoningContent[]>,
): number | undefined {
  const hasher = new PrefixHasher(params.system, params.tools);
  for (let i = 0; i < params.messages.length; i++) {
    const blocks = reasoningTurns.get(i);
    if (blocks) {
      const current = hasher.digestNow();
      if (blocks.some((block) => block.prefixHash !== current)) return i;
    }
    hasher.addMessage(params.messages[i]);
  }
  return undefined;
}

/**
 * Thinking blocks a response returned, in order, as reasoning blocks for the
 * next request of the tool loop (ADR-048 §1). `prefixHash` is set when the
 * model binds thinking to the request prefix.
 */
function reasoningBlocksFrom(response: AnthropicMessage, model: string, prefixHash: string | undefined): ReasoningContent[] {
  return response.content
    .filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking')
    .map((block) => ({
      type: 'reasoning' as const,
      provider: 'anthropic' as const,
      model,
      data: block,
      ...(prefixHash !== undefined ? { prefixHash } : {}),
    }));
}

/**
 * Readable thinking for the archive (#2042 parity). Thinking blocks with no
 * text (Haiku 5.5's default display) or redacted blocks are `encrypted`.
 */
function reasoningFieldsFrom(response: AnthropicMessage, usage: LLMUsage): LLMReasoning {
  const thinking = response.content.filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking');
  const text = thinking
    .map((block) => (block.type === 'thinking' ? block.thinking : ''))
    .filter((t) => t.trim())
    .join('\n');
  if (text) return { reasoning: text };
  if (thinking.length > 0) return { reasoningOmitted: 'encrypted' };
  return (usage.reasoningTokens ?? 0) > 0 ? { reasoningOmitted: 'empty' } : {};
}

export class AnthropicProvider implements LLMProvider {
  id = 'anthropic';
  private client: Anthropic;
  private logger: Logger;
  private readonly modelRegistry: ModelRegistry;

  constructor(apiKey: string, logger: Logger, modelRegistry: ModelRegistry) {
    this.client = new Anthropic({ apiKey });
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
    createParams: Anthropic.Messages.MessageCreateParamsNonStreaming;
    model: string;
    signal?: AbortSignal;
    /** Set when the model binds thinking to the request prefix (prefix guard). */
    prefixHash?: string;
  } {
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

    // Prefer the explicit model param; fall back to options.model for backward compatibility.
    // No default: the runtime always provides model via resolvedModel, so a missing model
    // indicates a bug at the call site. Fail loudly rather than silently using a stale default.
    const optionsModel = typeof options?.model === 'string' ? options.model : undefined;
    const model = modelOverride ?? optionsModel;
    if (!model) {
      throw new Error(`AnthropicProvider.${operation}() requires a model — no model was provided and no default is configured`);
    }

    // Build the Anthropic message array from our provider-neutral Message type.
    // Messages with string content are simple text; messages with ContentBlock[]
    // carry tool_use or tool_result blocks for multi-turn tool-use conversations.
    // An assistant turn's reasoning blocks become thinking blocks again, first in
    // the turn, when this model wrote them (ADR-048 §1). reasoningTurns records
    // which mapped messages carry them, for the prefix guard below.
    const reasoningTurns = new Map<number, ReasoningContent[]>();
    const conversationMessages: MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (typeof m.content === 'string') {
        conversationMessages.push({ role: m.role, content: m.content });
        continue;
      }
      const sendable = m.role === 'assistant'
        ? sendableReasoningBlocks(m.content, 'anthropic', model, this.logger)
        : [];
      const thinkingBlocks: Array<ThinkingBlockParam | RedactedThinkingBlockParam> = [];
      const carried: ReasoningContent[] = [];
      for (const block of sendable) {
        const param = thinkingParamFrom(block.data);
        if (param) {
          thinkingBlocks.push(param);
          carried.push(block);
        } else {
          this.logger.warn({ model }, 'Dropping a passed-back reasoning block that is not an Anthropic thinking block');
        }
      }
      // ContentBlock[] — map our provider-neutral blocks to Anthropic SDK shapes
      const mapped: ContentBlockParam[] = [...thinkingBlocks];
      for (const block of m.content) {
        if (block.type === 'reasoning') continue;
        if (block.type === 'tool_use') {
          mapped.push({ type: 'tool_use' as const, id: block.id, name: block.name, input: block.input });
        } else if (block.type === 'tool_result') {
          mapped.push({ type: 'tool_result' as const, tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error });
        } else if (block.type === 'image') {
          // Pass image blocks through to the Anthropic SDK as-is — the shape
          // matches the SDK's ImageBlockParam structure directly.
          mapped.push(block as unknown as Anthropic.Messages.ImageBlockParam);
        } else {
          // TextContent
          mapped.push({ type: 'text' as const, text: block.text });
        }
      }
      if (carried.length > 0) reasoningTurns.set(conversationMessages.length, carried);
      conversationMessages.push({ role: m.role, content: mapped });
    }

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

    // Per-model output cap from the registry. Fall back to 4096 for unknown models.
    const modelMaxTokens = this.modelRegistry.getModel(model)?.maxOutputTokens ?? 4096;
    // Honor the caller's max_tokens request, but never exceed the model's cap.
    // Skills use low limits (e.g. 10 for a classifier gate) to stay cheap —
    // silently ignoring those limits defeats the purpose of passing them.
    const callerMaxTokens = typeof options?.max_tokens === 'number' && Number.isFinite(options.max_tokens)
      ? Math.max(1, Math.floor(options.max_tokens as number))
      : undefined;
    const createParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: callerMaxTokens !== undefined ? Math.min(callerMaxTokens, modelMaxTokens) : modelMaxTokens,
      // Wrap the concatenated system string in a TextBlockParam array with a
      // cache_control breakpoint. This tells Anthropic to cache everything up
      // to this block, saving ~5K tokens of system prompt cost on repeat calls.
      // Omit the key entirely when there is no system content (same as before).
      system: systemContent
        ? [{ type: 'text' as const, text: systemContent, cache_control: { type: 'ephemeral' as const } } satisfies TextBlockParam]
        : undefined,
      messages: conversationMessages,
    };

    // Forward a finite caller temperature; omit the key otherwise so the
    // upstream model keeps its default (judges pass 0 for stable verdicts).
    // Models flagged rejectsSamplingParams 400 on any non-default value, so the
    // key is never sent to them; llm.call publishers apply the same rule via
    // sentTemperature() (#2077). Curia sends no top_p or top_k to any model.
    const temperature = resolveTemperature(options, this.logger);
    if (temperature !== undefined) {
      if (this.modelRegistry.rejectsSamplingParams(model)) {
        this.logger.debug({ model, temperature }, 'Omitting temperature — model rejects sampling parameters');
      } else {
        createParams.temperature = temperature;
      }
    }

    // Models that think by default (Haiku 5.5) would otherwise spend max_tokens
    // on a thinking block — a 10-token classifier cap can then return no text —
    // and emit thinking blocks this provider does not carry back through tool
    // loops. Curia never enabled thinking on Haiku 4.5, so keep it off here
    // until the reasoning policy is decided (#2044, #2077).
    if (this.modelRegistry.thinksByDefault(model)) {
      createParams.thinking = { type: 'disabled' };
    }

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
      // list is captured in a single cache slot. An agent's pinned tool list is
      // stable between turns, so it is served from cache within the 5-minute
      // TTL. No size is quoted here: it grows with every pinned skill.
      // Mutate in place rather than spread-reassign — the spread pattern widens
      // the inferred type and makes required fields optional, breaking assignability.
      mappedTools[mappedTools.length - 1]!.cache_control = { type: 'ephemeral' as const };
      createParams.tools = mappedTools;
    }

    // Prefix guard (ADR-048 §1). On a model whose thinking is bound to the
    // request prefix, a thinking block sent back after system, tools or an
    // earlier message changed returns a 400. The tool loop does change them
    // mid-loop (the Bullpen refresh, tool discovery), so drop thinking from the
    // first turn whose prefix differs from the one its block answered, through
    // the end. The docs allow dropping from a point to the end; the model loses
    // that reasoning. The hash of this whole request goes on blocks it returns.
    let prefixHash: string | undefined;
    if (this.modelRegistry.thinkingBoundToPrefix(model)) {
      if (reasoningTurns.size > 0) {
        const staleFrom = firstStaleReasoningTurn(createParams, reasoningTurns);
        if (staleFrom !== undefined) {
          let dropped = 0;
          for (let i = staleFrom; i < conversationMessages.length; i++) {
            const message = conversationMessages[i]!;
            if (typeof message.content === 'string') continue;
            const kept = message.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
            dropped += message.content.length - kept.length;
            conversationMessages[i] = { ...message, content: kept };
          }
          this.logger.info(
            { model, dropped, fromMessage: staleFrom, reason: 'prefix_changed' },
            'Dropping passed-back thinking after a request prefix change',
          );
        }
      }
      prefixHash = requestPrefixHash(createParams);
    }

    // Honor an optional AbortSignal passed via options.signal so callers can
    // cancel an in-flight request instead of orphaning it.
    const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
    return { createParams, model, signal, ...(prefixHash !== undefined ? { prefixHash } : {}) };
  }

  private usageFromResponse(response: AnthropicMessage): LLMUsage {
    // thinking_tokens is a subset of output_tokens, like OpenRouter's
    // reasoning_tokens. output_tokens_details is null when the API omits it;
    // leave reasoningTokens unset then so llm.call records "not reported".
    const thinkingTokens = response.usage.output_tokens_details?.thinking_tokens;
    return {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      ...(typeof thinkingTokens === 'number' ? { reasoningTokens: thinkingTokens } : {}),
    };
  }

  private provenanceFromResponse(response: AnthropicMessage, requestedModel: string): LLMCallProvenance {
    return {
      requestedModel,
      actualModel: response.model,
      providerRequestId: response.id,
    };
  }

  private toolCallsFromResponse(response: AnthropicMessage): ToolCall[] {
    const toolUseBlocks = response.content.filter(
      (c): c is ToolUseBlock => c.type === 'tool_use',
    );
    return toolUseBlocks.map((block) => ({
      id: block.id,
      name: block.name,
      // block.input is typed as unknown by the SDK; well-formed tool inputs are
      // plain objects by the time they reach provider-neutral callers.
      input: block.input as Record<string, unknown>,
    }));
  }

  private textFromResponse(response: AnthropicMessage): string {
    return response.content
      .filter((c): c is TextBlock => c.type === 'text')
      .map((block) => block.text)
      .join('');
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
      const { createParams, signal, prefixHash } = built;
      const response = await this.client.messages.create(createParams, signal ? { signal } : undefined);

      this.logger.debug(
        {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          stopReason: response.stop_reason,
        },
        'Anthropic API call completed',
      );

      const usage = this.usageFromResponse(response);
      const provenance = this.provenanceFromResponse(response, model);
      const reasoning = reasoningFieldsFrom(response, usage);

      // Use type guard functions for narrowing — avoids casting and is safer
      // than checking c.type === 'tool_use' without narrowing to ToolUseBlock.
      const toolCalls = this.toolCallsFromResponse(response);
      if (toolCalls.length > 0) {
        // The model may emit a text preamble alongside tool calls (e.g.
        // "Let me look that up…"). Preserve it so callers can surface it.
        const textContent = this.textFromResponse(response);
        const reasoningBlocks = reasoningBlocksFrom(response, model, prefixHash);

        return {
          type: 'tool_use',
          toolCalls,
          content: textContent || undefined,
          ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
          usage,
          provenance,
          ...reasoning,
        };
      }

      // response.content is an array of content blocks (text, tool_use, etc.).
      // Text blocks are concatenated; if the model returns only tool_use
      // blocks, content will be an empty string.
      const content = this.textFromResponse(response);
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
        provenance,
        ...reasoning,
      };
    } catch (err) {
      this.logger.error({ err, model }, 'Anthropic API call failed');
      // Classify the error into a structured AgentError so the runtime
      // can make informed retry and budget decisions.
      return { type: 'error', error: classifyError(err, 'anthropic') };
    }
  }

  async *stream(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): AsyncIterable<LLMStreamEvent> {
    let model: string | undefined = params.model ?? (typeof params.options?.model === 'string' ? params.options.model : undefined);

    try {
      const built = this.buildCreateParams(params, 'stream');
      model = built.model;
      const { createParams, signal, prefixHash } = built;
      const stream = this.client.messages.stream(createParams, signal ? { signal } : undefined);

      // Guarantee the underlying fetch Response / ReadableStream is released on every
      // exit path — normal completion, a thrown error, an AbortSignal firing, or a
      // consumer that stops iterating this generator early (which runs this finally via
      // the generator's .return()). An undrained SDK stream retains its response
      // ArrayBuffers on the V8 heap; under the scheduler's steady background LLM calls
      // that accumulates until an OOM restart (#1648; upstream anthropics/claude-code#33380).
      // MessageStream.abort() is idempotent — calling it after finalMessage() is a no-op.
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
            yield { type: 'text_delta', text: event.delta.text };
          }
        }

        const response = await stream.finalMessage();
        this.logger.debug(
          {
            model,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
            stopReason: response.stop_reason,
          },
          'Anthropic streaming API call completed',
        );

        const usage = this.usageFromResponse(response);
        const provenance = this.provenanceFromResponse(response, model);
        const toolCalls = this.toolCallsFromResponse(response);
        const content = this.textFromResponse(response);
        const reasoning = reasoningFieldsFrom(response, usage);

        if (toolCalls.length > 0) {
          const reasoningBlocks = reasoningBlocksFrom(response, model, prefixHash);
          yield {
            type: 'tool_use',
            toolCalls,
            content: content || undefined,
            ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
            usage,
            provenance,
            ...reasoning,
          };
          return;
        }

        if (!content) {
          this.logger.error({ model, stopReason: response.stop_reason }, 'LLM returned empty streamed text response');
        }
        yield {
          type: 'message_end',
          content,
          usage,
          provenance,
          ...reasoning,
        };
      } finally {
        // Best-effort cleanup; never let an abort() failure mask the real result or error.
        try {
          stream.abort();
        } catch (abortErr) {
          // Best-effort cleanup, logged at warn (not error): the request result was already
          // handled above and is unaffected — this is stream hygiene, not a request failure.
          // It only fires if abort() itself fails (never on the happy path), so a recurring
          // warn here is the signal that the stream leak (#1648/#1651) has returned.
          this.logger.warn({ abortErr, model }, 'Anthropic stream cleanup abort() failed');
        }
      }
    } catch (err) {
      this.logger.error({ err, model }, 'Anthropic streaming API call failed');
      yield { type: 'error', error: classifyError(err, 'anthropic') };
    }
  }
}
