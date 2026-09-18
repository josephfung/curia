// src/agents/llm/model-registry.ts — single source of truth for model metadata.
//
// The TypeScript registry defines what models Curia officially supports (pricing,
// context windows, capabilities). Deployment-specific config (which tier maps to
// which model) stays in config/default.yaml.
//
// Lookup tries an exact key match first, then falls back to prefix matching:
// 'claude-haiku-4-5-20251001' matches 'claude-haiku-4-5'. Entries are pre-sorted
// by key length descending so longer prefixes win.
//
// A prefix hit means the requested model is borrowing another entry's pricing and
// limits, which is a guess — it is logged at warn, once per distinct model id, so
// an operator pointing a tier at a dated snapshot is told rather than silently
// billed against the wrong numbers (#1804).

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
  /**
   * Why `pricing.cacheReadPerMToken` is absent, when the provider publishes no
   * cache-read price for this model. Required on any `openrouter` entry without
   * one — see `model-registry.test.ts`. The reason makes an omission read as
   * "checked, none published" instead of "nobody looked" (#1804).
   */
  cacheReadPricingUnavailable?: string;
}

// Keyed by model name prefix. OpenRouter models added by #379.
//
// Each entry and its nested pricing/capabilities objects are frozen at module
// load time so getModel()/getAllModels() callers cannot mutate registry state.
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
    capabilities: ['vision', 'reasoning', 'coding', 'large_context', 'streaming', 'tools'],
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
    capabilities: ['vision', 'reasoning', 'coding', 'streaming', 'tools'],
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
    capabilities: ['vision', 'coding', 'streaming', 'tools'],
  },

  // OpenRouter models — non-Claude models routed via OpenRouter's OpenAI-compatible API.
  // Registry keys are the model IDs that OpenRouter's API expects.
  //
  // Prices are the published top-level rates from `GET /api/v1/models`, last
  // verified 2026-09-18. Per-provider endpoint rates differ from these — for
  // cache reads the spread reaches 10x on a single model — so an entry is only
  // as accurate as the endpoint OpenRouter actually routes to. An entry with no
  // `cacheReadPerMToken` must say why in `cacheReadPricingUnavailable`.
  'google/gemini-3.1-flash-lite': {
    provider: 'openrouter',
    contextWindow: 1_000_000,
    pricing: {
      inputPerMToken: 0.25,
      outputPerMToken: 1.50,
      cacheReadPerMToken: 0.025,
    },
    capabilities: ['vision', 'coding', 'streaming', 'tools'],
    maxOutputTokens: 8_192,
  },
  // Removed from OpenRouter ~2026-05-31. Entry retained for audit log provenance.
  'google/gemini-2.0-flash-001': {
    provider: 'openrouter',
    contextWindow: 1_000_000,
    pricing: {
      inputPerMToken: 0.10,
      outputPerMToken: 0.40,
    },
    capabilities: ['vision', 'coding', 'streaming', 'tools'],
    maxOutputTokens: 8_192,
    cacheReadPricingUnavailable: 'delisted from OpenRouter ~2026-05-31 — no current published price to record',
  },
  'deepseek/deepseek-chat-v3-0324': {
    provider: 'openrouter',
    contextWindow: 128_000,
    pricing: {
      inputPerMToken: 0.27,
      outputPerMToken: 1.10,
    },
    capabilities: ['coding', 'streaming', 'tools'],
    maxOutputTokens: 8_192,
    cacheReadPricingUnavailable: 'OpenRouter publishes no cache-read rate for this model (verified 2026-09-18)',
  },
  'deepseek/deepseek-v4-pro': {
    provider: 'openrouter',
    contextWindow: 1_048_576,
    // $0.435/$0.87 was a promotional rate that ended mid-August 2026; the entry
    // kept it for about a month, understating every `estimatedCostUsd` written
    // to `audit_log` by ~3.7x (#1804).
    pricing: {
      inputPerMToken: 1.60,
      outputPerMToken: 3.20,
      cacheReadPerMToken: 0.135,
    },
    capabilities: ['coding', 'reasoning', 'streaming', 'tools'],
    // 8_192 was too low — long-form writing tasks (e.g. import_to_google_doc with
    // a full essay body) exceeded it, producing truncated JSON tool call arguments.
    // DeepSeek V4 Pro on OpenRouter supports up to 64k output tokens (#934).
    maxOutputTokens: 32_768,
  },
  // Dated snapshot of V4 Pro. Registered in its own right so it resolves to its
  // own price rather than prefix-matching 'deepseek/deepseek-v4-pro' (#1804).
  //
  // Caveat: OpenRouter publishes weekday peak-hour overrides for this model
  // (UTC 01:00-04:00 and 06:00-10:00 bill at 2x these rates). `ModelPricing`
  // holds one flat rate, so peak-window calls are costed at the off-peak price.
  'deepseek/deepseek-v4-pro-0813': {
    provider: 'openrouter',
    contextWindow: 1_048_576,
    pricing: {
      inputPerMToken: 0.66,
      outputPerMToken: 1.98,
      cacheReadPerMToken: 0.022,
    },
    capabilities: ['coding', 'reasoning', 'streaming', 'tools'],
    maxOutputTokens: 32_768,
  },
  // Candidate replacements for the `standard` tier (curia-deploy#226), added so
  // pointing a tier at one passes ModelRouter's registry check at boot.
  //
  // Same peak-hour caveat as the 0813 snapshot above: weekday UTC 01:00-04:00
  // and 06:00-10:00 bill at 2x the rates recorded here.
  'deepseek/deepseek-v4.1-flash': {
    provider: 'openrouter',
    contextWindow: 1_048_576,
    pricing: {
      inputPerMToken: 0.15,
      outputPerMToken: 0.60,
      cacheReadPerMToken: 0.003,
    },
    capabilities: ['vision', 'coding', 'reasoning', 'streaming', 'tools'],
    maxOutputTokens: 32_768,
  },
  'z-ai/glm-5.3-flash': {
    provider: 'openrouter',
    // The model publishes 1_310_720, but OpenRouter's top provider for it serves
    // 1_048_576. Budget against the smaller number so requests sized from this
    // value are not rejected by the endpoint that actually handles them.
    contextWindow: 1_048_576,
    pricing: {
      inputPerMToken: 0.09,
      outputPerMToken: 0.30,
      cacheReadPerMToken: 0.018,
    },
    capabilities: ['vision', 'coding', 'reasoning', 'streaming', 'tools'],
    maxOutputTokens: 32_768,
  },
  'qwen/qwen3.8-flash': {
    provider: 'openrouter',
    contextWindow: 1_000_000,
    pricing: {
      inputPerMToken: 0.15,
      outputPerMToken: 0.47,
      cacheCreationPerMToken: 0.20,
      cacheReadPerMToken: 0.016,
    },
    capabilities: ['vision', 'coding', 'reasoning', 'streaming', 'tools'],
    maxOutputTokens: 32_768,
  },
  'openai/gpt-4o': {
    provider: 'openrouter',
    contextWindow: 128_000,
    pricing: {
      inputPerMToken: 2.50,
      outputPerMToken: 10.00,
      cacheReadPerMToken: 1.25,
    },
    capabilities: ['vision', 'coding', 'reasoning', 'streaming', 'tools'],
    maxOutputTokens: 16_384,
  },

  // OpenAI embedding model — used by EmbeddingService for semantic search and entity resolution.
  // inputPerMToken matches current OpenAI pricing for text-embedding-3-small.
  // outputPerMToken is 0: embeddings produce no billed output tokens.
  // No streaming/tools — embeddings are not chat models (#1553).
  'text-embedding-3-small': {
    provider: 'openai',
    contextWindow: 8191,
    pricing: {
      inputPerMToken: 0.02,
      outputPerMToken: 0,
    },
    capabilities: ['embedding'],
  },
};
// Deep-freeze to prevent callers from mutating registry entries.
for (const entry of Object.values(MODEL_REGISTRY)) {
  Object.freeze(entry.pricing);
  Object.freeze(entry.capabilities);
  Object.freeze(entry);
}
Object.freeze(MODEL_REGISTRY);

// Exact-match index. A Map, not the record itself: an index read on a plain
// object hits Object.prototype, so getModel('constructor') would "find" a
// function and hand it back as ModelMetadata.
const EXACT_ENTRIES = new Map(Object.entries(MODEL_REGISTRY));

// Pre-sorted entries for prefix matching — longest prefix wins.
const SORTED_ENTRIES = Object.entries(MODEL_REGISTRY)
  .sort(([a], [b]) => b.length - a.length);

/**
 * Provides typed lookups against the static model registry.
 *
 * Lookups try an exact key match first, then fall back to prefix matching:
 * 'claude-haiku-4-5-20251001' resolves to the 'claude-haiku-4-5' entry. Entries
 * are sorted by key length descending so longer prefixes take priority.
 */
export class ModelRegistry {
  // Logger is used for debug/warn calls (e.g. unknown model warnings).
  private readonly logger: Logger;

  // Model ids already warned about for resolving by prefix. getModel() runs on
  // every LLM call via getPricing/getProvider, so warning each time would emit
  // several lines per call for a model id that is only ever wrong once.
  private readonly warnedPrefixMatches = new Set<string>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Look up full metadata for a model. Returns undefined if nothing matches.
   *
   * An exact key wins. Failing that, the longest registered prefix of `modelId`
   * matches and the hit is logged at warn — the returned pricing, context window
   * and output cap belong to a different model, which is a guess the operator
   * should get to overrule (#1804). The warning fires once per distinct model id
   * per instance.
   */
  getModel(modelId: string): ModelMetadata | undefined {
    const exact = EXACT_ENTRIES.get(modelId);
    if (exact) {
      return exact;
    }

    const entry = SORTED_ENTRIES.find(([prefix]) => modelId.startsWith(prefix));
    if (!entry) {
      this.logger.debug({ modelId }, 'ModelRegistry: model not found in registry');
      return undefined;
    }

    if (!this.warnedPrefixMatches.has(modelId)) {
      this.warnedPrefixMatches.add(modelId);
      this.logger.warn(
        { modelId, matchedEntry: entry[0] },
        `ModelRegistry: "${modelId}" is not a registry key — resolved by prefix to "${entry[0]}" and will be priced and sized as that model. Add its own entry if the metadata differs.`,
      );
    }
    return entry[1];
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
