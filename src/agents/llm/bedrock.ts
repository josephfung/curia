// bedrock.ts — AWS Bedrock implementation of LLMProvider, via the Converse API
// (https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html).
//
// Design: docs/adr/041-aws-bedrock-llm-provider.md. Originally proposed in #1349
// (@AnshulaChowdhury); ported onto the current provider interface.
//
// Key design decisions:
//   1. Converse normalizes tool-use across every Bedrock model family into one
//      shape (toolUse/toolResult content blocks), which maps directly onto
//      Curia's provider-neutral ToolCall/ToolResult types — no per-model
//      request/response quirks, unlike Bedrock's raw InvokeModel API. The class
//      therefore works for any Converse-capable model, not just one vendor's.
//   2. System messages are concatenated into Converse's dedicated `system`
//      parameter, same pattern as anthropic.ts and openrouter.ts.
//   3. No prompt-cache checkpoints are emitted. Cache token counts are still
//      read from the response so usage stays truthful if a model reports them.
//   4. Image content blocks only support base64 sources (Converse takes raw
//      bytes, not URLs); a url-sourced image is logged and dropped rather than
//      fetched inline.
//   5. Timeout is enforced via AbortController + setTimeout rather than a
//      NodeHttpHandler config, to avoid an extra SDK sub-dependency — combined
//      with any caller-supplied AbortSignal (e.g. the outbound judge's timeout).
//   6. Errors are caught and returned as LLMResponse { type: 'error' } so
//      callers never need try/catch around chat().
//   7. Model ids are Bedrock ids as the runtime endpoint expects them. Current
//      Claude models require a geo or global inference-profile id
//      (`global.anthropic.claude-sonnet-4-6`, `us.anthropic.…`); a bare model
//      id is rejected for on-demand throughput.
//
// Not implemented (yet): stream(). Voice refuses to start without it, so a tier
// used by the voice channel must not be mapped to a Bedrock model.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message as BedrockMessage,
  type ContentBlock as BedrockContentBlock,
  type SystemContentBlock,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import type { LLMProvider, LLMResponse, LLMUsage, LLMCallProvenance, Message, ContentBlock, ToolCall, ToolDefinition, ToolResult } from './provider.js';
import type { Logger } from '../../logger.js';
import { classifyError } from '../../errors/classify.js';
import type { ModelRegistry } from './model-registry.js';
import { resolveTemperature } from './sampling-options.js';

/**
 * Scans a text response for a fenced JSON code block describing a call to one
 * of the tools that were actually offered — the signature of a model that
 * narrated an intended tool call instead of emitting a real Converse toolUse
 * block. Deliberately conservative (requires a parseable JSON object with a
 * `name` matching an offered tool) to avoid false positives on replies that
 * merely mention a tool name in passing. Returns the matched tool name, or
 * undefined if no such block is found.
 */
export function detectUncalledToolIntent(
  content: string,
  offeredToolNames: string[],
  logger?: Logger,
): string | undefined {
  const codeBlockPattern = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of content.matchAll(codeBlockPattern)) {
    const block = match[1];
    if (!block) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (err) {
      // Not JSON — an ordinary code fence, which is expected. Keep scanning.
      logger?.debug({ err }, 'Code fence in model output is not JSON — not a narrated tool call');
      continue;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { name?: unknown }).name === 'string' &&
      offeredToolNames.includes((parsed as { name: string }).name)
    ) {
      return (parsed as { name: string }).name;
    }
  }
  return undefined;
}

/**
 * Bedrock's Converse API strictly requires the message sequence to start with
 * a 'user' message and to strictly alternate user/assistant — unlike
 * Anthropic's and OpenAI's APIs, which are more forgiving. Curia's working
 * memory can still produce sequences that violate this: the synthetic
 * conversation-summary turn written by WorkingMemory's summarization pass is a
 * mid-history 'system'-role row, so once system-role messages are lifted into
 * the top-level system param the turn that follows it can become the first
 * element and be 'assistant'.
 *
 * Defensive normalization at the provider boundary: a malformed conversation
 * degrades gracefully (drop leading non-user turns, merge consecutive same-role
 * turns) instead of hard-failing every subsequent turn.
 */
export function normalizeMessageSequence(sequence: BedrockMessage[], logger: Logger): BedrockMessage[] {
  let start = 0;
  while (start < sequence.length && sequence[start]!.role !== 'user') {
    logger.warn(
      { role: sequence[start]!.role },
      'Dropping leading non-user message from conversation history — Bedrock Converse requires the sequence to start with a user message',
    );
    start++;
  }

  const merged: BedrockMessage[] = [];
  for (const msg of sequence.slice(start)) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      logger.warn(
        { role: msg.role },
        'Merging consecutive same-role messages — Bedrock Converse requires strict user/assistant alternation',
      );
      last.content = [...(last.content ?? []), ...(msg.content ?? [])];
    } else {
      merged.push({ role: msg.role, content: [...(msg.content ?? [])] });
    }
  }
  return merged;
}

export class BedrockProvider implements LLMProvider {
  id = 'bedrock';
  private client: BedrockRuntimeClient;
  private logger: Logger;
  private readonly modelRegistry: ModelRegistry;
  private readonly timeoutMs: number;

  constructor(
    accessKeyId: string,
    secretAccessKey: string,
    region: string,
    timeoutMs: number,
    logger: Logger,
    modelRegistry: ModelRegistry,
  ) {
    this.client = new BedrockRuntimeClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.logger = logger;
    this.modelRegistry = modelRegistry;
    this.timeoutMs = timeoutMs;
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
    // Concatenate all system-role messages into Converse's dedicated `system`
    // parameter — same convention as anthropic.ts/openrouter.ts. The runtime
    // injects multiple role:'system' entries (main prompt, sender context,
    // bullpen context); none should be silently dropped.
    const systemContent = messages
      .filter((m) => m.role === 'system')
      .map((m) => {
        if (typeof m.content !== 'string') {
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
    const system: SystemContentBlock[] | undefined = systemContent
      ? [{ text: systemContent }]
      : undefined;

    // Map our provider-neutral ContentBlock[] to Converse's ContentBlock union.
    const mapContentBlock = (block: ContentBlock): BedrockContentBlock | undefined => {
      if (block.type === 'text') {
        return { text: block.text };
      }
      if (block.type === 'tool_use') {
        // Cast required: DocumentType is the AWS SDK's recursive JSON-value type;
        // our input is a plain JSON-shaped object but TS can't structurally verify
        // that against DocumentType's generated union (same pattern as anthropic.ts
        // casting input_schema to the SDK's Tool['input_schema']).
        return { toolUse: { toolUseId: block.id, name: block.name, input: block.input as DocumentType } };
      }
      if (block.type === 'tool_result') {
        return {
          toolResult: {
            toolUseId: block.tool_use_id,
            content: [{ text: block.content }],
            status: block.is_error ? 'error' : 'success',
          },
        };
      }
      if (block.type === 'image') {
        if (block.source.type === 'url') {
          // Converse only accepts raw bytes, not URLs. Fetching the URL inline
          // would add a network dependency to every chat() call — out of scope
          // for now. Drop with a warning rather than fail the whole call.
          this.logger.warn('Image content block with a URL source is not supported by Bedrock Converse — dropped');
          return undefined;
        }
        // media_type is the closed union 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
        // so the suffix is exactly one of Converse's image formats.
        const format = block.source.media_type.split('/')[1] as 'jpeg' | 'png' | 'gif' | 'webp';
        return {
          image: {
            format,
            source: { bytes: Buffer.from(block.source.data, 'base64') },
          },
        };
      }
      // Exhaustive guard — log if a new ContentBlock variant is added but not handled here.
      this.logger.warn({ blockType: (block as { type: string }).type }, 'Unknown content block type — skipped');
      return undefined;
    };

    const conversationMessages: BedrockMessage[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const role = m.role as 'user' | 'assistant';
        if (typeof m.content === 'string') {
          return { role, content: [{ text: m.content }] };
        }
        const content = m.content
          .map(mapContentBlock)
          .filter((b): b is BedrockContentBlock => b !== undefined);
        return { role, content };
      })
      // Converse rejects a message with an empty content array (e.g. a turn whose
      // only block was a dropped URL image). Drop it rather than fail the call.
      .filter((m) => {
        if (m.content.length === 0) {
          this.logger.warn({ role: m.role }, 'Dropping message with no representable content blocks');
          return false;
        }
        return true;
      });

    // Legacy toolResults parameter — append as a user turn if provided.
    // Prefer building tool_result blocks directly in the messages array instead.
    if (toolResults && toolResults.length > 0) {
      conversationMessages.push({
        role: 'user',
        content: toolResults.map((tr) => ({
          toolResult: {
            toolUseId: tr.id,
            content: [{ text: tr.content }],
            status: tr.is_error ? 'error' as const : 'success' as const,
          },
        })),
      });
    }

    // Prefer the explicit model param; fall back to options.model for backward compatibility.
    const optionsModel = typeof options?.model === 'string' ? options.model : undefined;
    const model = modelOverride ?? optionsModel;

    // Timeout enforcement: internal AbortController on a timer, combined with any
    // caller-supplied signal (e.g. the outbound judge's timeout) so either one aborts the call.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const callerSignal = options?.signal instanceof AbortSignal ? options.signal : undefined;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort);
    if (callerSignal?.aborted) controller.abort();

    try {
      if (!model) {
        throw new Error('BedrockProvider.chat() requires a model — no model was provided and no default is configured');
      }

      const modelMeta = this.modelRegistry.getModel(model);
      const modelMaxTokens = modelMeta?.maxOutputTokens ?? 4096;
      if (!modelMeta) {
        this.logger.warn({ model, fallbackMaxTokens: 4096 }, 'Model not in registry — using fallback maxOutputTokens');
      }
      const callerMaxTokens = typeof options?.max_tokens === 'number' && Number.isFinite(options.max_tokens)
        ? Math.max(1, Math.floor(options.max_tokens as number))
        : undefined;

      // Unset → provider default. Bedrock's Claude models accept 0–1; a value
      // outside that range is a caller bug, so warn and fall back to the default
      // rather than let Bedrock reject every call.
      let temperature = resolveTemperature(options, this.logger);
      if (temperature !== undefined && (temperature < 0 || temperature > 1)) {
        this.logger.warn({ model, temperature }, 'options.temperature is outside the 0–1 range Bedrock accepts — ignored, provider default will be used');
        temperature = undefined;
      }

      let toolConfig: { tools: BedrockTool[] } | undefined;
      if (tools && tools.length > 0) {
        toolConfig = {
          tools: tools.map((t): BedrockTool => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              // Cast required: ToolDefinition.input_schema is a narrower JSON-Schema
              // shape than the SDK's DocumentType (same pattern as the toolUse cast above).
              inputSchema: { json: t.input_schema as DocumentType },
            },
          })),
        };
      }

      const command = new ConverseCommand({
        modelId: model,
        messages: normalizeMessageSequence(conversationMessages, this.logger),
        system,
        toolConfig,
        inferenceConfig: {
          maxTokens: callerMaxTokens !== undefined ? Math.min(callerMaxTokens, modelMaxTokens) : modelMaxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
        },
      });

      const response = await this.client.send(command, { abortSignal: controller.signal });

      const outputContent = response.output?.message?.content ?? [];
      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;

      this.logger.debug(
        { model, inputTokens, outputTokens, stopReason: response.stopReason },
        'Bedrock Converse API call completed',
      );

      if (response.stopReason === 'max_tokens') {
        this.logger.warn(
          { model, outputTokens, stopReason: response.stopReason },
          'Bedrock response truncated by max_tokens cap — output is incomplete. Consider increasing responseReserve or reducing input context.',
        );
      }

      const usage: LLMUsage = {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: response.usage?.cacheWriteInputTokens ?? 0,
        cacheReadInputTokens: response.usage?.cacheReadInputTokens ?? 0,
      };

      // Converse does not report a distinct "actual model that ran" — requested
      // and actual are the same value here (unlike OpenRouter, which may reroute).
      const provenance: LLMCallProvenance = {
        requestedModel: model,
        actualModel: model,
        providerRequestId: response.$metadata?.requestId ?? '',
      };

      // Converse's ContentBlock is a smithy "one-of" union: every member field
      // (text, toolUse, image, ...) is optional on the same object shape, with a
      // required $unknown fallback member — so a custom type-predicate narrowing
      // to a subset of those fields isn't assignable to the SDK's own type. Access
      // the optional fields directly instead of narrowing via a predicate.
      const text = outputContent
        .map((b) => b.text)
        .filter((t): t is string => typeof t === 'string')
        .join('');

      const toolUseBlocks = outputContent
        .map((b) => b.toolUse)
        .filter((tu): tu is NonNullable<typeof tu> => tu !== undefined);
      if (toolUseBlocks.length > 0) {
        const toolCalls: ToolCall[] = toolUseBlocks.map((tu) => ({
          id: tu.toolUseId ?? '',
          name: tu.name ?? '',
          input: (tu.input ?? {}) as Record<string, unknown>,
        }));

        return {
          type: 'tool_use',
          toolCalls,
          content: text || undefined,
          usage,
          provenance,
        };
      }

      if (!text) {
        this.logger.error({ model, stopReason: response.stopReason }, 'LLM returned empty text response');
      }

      // Some models (observed with a Mistral Large model under a large system
      // prompt + many tools — see ADR-041) silently degrade: instead of emitting
      // a real Converse toolUse block they describe the intended call as prose or
      // JSON in the text response. Converse reports this as a normal successful
      // end_turn, so there is no API-level error to catch. Left undetected, the
      // coordinator believes (and tells the CEO) that an action was taken when no
      // skill ever ran. Flag it loudly so it is visible in logs/monitoring rather
      // than indistinguishable from an intentional conversational reply.
      if (tools && tools.length > 0) {
        const uncalledTool = detectUncalledToolIntent(text, tools.map((t) => t.name), this.logger);
        if (uncalledTool) {
          this.logger.error(
            { model, uncalledTool, contentPreview: text.slice(0, 300) },
            'Model described a tool call in its text response instead of invoking it via Converse tool_use — the described action was NOT executed. This may indicate degraded tool-calling reliability under the current prompt/tool-count load.',
          );
        }
      }

      return {
        type: 'text',
        content: text,
        usage,
        provenance,
      };
    } catch (err) {
      this.logger.error({ err, model }, 'Bedrock Converse API call failed');
      return { type: 'error', error: classifyError(err, 'bedrock') };
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
