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
//   3. Usage is normalized to Anthropic semantics: OpenRouter's prompt_tokens
//      includes cache reads and writes, so they are split out of inputTokens
//      (see usageFromOpenRouter).
//   4. Errors are caught and returned as LLMResponse { type: 'error' } so
//      callers never need try/catch around chat().
//   5. Streaming uses OpenRouter's OpenAI-compatible chunk protocol.

import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { ChatCompletionAssistantMessageParam, ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion } from 'openai/resources/chat/completions/completions.js';
import type { CompletionUsage } from 'openai/resources/completions.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent, LLMUsage, LLMCallProvenance, LLMReasoning, Message, ContentBlock, ReasoningContent, ToolCall, ToolDefinition, ToolResult, ReasoningOmission } from './provider.js';
import type { Logger } from '../../logger.js';
import { classifyError } from '../../errors/classify.js';
import type { ModelRegistry } from './model-registry.js';
import { logUnsentReasoningEffort, resolveReasoning, resolveTemperature, type ReasoningEffort } from './sampling-options.js';
import { sendableReasoningBlocks } from './reasoning-blocks.js';
import { isCallerCancellation } from './cancellation.js';
import { LLM_REQUEST_TIMEOUT_MS } from './request-timeout.js';

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

/**
 * OpenRouter's top-level `provider` field names the upstream endpoint that
 * served the call (e.g. 'DeepSeek', 'CoreWeave'). The OpenAI SDK types do not
 * declare it, so read it defensively from the response body or a stream chunk.
 */
export function upstreamProviderFrom(carrier: object): string | undefined {
  const value = (carrier as { provider?: unknown }).provider;
  return typeof value === 'string' && value ? value : undefined;
}

/** Per-attempt request timeout; see LLM_REQUEST_TIMEOUT_MS (#1915). */
export const OPENROUTER_REQUEST_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;

/** Attempts per chat() call: the first plus the SDK's default of two retries. */
export const OPENROUTER_MAX_ATTEMPTS = 3;

/**
 * Whether chat() retries a failed request. The openai SDK's own rule: connection
 * errors and timeouts, 408, 409, 429 and 5xx, unless an `x-should-retry` header
 * says otherwise. chat() applies it itself so each retry is logged and counted
 * on llm.call, instead of the SDK folding it silently into one call (#1915).
 */
export function isRetryableOpenRouterError(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return false;
  if (err instanceof APIConnectionError) return true;
  if (!(err instanceof APIError)) return false;
  const shouldRetry = err.headers?.get('x-should-retry');
  if (shouldRetry === 'true') return true;
  if (shouldRetry === 'false') return false;
  const status = err.status;
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}

/** Wait the server asked for in `retry-after-ms` or `retry-after`, if it gave one. */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const millis = headers?.get('retry-after-ms');
  if (millis) {
    const value = parseFloat(millis);
    if (!Number.isNaN(value)) return value;
  }
  const after = headers?.get('retry-after');
  if (!after) return undefined;
  const seconds = parseFloat(after);
  return Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
}

/**
 * Backoff before retry number `retry` (1-based), matching the openai SDK: the
 * server's retry-after when it is 0–60s, otherwise 0.5s doubling per retry,
 * capped at 8s, less up to 25% jitter.
 */
export function openRouterRetryDelayMs(err: unknown, retry: number, random: () => number = Math.random): number {
  const requested = retryAfterMs(err instanceof APIError ? err.headers : undefined);
  if (requested !== undefined && Number.isFinite(requested) && requested >= 0 && requested <= 60_000) {
    return requested;
  }
  const baseMs = Math.min(500 * 2 ** (retry - 1), 8_000);
  return Math.round(baseMs * (1 - random() * 0.25));
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A completion that ran into max_tokens before producing anything usable: no
 * text and no tool call. Typically the whole budget went on reasoning. A
 * truncated response that still carries an answer does not count (#1915).
 */
export function isEmptyAtOutputCap(response: ChatCompletion): boolean {
  const choice = response.choices[0];
  if (!choice || choice.finish_reason !== 'length') return false;
  const hasText = typeof choice.message.content === 'string' && choice.message.content.trim() !== '';
  const hasToolCalls = (choice.message.tool_calls?.length ?? 0) > 0;
  return !hasText && !hasToolCalls;
}

/** Token counts of two requests added together, for a call that took more than one. */
function addUsage(a: LLMUsage, b: LLMUsage | undefined): LLMUsage {
  if (!b) return a;
  const reasoningReported = a.reasoningTokens !== undefined || b.reasoningTokens !== undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    ...(reasoningReported ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) } : {}),
  };
}

type CreateOutcome =
  | {
      ok: true;
      response: ChatCompletion;
      attempts: number;
      failedAttemptsMs: number;
      /** Tokens billed for attempts that came back empty at the output cap. */
      discardedUsage: LLMUsage | undefined;
    }
  | { ok: false; err: unknown; attempts: number };

/** Non-negative integer count, or 0 for anything else (absent, null, malformed). */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Map an OpenRouter usage object onto LLMUsage, which follows Anthropic's
 * semantics: inputTokens counts only uncached input, and cache reads/writes are
 * reported separately. OpenRouter follows OpenAI instead — prompt_tokens is the
 * whole prompt, with the cached share broken out in prompt_tokens_details:
 *   cached_tokens      — read from the cache (OpenAI's own field)
 *   cache_write_tokens — written to the cache (OpenRouter addition, absent from
 *                        the SDK type, so read defensively)
 * Subtracting both keeps pricing.ts from charging cached tokens twice.
 */
export function usageFromOpenRouter(usage: CompletionUsage | null | undefined): LLMUsage {
  const promptTokens = tokenCount(usage?.prompt_tokens);
  const details: Record<string, unknown> = { ...usage?.prompt_tokens_details };
  const cacheReadInputTokens = tokenCount(details.cached_tokens);
  const cacheCreationInputTokens = tokenCount(details.cache_write_tokens);
  // reasoning_tokens is a subset of completion_tokens, so it stays inside
  // outputTokens. The split is what lets an archive explain a large bill.
  // Left unset when the response carries no count, so llm.call records null
  // ("not reported") rather than a reported zero.
  const rawReasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadInputTokens - cacheCreationInputTokens),
    outputTokens: tokenCount(usage?.completion_tokens),
    cacheCreationInputTokens,
    cacheReadInputTokens,
    ...(typeof rawReasoningTokens === 'number' ? { reasoningTokens: tokenCount(rawReasoningTokens) } : {}),
  };
}

interface ReasoningBlock {
  type: string;
  id: string | null;
  text: string;
}

interface ReasoningDetailState {
  blocks: ReasoningBlock[];
  sawEncrypted: boolean;
}

function emptyReasoningState(): ReasoningDetailState {
  return { blocks: [], sawEncrypted: false };
}

/**
 * Fold one reasoning_details entry into the accumulator.
 * Consecutive fragments of the same type and id are concatenated — that is
 * how streaming deltas arrive. A new type or id starts another block.
 * Encrypted entries are noted and never copied: the ciphertext is not readable
 * and must not land in the archive.
 */
function absorbReasoningDetail(state: ReasoningDetailState, detail: unknown): void {
  if (typeof detail !== 'object' || detail === null) return;
  const record = detail as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'reasoning.encrypted') {
    state.sawEncrypted = true;
    return;
  }
  let text = '';
  if (type === 'reasoning.text' && typeof record.text === 'string') text = record.text;
  else if (type === 'reasoning.summary' && typeof record.summary === 'string') text = record.summary;
  if (!text) return;
  const id = typeof record.id === 'string' && record.id ? record.id : null;
  const last = state.blocks[state.blocks.length - 1];
  const continues = last !== undefined
    && last.type === type
    && (last.id === id || last.id === null || id === null);
  if (continues && last) {
    last.text += text;
    if (last.id === null && id !== null) last.id = id;
    return;
  }
  state.blocks.push({ type, id, text });
}

function absorbReasoningDetails(state: ReasoningDetailState, details: unknown): void {
  if (!Array.isArray(details)) return;
  for (const detail of details) absorbReasoningDetail(state, detail);
}

/** The readable text (reasoning.text and reasoning.summary) in one chunk's reasoning_details; encrypted entries add nothing. */
function readableReasoningDetailsText(details: unknown): string {
  if (!Array.isArray(details)) return '';
  let text = '';
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null) continue;
    const record = detail as Record<string, unknown>;
    if (record.type === 'reasoning.text' && typeof record.text === 'string') text += record.text;
    else if (record.type === 'reasoning.summary' && typeof record.summary === 'string') text += record.summary;
  }
  return text;
}

/** Models already warned for returning reasoning tokens without readable text. */
const reasoningOmissionWarned = new Set<string>();

/**
 * Prefer a direct reasoning string. Fall back to text and summary blocks.
 * When usage reports reasoning tokens and nothing readable came back, say why
 * and warn once per model per process.
 */
function reasoningFieldsFromParts(
  direct: string,
  state: ReasoningDetailState,
  usage: LLMUsage,
  model: string,
  logger: Logger,
): LLMReasoning {
  const detailText = state.blocks.map((block) => block.text).join('\n');
  const text = direct.trim() ? direct : detailText;
  if (text.trim()) return { reasoning: text };
  const tokens = usage.reasoningTokens ?? 0;
  if (tokens <= 0) return {};
  const reasoningOmitted: ReasoningOmission = state.sawEncrypted ? 'encrypted' : 'empty';
  if (model && !reasoningOmissionWarned.has(model)) {
    reasoningOmissionWarned.add(model);
    logger.warn(
      { model, reasoningOmitted, reasoningTokens: tokens },
      'OpenRouter reported reasoning tokens but returned no readable reasoning',
    );
  }
  return { reasoningOmitted };
}

function reasoningFromCarrier(
  carrier: object,
  usage: LLMUsage,
  model: string,
  logger: Logger,
): LLMReasoning {
  const raw = carrier as { reasoning?: unknown; reasoning_details?: unknown };
  const direct = typeof raw.reasoning === 'string' ? raw.reasoning : '';
  const state = emptyReasoningState();
  absorbReasoningDetails(state, raw.reasoning_details);
  return reasoningFieldsFromParts(direct, state, usage, model, logger);
}

/**
 * The reasoning an OpenRouter response carried, kept verbatim so the next
 * request of the tool loop can send it back (ADR-048 §1). `reasoning_details`
 * is preferred; a bare `reasoning` string is kept only when no details came.
 */
export interface OpenRouterReasoningData {
  reasoning_details?: unknown[];
  reasoning?: string;
}

/**
 * OpenRouter's unified reasoning parameter, which the SDK type does not declare.
 * `none` is sent as `{ enabled: false }` (ADR-048 §2).
 */
type OpenRouterReasoningParam = { effort: Exclude<ReasoningEffort, 'none'> } | { enabled: false };

/** An assistant message carrying passed-back reasoning, which the SDK type does not declare. */
type AssistantMessageWithReasoning = ChatCompletionAssistantMessageParam & OpenRouterReasoningData;

// Streamed reasoning_details fragments concatenate these fields; every other
// field (type, id, format, index, signature) takes the latest non-null value.
const CONCATENATED_DETAIL_FIELDS = new Set(['text', 'summary', 'data']);

function detailTarget(
  details: Array<Record<string, unknown>>,
  fragment: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof fragment.index === 'number') return details.find((d) => d.index === fragment.index);
  if (typeof fragment.id === 'string' && fragment.id) return details.find((d) => d.id === fragment.id);
  const last = details[details.length - 1];
  return last !== undefined && last.type === fragment.type ? last : undefined;
}

/**
 * Fold one chunk's `delta.reasoning_details` into the array the non-streamed
 * response would have carried. Fragments of one entry share an `index` (or,
 * failing that, an `id`); their text, summary and data concatenate.
 */
export function mergeReasoningDetailDeltas(details: Array<Record<string, unknown>>, deltas: unknown): void {
  if (!Array.isArray(deltas)) return;
  for (const raw of deltas) {
    if (typeof raw !== 'object' || raw === null) continue;
    const fragment = raw as Record<string, unknown>;
    const target = detailTarget(details, fragment);
    if (!target) {
      details.push({ ...fragment });
      continue;
    }
    for (const [key, value] of Object.entries(fragment)) {
      if (value === null || value === undefined) continue;
      const existing = target[key];
      target[key] = CONCATENATED_DETAIL_FIELDS.has(key) && typeof value === 'string' && typeof existing === 'string'
        ? existing + value
        : value;
    }
  }
}

/** The reasoning block for a tool_use response, or none when it carried no reasoning. */
function openRouterReasoningBlocks(details: unknown, direct: string, model: string): ReasoningContent[] {
  const data: OpenRouterReasoningData = {};
  if (Array.isArray(details) && details.length > 0) data.reasoning_details = details;
  else if (direct) data.reasoning = direct;
  else return [];
  return [{ type: 'reasoning', provider: 'openrouter', model, data }];
}

/** The fields an assistant message sends back, from this model's reasoning blocks. */
function reasoningFieldsForRequest(blocks: readonly ReasoningContent[]): OpenRouterReasoningData {
  const details: unknown[] = [];
  const direct: string[] = [];
  for (const block of blocks) {
    const data = block.data as OpenRouterReasoningData;
    if (Array.isArray(data.reasoning_details)) details.push(...data.reasoning_details);
    else if (typeof data.reasoning === 'string') direct.push(data.reasoning);
  }
  if (details.length > 0) return { reasoning_details: details };
  if (direct.length > 0) return { reasoning: direct.join('') };
  return {};
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
      timeout: OPENROUTER_REQUEST_TIMEOUT_MS,
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
    /** The effort the request carries, when it sends one. */
    reasoningEffort?: ReasoningEffort;
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

    // Prefer the explicit model param; fall back to options.model for backward compatibility.
    const optionsModel = typeof options?.model === 'string' ? options.model : undefined;
    const model = modelOverride ?? optionsModel;
    if (!model) {
      throw new Error(`OpenRouterProvider.${operation}() requires a model — no model was provided and no default is configured`);
    }

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
          // Reasoning this model wrote beside the calls goes back unmodified
          // (ADR-048 §1); DeepSeek documents it as required whenever tools are sent.
          const assistant: AssistantMessageWithReasoning = {
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
            ...reasoningFieldsForRequest(sendableReasoningBlocks(m.content, 'openrouter', model, this.logger)),
          };
          conversationMessages.push(assistant);
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
      // Reasoning blocks belong to assistant turns only; skip any here.
      const otherBlocks = m.content.filter(b => b.type !== 'tool_result' && b.type !== 'reasoning');

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

    // Forward a finite caller temperature; omit the key otherwise so the
    // upstream model keeps its default (judges pass 0 for stable verdicts).
    const temperature = resolveTemperature(options, this.logger);
    if (temperature !== undefined) {
      createParams.temperature = temperature;
    }

    // Reasoning effort (ADR-048 §2). Unset sends no key, so the model keeps its
    // own default. An effort the model's registry entry does not list is left
    // out: tiers are validated at boot, so this is a call site's `none` on a
    // model that cannot turn reasoning off cleanly.
    let reasoningEffort: ReasoningEffort | undefined;
    const requestedEffort = resolveReasoning(options, this.logger);
    if (requestedEffort !== undefined) {
      if (this.modelRegistry.honorsReasoningEffort(model, requestedEffort)) {
        const reasoning: OpenRouterReasoningParam = requestedEffort === 'none'
          ? { enabled: false }
          : { effort: requestedEffort };
        (createParams as typeof createParams & { reasoning?: OpenRouterReasoningParam }).reasoning = reasoning;
        reasoningEffort = requestedEffort;
      } else {
        logUnsentReasoningEffort(this.logger, model, requestedEffort, this.modelRegistry.reasoningSupport(model)?.efforts);
      }
    }

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
    return { createParams, model, signal, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
  }

  private usageFromCompletion(response: ChatCompletion): LLMUsage {
    return usageFromOpenRouter(response.usage);
  }

  private provenanceFromCompletion(
    response: ChatCompletion,
    requestedModel: string,
    reasoningEffort: ReasoningEffort | undefined,
  ): LLMCallProvenance {
    const upstreamProvider = upstreamProviderFrom(response);
    return {
      requestedModel,
      actualModel: response.model,
      providerRequestId: response.id,
      ...(upstreamProvider !== undefined ? { upstreamProvider } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
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

  /**
   * Send a non-streamed request, retrying it here rather than in the SDK
   * (`maxRetries: 0`) so every failed attempt is logged and the count reaches
   * llm.call (#1915). stream() sends one request with SDK retries off too; a
   * failed watched stream falls back to chat(), which retries here (#2371).
   *
   * A response that hit max_tokens with no answer is retried too, at once: it is
   * not an overload signal. The last attempt's response is returned whatever it
   * holds, so the caller's own empty-response handling still applies.
   */
  private async createWithRetries(
    createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
    model: string,
  ): Promise<CreateOutcome> {
    const startedMs = Date.now();
    // Billed tokens of empty-at-cap attempts before `lastEmpty`.
    let discardedUsage: LLMUsage | undefined;
    // The latest empty-at-cap response, held so a retry that then errors does
    // not lose it: its tokens were billed and only a returned response reaches
    // llm.call.
    let lastEmpty: { response: ChatCompletion; usage: LLMUsage; attemptMs: number } | undefined;

    const giveUp = (err: unknown, attempts: number): CreateOutcome => {
      if (!lastEmpty) return { ok: false, err, attempts };
      // Return what chat() returned before it retried empty responses, so the
      // caller's empty-response handling runs and every billed token is recorded.
      this.logger.warn(
        { err, model, attempts },
        'OpenRouter retry after an empty max_tokens response failed — returning the empty response',
      );
      return {
        ok: true,
        response: lastEmpty.response,
        attempts,
        failedAttemptsMs: Date.now() - startedMs - lastEmpty.attemptMs,
        discardedUsage,
      };
    };

    for (let attempt = 1; ; attempt++) {
      const attemptStartMs = Date.now();
      let response: ChatCompletion;
      try {
        response = await this.client.chat.completions.create(createParams, {
          maxRetries: 0,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (attempt >= OPENROUTER_MAX_ATTEMPTS || signal?.aborted || !isRetryableOpenRouterError(err)) {
          return giveUp(err, attempt);
        }
        const delayMs = openRouterRetryDelayMs(err, attempt);
        this.logger.warn(
          { err, model, attempt, maxAttempts: OPENROUTER_MAX_ATTEMPTS, attemptMs: Date.now() - attemptStartMs, delayMs },
          'OpenRouter API call failed — retrying',
        );
        await sleep(delayMs, signal);
        if (signal?.aborted) return giveUp(err, attempt);
        continue;
      }

      if (isEmptyAtOutputCap(response) && attempt < OPENROUTER_MAX_ATTEMPTS && !signal?.aborted) {
        const usage = usageFromOpenRouter(response.usage);
        if (lastEmpty) discardedUsage = addUsage(lastEmpty.usage, discardedUsage);
        lastEmpty = { response, usage, attemptMs: Date.now() - attemptStartMs };
        this.logger.warn(
          {
            model,
            attempt,
            maxAttempts: OPENROUTER_MAX_ATTEMPTS,
            attemptMs: Date.now() - attemptStartMs,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            upstreamProvider: upstreamProviderFrom(response),
          },
          'OpenRouter response hit max_tokens with no answer — retrying',
        );
        continue;
      }

      return {
        ok: true,
        response,
        attempts: attempt,
        failedAttemptsMs: attemptStartMs - startedMs,
        // Billed even though unusable, so llm.call's tokens and cost include them.
        discardedUsage: lastEmpty ? addUsage(lastEmpty.usage, discardedUsage) : discardedUsage,
      };
    }
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
      const { createParams, signal, reasoningEffort } = built;
      const outcome = await this.createWithRetries(createParams, signal, model);
      if (!outcome.ok) {
        this.logger.error({ err: outcome.err, model, attempts: outcome.attempts }, 'OpenRouter API call failed');
        const error = this.classifyProviderError(outcome.err);
        error.context.attempts = outcome.attempts;
        return { type: 'error', error };
      }
      const { response, attempts, failedAttemptsMs, discardedUsage } = outcome;

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

      const usage = addUsage(this.usageFromCompletion(response), discardedUsage);
      const provenance = {
        ...this.provenanceFromCompletion(response, model, reasoningEffort),
        attempts,
        failedAttemptsMs,
      };
      const reasoning = reasoningFromCarrier(
        choice.message,
        usage,
        provenance.actualModel || model,
        this.logger,
      );

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

        const carrier = choice.message as { reasoning?: unknown; reasoning_details?: unknown };
        const reasoningBlocks = openRouterReasoningBlocks(
          carrier.reasoning_details,
          typeof carrier.reasoning === 'string' ? carrier.reasoning : '',
          model,
        );
        return {
          type: 'tool_use',
          toolCalls: mappedToolCalls,
          // Preserve text content alongside tool calls if present.
          content: choice.message.content ?? undefined,
          ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
          usage,
          provenance,
          ...reasoning,
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
        ...reasoning,
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
      const { createParams, signal, reasoningEffort } = built;
      yield { type: 'request_started', maxTokens: createParams.max_tokens as number };
      const streamParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        ...createParams,
        stream: true,
        stream_options: { include_usage: true },
      };
      // No SDK retries (#2371): a retry inside the SDK is invisible to llm.call's
      // attempt count. A failed watched call falls back to chat(), which retries
      // and counts each attempt; voice fails the turn fast rather than hanging.
      const stream = await this.client.chat.completions.create(streamParams, {
        maxRetries: 0,
        ...(signal ? { signal } : {}),
      });
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
      let upstreamProvider: string | undefined;
      let seenChunk = false;
      let finishReason: string | null = null;
      const toolCallDeltas = new Map<number, PendingToolCall>();
      let outputStarted = false;
      let reasoningDirect = '';
      const reasoningState = emptyReasoningState();
      // The raw details, rebuilt for pass-back; reasoningState only holds readable text.
      const reasoningDetails: Array<Record<string, unknown>> = [];

      for await (const chunk of stream) {
        seenChunk = true;
        providerRequestId = chunk.id || providerRequestId;
        actualModel = chunk.model || actualModel;
        upstreamProvider = upstreamProviderFrom(chunk) ?? upstreamProvider;

        if (chunk.usage) {
          usage = usageFromOpenRouter(chunk.usage);
        }

        for (const choice of chunk.choices) {
          finishReason = choice.finish_reason ?? finishReason;
          const textDelta = choice.delta.content;
          if (textDelta) {
            content += textDelta;
            yield { type: 'text_delta', text: textDelta };
          }

          const delta = choice.delta as { reasoning?: unknown; reasoning_details?: unknown };
          if (typeof delta.reasoning === 'string') reasoningDirect += delta.reasoning;
          // One reasoning_delta per chunk: a non-empty delta.reasoning wins; the
          // details text is used when it is absent or empty.
          const reasoningText = typeof delta.reasoning === 'string' && delta.reasoning !== ''
            ? delta.reasoning
            : readableReasoningDetailsText(delta.reasoning_details);
          if (reasoningText) yield { type: 'reasoning_delta', text: reasoningText };
          absorbReasoningDetails(reasoningState, delta.reasoning_details);
          mergeReasoningDetailDeltas(reasoningDetails, delta.reasoning_details);

          const toolCallChunks = choice.delta.tool_calls ?? [];
          if (toolCallChunks.length > 0 && !outputStarted) {
            // Tool-call arguments yield no delta event; tell watchers output has begun.
            outputStarted = true;
            yield { type: 'output_started' };
          }
          for (const toolCallDelta of toolCallChunks) {
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
        ...(upstreamProvider !== undefined ? { upstreamProvider } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        // One request, never retried here (SDK retries are off above), so the
        // #1915 attempt telemetry reads the same as a first-try chat().
        attempts: 1,
        failedAttemptsMs: 0,
      };
      const reasoning = reasoningFieldsFromParts(
        reasoningDirect,
        reasoningState,
        usage,
        actualModel || model,
        this.logger,
      );
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
        const reasoningBlocks = openRouterReasoningBlocks(reasoningDetails, reasoningDirect, model);
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
        ...reasoning,
      };
    } catch (err) {
      if (isCallerCancellation(params.options)) {
        // A barge-in or hang-up, not a failure (#1968); see anthropic.ts.
        this.logger.debug({ model }, 'OpenRouter stream cancelled by caller');
      } else {
        this.logger.error({ err, model }, 'OpenRouter streaming API call failed');
      }
      yield { type: 'error', error: this.classifyProviderError(err) };
    } finally {
      // Best-effort cleanup; never let an abort() failure mask the real result or error.
      if (abortStream) {
        try {
          abortStream();
        } catch (abortErr) {
          // Best-effort cleanup, logged at warn (not error): the request result was already
          // handled above and is unaffected — this is stream hygiene, not a request failure.
          // It only fires if abort() itself fails (never on the happy path), so a recurring
          // warn here is the signal that the stream leak (#1648/#1651) has returned.
          this.logger.warn({ abortErr, model }, 'OpenRouter stream cleanup abort() failed');
        }
      }
    }
  }
}
