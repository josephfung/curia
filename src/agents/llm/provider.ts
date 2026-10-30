// provider.ts — the abstraction boundary between agents and LLM backends.
//
// All agent code talks to LLMProvider only. Provider-specific behaviour
// (Anthropic's system-param requirement, OpenAI's tool_choice shape, etc.)
// lives inside each concrete implementation — never here, never in the agent.
//
// Adding a new provider: implement LLMProvider, wire it in the DI layer.

import type { AgentError } from '../../errors/types.js';
import type { ReasoningEffort } from './sampling-options.js';
import type { ReasoningWatchdogRecord } from './reasoning-watchdog.js';

/**
 * Content block types for multi-turn tool-use conversations.
 * The Anthropic API requires assistant turns to contain tool_use blocks
 * and user turns to contain tool_result blocks — plain strings won't work.
 * These mirror the Anthropic SDK shapes but are provider-neutral.
 */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Image content block for vision calls (e.g. Anthropic's image input API).
 * Supports both base64-encoded data and URL references; individual providers
 * may only support a subset — pass only what the target model accepts.
 *
 * source is a discriminated union so TypeScript enforces that base64 sources
 * always include media_type and data, and URL sources always include url.
 * Mixing optional fields (the old shape) allowed impossible states at compile time.
 */
export interface ImageContent {
  type: 'image';
  source:
    | {
        type: 'base64';
        /** IANA media type (e.g. 'image/jpeg', 'image/png'). */
        media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
        /** Base64-encoded image data. */
        data: string;
      }
    | {
        type: 'url';
        /** Image URL. */
        url: string;
      };
}

/**
 * Reasoning a provider returned beside tool calls, carried back verbatim on the
 * next request of the same tool loop (ADR-048 §1). `data` is provider-native and
 * opaque: OpenRouter's `reasoning_details` (or bare `reasoning` string), or one
 * Anthropic `thinking` / `redacted_thinking` block. Never rebuilt from the
 * archive, which stores only a marker for it.
 */
export interface ReasoningContent {
  type: 'reasoning';
  provider: 'openrouter' | 'anthropic';
  /** Model the request named. A provider drops blocks from any other model. */
  model: string;
  data: unknown;
  /**
   * Anthropic only: hash of the request this block answered (system, tools and
   * every message, as sent). Set for models whose thinking is bound to the
   * request prefix, so a later request can tell when the block went stale.
   */
  prefixHash?: string;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ImageContent | ReasoningContent;

export interface Message {
  role: 'system' | 'user' | 'assistant';
  /** Plain string for simple messages, or an array of content blocks for tool-use turns */
  content: string | ContentBlock[];
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache on this call. 0 when not applicable. */
  cacheCreationInputTokens: number;
  /** Tokens served from the prompt cache on this call. 0 when not applicable. */
  cacheReadInputTokens: number;
  /**
   * Tokens spent on reasoning, when the provider reports them.
   * Already included in outputTokens — recorded so a call can be explained.
   */
  reasoningTokens?: number;
}

/**
 * Why readable reasoning was not stored, when usage reported reasoning tokens
 * and no readable text came back. `encrypted` means the provider returned only
 * sealed reasoning details. `empty` means the token count was non-zero and no
 * reasoning text arrived.
 */
export type ReasoningOmission = 'empty' | 'encrypted';

/** Reasoning carried on a successful response. Both fields are optional. */
export interface LLMReasoning {
  /** Plain-text reasoning the provider returned. Absent when none was readable. */
  reasoning?: string;
  reasoningOmitted?: ReasoningOmission;
}

/**
 * Provider-level metadata returned alongside every successful LLM response.
 * Only available on successful calls — error responses carry no API body to extract these from.
 */
export interface LLMCallProvenance {
  /** Model string passed to the provider (what the caller requested). */
  requestedModel: string;
  /** Model that actually ran, from the API response body (may differ if provider aliases). */
  actualModel: string;
  /** Anthropic: response.id (msg_xxx) — shown in Anthropic's console for support correlation. */
  providerRequestId: string;
  /**
   * OpenRouter only: the upstream endpoint that served the call (the response's
   * top-level `provider`). Reasoning differs by endpoint at the same effort, so
   * measurements are comparable only within one (ADR-048).
   */
  upstreamProvider?: string;
  /**
   * The reasoning effort the request actually carried, after the provider
   * checked it against the model (ADR-048 §5). Absent when it sent none.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Passed-back reasoning blocks the provider dropped from this request because
   * the request prefix changed since they were written (ADR-048 §1, prefix
   * guard). Absent when it dropped none.
   */
  reasoningBlocksDropped?: number;
  /**
   * OpenRouter only: requests sent for this call, counting retries (always 1 on
   * stream(), which does not retry). Absent where the provider does not count them (#1915).
   */
  attempts?: number;
  /**
   * OpenRouter only: time spent on failed attempts and the backoff after
   * each, so `latencyMs - failedAttemptsMs` is the attempt that succeeded (#1915).
   */
  failedAttemptsMs?: number;
  /**
   * Set when the reasoning watchdog stopped the streamed attempt and this
   * response came from the forced attempt (#2371). Absent otherwise.
   */
  reasoningWatchdog?: ReasoningWatchdogRecord;
}

// Import and re-export ToolDefinition from the canonical location in skills/types.ts
// so consumers can import all LLM-related types from one place.
import type { ToolDefinition } from '../../skills/types.js';
export type { ToolDefinition } from '../../skills/types.js';

/**
 * A single tool call requested by the LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result to feed back to the LLM after executing a tool call.
 */
export interface ToolResult {
  id: string;
  content: string;
  is_error?: boolean;
}

// Discriminated union — agents switch on response.type to decide what to do.
// 'error' is a first-class value (not a thrown exception) so callers can handle
// partial failures gracefully without try/catch boilerplate throughout the agent.
// Successful variants carry provenance — the runtime uses it to publish llm.call events.
// Error paths omit provenance: when the API fails there is no response body to extract from.
export type LLMResponse =
  | ({ type: 'text'; content: string; usage: LLMUsage; provenance: LLMCallProvenance } & LLMReasoning)
  | ({ type: 'tool_use'; toolCalls: ToolCall[]; content?: string; reasoningBlocks?: ReasoningContent[]; usage: LLMUsage; provenance: LLMCallProvenance } & LLMReasoning)
  | { type: 'error'; error: AgentError; usage?: LLMUsage };

export type LLMStreamEvent =
  /**
   * Emitted exactly once per stream() call, before any other event, carrying the
   * max_tokens the request actually sent (after the model cap and any thinking
   * floor). A watcher arms its thresholds from it.
   */
  | { type: 'request_started'; maxTokens: number }
  /**
   * Emitted at most once, on the first chunk of a tool call, so a watcher knows
   * output has begun even though tool-call arguments produce no delta event.
   * Text output signals itself through `text_delta`; a provider need not emit
   * this for text.
   */
  | { type: 'output_started' }
  | { type: 'text_delta'; text: string }
  /**
   * One per reasoning delta that carries non-empty readable text (never for
   * encrypted or omitted thinking). A watcher counts one token per event.
   */
  | { type: 'reasoning_delta'; text: string }
  | ({ type: 'tool_use'; toolCalls: ToolCall[]; content?: string; reasoningBlocks?: ReasoningContent[]; usage: LLMUsage; provenance: LLMCallProvenance } & LLMReasoning)
  | ({ type: 'message_end'; content: string; usage: LLMUsage; provenance: LLMCallProvenance } & LLMReasoning)
  | { type: 'error'; error: AgentError; usage?: LLMUsage };

export interface LLMProvider {
  // Human-readable identifier used in logs and metrics (e.g. 'anthropic', 'openai').
  id: string;

  /**
   * When `false`, the reasoning watchdog's forced attempt omits the quoted
   * reasoning: this provider's models refuse having their reasoning echoed back
   * (Anthropic's `reasoning_extraction` classifier on Sonnet 5.5, 2026-10-29
   * probe, #2371). Absent or `true` means the reasoning tail is included.
   */
  readonly acceptsReasoningInForcedAttempt?: boolean;

  // Send a conversation to the model and receive a structured response.
  // `options` is an escape hatch for provider-specific knobs (model name,
  // temperature, etc.) that don't belong in the common interface.
  // `tools` lists available tools the LLM may call; `toolResults` carries
  // results back to the LLM after the caller has executed a tool_use response.
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;

  /**
   * Stream a conversation turn. Optional — providers that cannot stream omit it.
   * Voice refuses to start when stream is unavailable. Never silently buffer the
   * full reply before first yield when the backend supports true streaming.
   * Emits `request_started` first (once), `reasoning_delta` per readable reasoning delta,
   * and `output_started` once on the first tool-call chunk.
   * Honor `options.signal` (AbortSignal) for cancellation (barge-in).
   * Like chat(), should not throw for API failures — yield `{ type: 'error' }` instead.
   * May throw only for programmer errors (e.g. missing model) before the iterable starts,
   * OR yield error events — prefer yielding error events for consistency with chat().
   */
  stream?(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): AsyncIterable<LLMStreamEvent>;
}
