// bedrock-mistral.ts — AWS Bedrock (Mistral models) implementation of LLMProvider,
// via the Converse API (https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html).
//
// Key design decisions:
//   1. Converse normalizes tool-use across every Bedrock model family into one
//      shape (toolUse/toolResult content blocks), which maps directly onto
//      Curia's provider-neutral ToolCall/ToolResult types — no per-model
//      request/response quirks to handle, unlike Bedrock's raw InvokeModel API.
//   2. System messages are concatenated into Converse's dedicated `system`
//      parameter, same pattern as anthropic.ts and openrouter.ts.
//   3. No prompt-cache support — cache token fields are always 0.
//   4. Image content blocks only support base64 sources (Converse takes raw
//      bytes, not URLs); a url-sourced image is logged and dropped rather than
//      fetched inline.
//   5. Timeout is enforced via AbortController + setTimeout rather than a
//      NodeHttpHandler config, to avoid an extra SDK sub-dependency — combined
//      with any caller-supplied AbortSignal (e.g. the outbound judge's timeout).
//   6. Errors are caught and returned as LLMResponse { type: 'error' } so
//      callers never need try/catch around chat().
//
// Basic text chat has been smoke-tested against the real ca-central-1 Bedrock
// endpoint (mistral.mistral-large-2402-v1:0), confirming credentials, the
// Converse request shape, and response parsing all work end-to-end. Tool-use
// specifically — a message that actually triggers a skill call — has NOT yet
// been exercised live; the agent execution path (the whole reason Converse was
// chosen over raw InvokeModel) still needs its own smoke test before relying
// on this in production.

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

/**
 * Scans a text response for a fenced JSON code block describing a call to one
 * of the tools that were actually offered — the signature of a model that
 * narrated an intended tool call instead of emitting a real Converse toolUse
 * block. Deliberately conservative (requires a parseable JSON object with a
 * `name` matching an offered tool) to avoid false positives on replies that
 * merely mention a tool name in passing. Returns the matched tool name, or
 * undefined if no such block is found.
 */
function detectUncalledToolIntent(content: string, offeredToolNames: string[]): string | undefined {
  const codeBlockPattern = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of content.matchAll(codeBlockPattern)) {
    const block = match[1];
    if (!block) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
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
 * memory can produce sequences that violate this: a failed LLM call persists
 * the user's turn before the call but never gets an assistant turn written
 * back (leaving consecutive 'user' turns on the next message), and the
 * synthetic conversation-summary turn WorkingMemory's summarization pass
 * writes is itself a mid-history 'system'-role row — once every provider
 * strips system-role messages out to build the top-level system param, the
 * turn immediately following the summary becomes the new first element,
 * which can be 'assistant'.
 *
 * This is a defensive normalization at the provider boundary, not a fix for
 * the underlying turn-persistence gap (see docs/adr/023) — dropping/merging
 * here means a malformed conversation degrades gracefully instead of hard
 * -failing every subsequent turn, but the root cause is upstream in
 * AgentRuntime/WorkingMemory.
 */
function normalizeMessageSequence(sequence: BedrockMessage[], logger: Logger): BedrockMessage[] {
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

export class BedrockMistralProvider implements LLMProvider {
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

    try {
      if (!model) {
        throw new Error('BedrockMistralProvider.chat() requires a model — no model was provided and no default is configured');
      }

      const modelMeta = this.modelRegistry.getModel(model);
      const modelMaxTokens = modelMeta?.maxOutputTokens ?? 4096;
      if (!modelMeta) {
        this.logger.warn({ model, fallbackMaxTokens: 4096 }, 'Model not in registry — using fallback maxOutputTokens');
      }
      const callerMaxTokens = typeof options?.max_tokens === 'number' && Number.isFinite(options.max_tokens)
        ? Math.max(1, Math.floor(options.max_tokens as number))
        : undefined;

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

      // No prompt-cache support on Bedrock Mistral.
      const usage: LLMUsage = {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
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
      const toolUseBlocks = outputContent
        .map((b) => b.toolUse)
        .filter((tu): tu is NonNullable<typeof tu> => tu !== undefined);
      if (toolUseBlocks.length > 0) {
        const toolCalls: ToolCall[] = toolUseBlocks.map((tu) => ({
          id: tu.toolUseId ?? '',
          name: tu.name ?? '',
          input: (tu.input ?? {}) as Record<string, unknown>,
        }));

        const textBlock = outputContent.find((b) => typeof b.text === 'string');

        return {
          type: 'tool_use',
          toolCalls,
          content: textBlock?.text,
          usage,
          provenance,
        };
      }

      const textBlock = outputContent.find((b) => typeof b.text === 'string');
      const content = textBlock?.text ?? '';
      if (!content) {
        this.logger.error({ model, stopReason: response.stopReason }, 'LLM returned empty text response');
      }

      // Some models (observed with mistral-large-2402 under a large system prompt
      // + many available tools — see docs/adr/023) silently degrade: instead of
      // emitting a real Converse toolUse block, they describe the intended call as
      // prose/JSON in the text response. Converse reports this as a normal
      // successful end_turn — there's no API-level error to catch. Left
      // undetected, this is a serious silent-failure mode: the coordinator
      // believes (and tells the CEO) that an action was taken when no skill ever
      // ran. Flag it loudly here so it's visible in logs/monitoring rather than
      // indistinguishable from an intentional conversational reply.
      if (tools && tools.length > 0) {
        const uncalledTool = detectUncalledToolIntent(content, tools.map((t) => t.name));
        if (uncalledTool) {
          this.logger.error(
            { model, uncalledTool, contentPreview: content.slice(0, 300) },
            'Model described a tool call in its text response instead of invoking it via Converse tool_use — the described action was NOT executed. This may indicate degraded tool-calling reliability under the current prompt/tool-count load.',
          );
        }
      }

      return {
        type: 'text',
        content,
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
