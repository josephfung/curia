// src/agents/llm/model-registry.ts — single source of truth for model metadata.
//
// The TypeScript registry defines what models Curia officially supports (pricing,
// context windows, capabilities). Deployment-specific config (which tier maps to
// which model) stays in config/default.yaml.
//
// Lookup uses prefix matching: 'claude-haiku-4-5-20251001' matches 'claude-haiku-4-5'.
// Entries are pre-sorted by key length descending so longer prefixes win.

import type { Logger } from '../../logger.js';

export interface ModelPricing {
  /** USD per million input tokens */
  inputPerMToken: number;
  /** USD per million output tokens */
  outputPerMToken: number;
  /** USD per million cache-creation tokens. undefined = model doesn't support caching. */
  cacheCreationPerMToken?: number;
  /** USD per million cache-read tokens. undefined = model doesn't support caching. */
  cacheReadPerMToken?: number;
}

export interface ModelMetadata {
  /** Provider identifier ('anthropic', 'openrouter', etc.) */
  provider: string;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Token pricing rates */
  pricing: ModelPricing;
  /** Model capabilities per ADR-014 vocabulary */
  capabilities: string[];
  /** Maximum output tokens per call. Default 4096 if unset. */
  maxOutputTokens?: number;
}

// Keyed by model name prefix. When #379 lands, OpenRouter models are added here
// with provider: 'openrouter'.
const MODEL_REGISTRY: Record<string, ModelMetadata> = {
  'claude-opus-4-6': {
    provider: 'anthropic',
    contextWindow: 200_000,
    pricing: {
      inputPerMToken: 15.00,
      outputPerMToken: 75.00,
      cacheCreationPerMToken: 18.75,
      cacheReadPerMToken: 1.50,
    },
    capabilities: ['vision', 'reasoning', 'coding', 'large_context'],
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    contextWindow: 200_000,
    pricing: {
      inputPerMToken: 3.00,
      outputPerMToken: 15.00,
      cacheCreationPerMToken: 3.75,
      cacheReadPerMToken: 0.30,
    },
    capabilities: ['vision', 'reasoning', 'coding'],
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    contextWindow: 200_000,
    pricing: {
      inputPerMToken: 0.80,
      outputPerMToken: 4.00,
      cacheCreationPerMToken: 1.00,
      cacheReadPerMToken: 0.08,
    },
    capabilities: ['vision', 'coding'],
  },
};

// Pre-sorted entries for prefix matching — longest prefix wins.
const SORTED_ENTRIES = Object.entries(MODEL_REGISTRY)
  .sort(([a], [b]) => b.length - a.length);

/**
 * Provides typed lookups against the static model registry.
 *
 * All lookups use prefix matching: 'claude-haiku-4-5-20251001' resolves to
 * the 'claude-haiku-4-5' entry. Entries are sorted by key length descending
 * so longer prefixes take priority.
 */
export class ModelRegistry {
  // Logger is used for debug/warn calls (e.g. unknown model warnings).
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Look up full metadata for a model. Returns undefined if no prefix matches. */
  getModel(modelId: string): ModelMetadata | undefined {
    const entry = SORTED_ENTRIES.find(([prefix]) => modelId.startsWith(prefix));
    if (!entry) {
      this.logger.debug({ modelId }, 'ModelRegistry: model not found in registry');
    }
    return entry ? entry[1] : undefined;
  }

  /** Returns context window size in tokens. Returns undefined for unknown models. */
  getContextWindow(modelId: string): number | undefined {
    return this.getModel(modelId)?.contextWindow;
  }

  /** Returns pricing for the model. Returns undefined for unknown models. */
  getPricing(modelId: string): ModelPricing | undefined {
    return this.getModel(modelId)?.pricing;
  }

  /** Returns the provider identifier for a model. Returns undefined for unknown models. */
  getProvider(modelId: string): string | undefined {
    return this.getModel(modelId)?.provider;
  }

  /** Returns true if the model is in the registry (prefix match). */
  isKnownModel(modelId: string): boolean {
    return this.getModel(modelId) !== undefined;
  }

  /** Returns all registered models. Used for startup validation only. */
  getAllModels(): Readonly<Record<string, ModelMetadata>> {
    return MODEL_REGISTRY;
  }
}
