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

// Discriminated union — agents switch on response.type to decide what to do.
// 'error' is a first-class value (not a thrown exception) so callers can handle
// partial failures gracefully without try/catch boilerplate throughout the agent.
export type LLMResponse =
  | { type: 'text'; content: string; usage: LLMUsage }
  | { type: 'error'; error: string; usage?: LLMUsage };

export interface LLMProvider {
  // Human-readable identifier used in logs and metrics (e.g. 'anthropic', 'openai').
  id: string;

  // Send a conversation to the model and receive a structured response.
  // `options` is an escape hatch for provider-specific knobs (model name,
  // temperature, etc.) that don't belong in the common interface.
  chat(params: {
    messages: Message[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;
}
