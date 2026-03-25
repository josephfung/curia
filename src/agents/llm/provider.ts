// provider.ts — the abstraction boundary between agents and LLM backends.
//
// All agent code talks to LLMProvider only. Provider-specific behaviour
// (Anthropic's system-param requirement, OpenAI's tool_choice shape, etc.)
// lives inside each concrete implementation — never here, never in the agent.
//
// Adding a new provider: implement LLMProvider, wire it in the DI layer.

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
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
export type LLMResponse =
  | { type: 'text'; content: string; usage: LLMUsage }
  | { type: 'tool_use'; toolCalls: ToolCall[]; content?: string; usage: LLMUsage }
  | { type: 'error'; error: string; usage?: LLMUsage };

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
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;
}
