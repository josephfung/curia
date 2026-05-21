// provider-router.ts — model-aware LLMProvider that routes chat() calls to the
// correct concrete provider based on the model string in each request.
//
// This exists for consumers that resolve their model at call time (e.g. infra
// skills inside ExecutionLayer that call modelRouter.resolve() per invocation).
// Those consumers cannot pre-resolve a concrete provider at construction time
// because they don't yet know which model they'll use. Passing the router in
// place of a concrete LLMProvider lets them call provider.chat({ model }) and
// have the routing happen transparently.
//
// For consumers whose model IS known at construction time (WorkingMemory,
// DriftDetector, AutonomyScoringPass), prefer resolving the concrete provider
// directly in index.ts — the router's routing step is redundant there, and the
// concrete provider's id appears correctly in logs.
//
// Error contract: like all LLMProvider implementations, chat() never throws.
// Routing failures (missing model, unregistered provider) are returned as
// LLMResponse { type: 'error' } so callers never need try/catch. This is
// especially important for AgentRuntime, which calls chat() without a wrapper.

import type { LLMProvider, LLMResponse, Message, ToolDefinition, ToolResult } from './provider.js';
import type { ModelRegistry } from './model-registry.js';
import { classifyError } from '../../errors/classify.js';

export class LLMProviderRouter implements LLMProvider {
  readonly id = 'router';

  constructor(
    private readonly modelRegistry: ModelRegistry,
    private readonly providerRegistry: Map<string, LLMProvider>,
  ) {}

  async chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    // Support options.model fallback for backward compatibility with callers
    // that pass model inside options rather than as the top-level param.
    const model = params.model ?? (typeof params.options?.model === 'string' ? params.options.model : undefined);

    if (!model) {
      return {
        type: 'error',
        error: classifyError(
          new Error('LLMProviderRouter.chat() requires a model — no model was provided'),
          'router',
        ),
      };
    }

    const providerName = this.modelRegistry.getProvider(model);
    if (!providerName) {
      return {
        type: 'error',
        error: classifyError(
          new Error(`LLMProviderRouter: model '${model}' is not in the model registry — cannot route to a provider`),
          'router',
        ),
      };
    }

    const provider = this.providerRegistry.get(providerName);
    if (!provider) {
      return {
        type: 'error',
        error: classifyError(
          new Error(`LLMProviderRouter: provider '${providerName}' is not registered (required for model '${model}')`),
          'router',
        ),
      };
    }

    return provider.chat(params);
  }
}
