// provider.ts — the abstraction boundary between agents and LLM backends.
//
// All agent code talks to LLMProvider only. Provider-specific behaviour
// (Anthropic's system-param requirement, OpenAI's tool_choice shape, etc.)
// lives inside each concrete implementation — never here, never in the agent.
//
// Adding a new provider: implement LLMProvider, wire it in the DI layer.

import type { AgentError } from '../../errors/types.js';

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

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ImageContent;

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
  | { type: 'text'; content: string; usage: LLMUsage; provenance: LLMCallProvenance }
  | { type: 'tool_use'; toolCalls: ToolCall[]; content?: string; usage: LLMUsage; provenance: LLMCallProvenance }
  | { type: 'error'; error: AgentError; usage?: LLMUsage };

export interface LLMProvider {
  // Human-readable identifier used in logs and metrics (e.g. 'anthropic', 'openai').
  id: string;

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
}
