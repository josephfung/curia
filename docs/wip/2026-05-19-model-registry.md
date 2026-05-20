# Model Registry Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate scattered model metadata (pricing, context windows, capabilities) into a single TypeScript registry, and migrate all consumers to use it.

**Architecture:** A new `ModelRegistry` class in `src/agents/llm/model-registry.ts` becomes the single source of truth. `pricing.ts` and `token-estimator.ts` shed their model-specific data. `ModelRouter` drops its redundant `provider` field and validates tiers against the registry. Three infrastructure skill handlers are migrated from raw Anthropic SDK clients to the shared `LLMProvider` via SkillContext capabilities.

**Tech Stack:** TypeScript, Vitest, YAML config

**Spec:** `docs/wip/2026-05-19-model-registry-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/agents/llm/model-registry.ts` | ModelMetadata types, MODEL_REGISTRY data, ModelRegistry class |
| `src/agents/llm/model-registry.test.ts` | Unit tests for ModelRegistry |

### Modified files
| File | What changes |
|------|-------------|
| `src/agents/llm/pricing.ts` | Delete ANTHROPIC_PRICING; estimateCostUsd delegates to registry |
| `src/agents/llm/pricing.test.ts` | Update to inject registry |
| `src/agents/llm/token-estimator.ts` | Delete CONTEXT_WINDOWS, getContextWindow, isKnownContextWindowModel, DEFAULT_MODEL_NAME |
| `src/agents/llm/model-router.ts` | TierConfig drops provider; constructor accepts ModelRegistry; ResolvedModel drops provider |
| `src/agents/llm/model-router.test.ts` | Update config shape and assertions |
| `src/agents/llm/anthropic.ts` | Remove hardcoded model fallback; accept ModelRegistry for maxOutputTokens |
| `src/agents/runtime.ts` | Use registry for context window + cost; resolve provider via registry |
| `src/index.ts` | New startup wiring: registry → router → provider registry → validation |
| `src/config.ts` | TierConfig without provider; autonomy_scoring.model_tier replacing .model |
| `config/default.yaml` | Simplify tier config (drop provider); change autonomy_scoring.model to .model_tier |
| `src/skills/types.ts` | Add llmProvider and modelRouter to SkillContext |
| `src/skills/loader.ts` | Add llmProvider and modelRouter to VALID_CAPABILITIES |
| `src/skills/execution.ts` | Inject llmProvider and modelRouter for capable skills |
| `skills/extract-facts/handler.ts` | Use ctx.llmProvider + ctx.modelRouter instead of raw SDK |
| `skills/extract-facts/skill.json` | Add capabilities |
| `skills/extract-relationships/handler.ts` | Same migration |
| `skills/extract-relationships/skill.json` | Add capabilities |
| `skills/file-parse/handler.ts` | Same migration |
| `skills/file-parse/skill.json` | Add capabilities |
| `src/autonomy/scoring-pass.ts` | Accept model_tier instead of model string |
| `src/memory/working-memory.ts` | Add model to SummarizationConfig; pass to provider.chat |
| `src/scheduler/drift-detector.ts` | Accept model string; pass to provider.chat |

---

## Task 1: Create ModelRegistry module with tests (TDD)

**Files:**
- Create: `src/agents/llm/model-registry.ts`
- Create: `src/agents/llm/model-registry.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/agents/llm/model-registry.test.ts
import { describe, it, expect } from 'vitest';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';

describe('ModelRegistry', () => {
  const registry = new ModelRegistry(createSilentLogger());

  describe('getModel', () => {
    it('returns metadata for an exact model name', () => {
      const meta = registry.getModel('claude-sonnet-4-6');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('anthropic');
      expect(meta!.contextWindow).toBe(200_000);
      expect(meta!.pricing.inputPerMToken).toBe(3.0);
    });

    it('matches versioned model names by prefix', () => {
      const meta = registry.getModel('claude-haiku-4-5-20251001');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('anthropic');
      expect(meta!.pricing.inputPerMToken).toBe(0.80);
    });

    it('returns undefined for unknown models', () => {
      expect(registry.getModel('unknown-model')).toBeUndefined();
    });

    it('prefers longer prefix matches', () => {
      // 'claude-sonnet-4-6' should not match 'claude-opus-4-6'
      const meta = registry.getModel('claude-sonnet-4-6-preview');
      expect(meta).toBeDefined();
      expect(meta!.pricing.inputPerMToken).toBe(3.0); // sonnet pricing, not opus
    });
  });

  describe('getContextWindow', () => {
    it('returns context window for a known model', () => {
      expect(registry.getContextWindow('claude-opus-4-6')).toBe(200_000);
    });

    it('returns context window for a versioned model name', () => {
      expect(registry.getContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    });

    it('returns 0 for unknown models', () => {
      expect(registry.getContextWindow('unknown-model')).toBe(0);
    });
  });

  describe('getPricing', () => {
    it('returns pricing for a known model', () => {
      const pricing = registry.getPricing('claude-haiku-4-5');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.80);
      expect(pricing!.outputPerMToken).toBe(4.00);
      expect(pricing!.cacheCreationPerMToken).toBe(1.00);
      expect(pricing!.cacheReadPerMToken).toBe(0.08);
    });

    it('returns undefined for unknown models', () => {
      expect(registry.getPricing('unknown-model')).toBeUndefined();
    });
  });

  describe('getProvider', () => {
    it('returns provider for a known model', () => {
      expect(registry.getProvider('claude-sonnet-4-6')).toBe('anthropic');
    });

    it('returns undefined for unknown models', () => {
      expect(registry.getProvider('unknown-model')).toBeUndefined();
    });
  });

  describe('isKnownModel', () => {
    it('returns true for exact match', () => {
      expect(registry.isKnownModel('claude-sonnet-4-6')).toBe(true);
    });

    it('returns true for prefix match', () => {
      expect(registry.isKnownModel('claude-haiku-4-5-20251001')).toBe(true);
    });

    it('returns false for unknown models', () => {
      expect(registry.isKnownModel('unknown-model')).toBe(false);
    });
  });

  describe('all three Anthropic models are registered', () => {
    it.each([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ])('%s is registered with provider, pricing, contextWindow, and capabilities', (model) => {
      const meta = registry.getModel(model);
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('anthropic');
      expect(meta!.contextWindow).toBeGreaterThan(0);
      expect(meta!.pricing.inputPerMToken).toBeGreaterThan(0);
      expect(meta!.pricing.outputPerMToken).toBeGreaterThan(0);
      expect(meta!.capabilities).toContain('vision');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/model-registry.test.ts`
Expected: FAIL — `model-registry.js` does not exist yet.

- [ ] **Step 3: Write the ModelRegistry module**

```typescript
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
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Look up full metadata for a model. Returns undefined if no prefix matches. */
  getModel(modelId: string): ModelMetadata | undefined {
    const entry = SORTED_ENTRIES.find(([prefix]) => modelId.startsWith(prefix));
    return entry ? entry[1] : undefined;
  }

  /** Returns context window size in tokens. Returns 0 for unknown models. */
  getContextWindow(modelId: string): number {
    return this.getModel(modelId)?.contextWindow ?? 0;
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/model-registry.test.ts`
Expected: All 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/model-registry.ts src/agents/llm/model-registry.test.ts
git -C /path/to/worktree commit -m "feat: add ModelRegistry with types, data, and prefix-match lookups"
```

---

## Task 2: Update ModelRouter — drop provider from TierConfig

**Files:**
- Modify: `src/agents/llm/model-router.ts`
- Modify: `src/agents/llm/model-router.test.ts`

- [ ] **Step 1: Update the test file first**

Replace the full contents of `src/agents/llm/model-router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ModelRouter, type ModelRoutingConfig } from './model-router.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';

const logger = createSilentLogger();
const registry = new ModelRegistry(logger);

const defaultConfig: ModelRoutingConfig = {
  tiers: {
    fast: { model: 'claude-haiku-4-5' },
    standard: { model: 'claude-sonnet-4-6' },
    powerful: { model: 'claude-opus-4-6' },
  },
  default_tier: 'standard',
};

describe('ModelRouter', () => {
  it('resolves fast tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('fast');
    expect(result).toEqual({ model: 'claude-haiku-4-5', tier: 'fast' });
  });

  it('resolves standard tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('standard');
    expect(result).toEqual({ model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('resolves powerful tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('powerful');
    expect(result).toEqual({ model: 'claude-opus-4-6', tier: 'powerful' });
  });

  it('throws on unknown tier', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    expect(() => router.resolve('ultra')).toThrow('Unknown model tier');
  });

  it('passes needs through without validation', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('standard', ['vision', 'large_context']);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to default_tier when tier is omitted', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve(undefined);
    expect(result).toEqual({ model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('throws at construction if a tier config is missing', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        // @ts-expect-error — intentionally omitting powerful to test validation
        powerful: undefined,
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, registry, logger)).toThrow('model_routing.tiers.powerful');
  });

  it('throws at construction if a tier has empty model', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: '' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, registry, logger)).toThrow('model_routing.tiers.standard');
  });

  it('throws at construction if a tier references an unknown model', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'unknown-model-xyz' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, registry, logger)).toThrow('not found in the model registry');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/model-router.test.ts`
Expected: FAIL — ModelRouter constructor signature changed, ResolvedModel shape changed.

- [ ] **Step 3: Update model-router.ts**

Replace the full contents of `src/agents/llm/model-router.ts`:

```typescript
// model-router.ts — resolves capability tiers to concrete models.
//
// Agents declare a tier (fast | standard | powerful) in their YAML config.
// The operator maps tiers to models in config/default.yaml. This class
// performs the lookup at startup so the runtime knows which model to use.
// The provider is resolved from the model registry — not declared per-tier.
//
// Capability needs (vision, large_context, etc.) are accepted but not
// validated in this version — they are documentary-only, logged at debug
// level for observability. Validation deferred to #379.

import type { Logger } from '../../logger.js';
import type { ModelRegistry } from './model-registry.js';

export type Tier = 'fast' | 'standard' | 'powerful';

export interface TierConfig {
  model: string;
}

export interface ModelRoutingConfig {
  tiers: Record<Tier, TierConfig>;
  default_tier: Tier;
}

export interface ResolvedModel {
  model: string;
  tier: Tier;
}

const VALID_TIERS: ReadonlySet<string> = new Set<string>(['fast', 'standard', 'powerful']);

export class ModelRouter {
  private readonly config: ModelRoutingConfig;
  private readonly logger: Logger;

  constructor(config: ModelRoutingConfig, registry: ModelRegistry, logger: Logger) {
    // Eagerly validate all tier configs at construction time so misconfigurations
    // are caught at startup, not when a specific tier is first resolved.
    for (const tier of ['fast', 'standard', 'powerful'] as const) {
      const tc = config.tiers[tier];
      if (!tc || !tc.model) {
        throw new Error(
          `model_routing.tiers.${tier} must have a non-empty "model" field`,
        );
      }
      // Validate that the model exists in the registry — fail-fast on unknown models.
      if (!registry.isKnownModel(tc.model)) {
        throw new Error(
          `model_routing.tiers.${tier}: model "${tc.model}" not found in the model registry`,
        );
      }
    }
    if (!VALID_TIERS.has(config.default_tier)) {
      throw new Error(
        `model_routing.default_tier must be one of ${[...VALID_TIERS].join(', ')}, got: "${config.default_tier}"`,
      );
    }
    this.config = config;
    this.logger = logger;
  }

  /**
   * Resolve a tier (and optional needs) to a concrete model.
   *
   * Falls back to `default_tier` from config when tier is omitted.
   * Throws if the resolved tier is unknown.
   * `needs` is accepted but not validated; logged at debug level.
   */
  resolve(tier?: string, needs?: string[]): ResolvedModel {
    const effectiveTier = tier ?? this.config.default_tier;
    if (!VALID_TIERS.has(effectiveTier)) {
      throw new Error(`Unknown model tier "${effectiveTier}". Valid tiers: ${[...VALID_TIERS].join(', ')}`);
    }

    const tierConfig = this.config.tiers[effectiveTier as Tier];

    if (needs && needs.length > 0) {
      // TODO: validate that the resolved model supports the declared needs
      // when capability validation is implemented (#379).
      this.logger.debug({ tier: effectiveTier, needs, model: tierConfig.model }, 'Model tier resolved (needs not validated)');
    } else {
      this.logger.debug({ tier: effectiveTier, model: tierConfig.model }, 'Model tier resolved');
    }

    return {
      model: tierConfig.model,
      tier: effectiveTier as Tier,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/model-router.test.ts`
Expected: All 9 tests PASS (the old "non-anthropic provider" test is replaced by "unknown model" test).

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/model-router.ts src/agents/llm/model-router.test.ts
git -C /path/to/worktree commit -m "feat: ModelRouter drops provider from TierConfig, validates models against registry"
```

---

## Task 3: Migrate pricing.ts to use ModelRegistry

**Files:**
- Modify: `src/agents/llm/pricing.ts`
- Modify: `src/agents/llm/pricing.test.ts`

- [ ] **Step 1: Update pricing.test.ts to inject registry**

Replace the full contents of `src/agents/llm/pricing.test.ts`:

```typescript
// pricing.test.ts — unit tests for estimateCostUsd.
//
// Verifies correct pricing for each supported model, prefix-match for versioned
// model names, and the unknown-model fallback to sonnet pricing.

import { describe, it, expect, vi } from 'vitest';
import { createEstimateCostUsd } from './pricing.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';
import type { LLMUsage } from './provider.js';

const registry = new ModelRegistry(createSilentLogger());
const estimateCostUsd = createEstimateCostUsd(registry);

// A usage object with known token counts for easy manual cost verification.
const makeUsage = (overrides: Partial<LLMUsage> = {}): LLMUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  ...overrides,
});

describe('estimateCostUsd', () => {
  it('calculates cost correctly for claude-sonnet-4-6', () => {
    // 1000 input @ $3/MTok + 500 output @ $15/MTok + 200 cache-create @ $3.75/MTok + 100 cache-read @ $0.30/MTok
    // = 0.003 + 0.0075 + 0.00075 + 0.00003 = 0.01128
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const cost = estimateCostUsd('claude-sonnet-4-6', usage);
    expect(cost).toBeCloseTo(0.01128, 8);
  });

  it('calculates cost correctly for claude-opus-4-6', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const cost = estimateCostUsd('claude-opus-4-6', usage);
    expect(cost).toBeCloseTo(0.0564, 8);
  });

  it('calculates cost correctly for claude-haiku-4-5', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const cost = estimateCostUsd('claude-haiku-4-5', usage);
    expect(cost).toBeCloseTo(0.003008, 8);
  });

  it('matches haiku pricing by prefix for versioned model names', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const versionedCost = estimateCostUsd('claude-haiku-4-5-20251001', usage);
    const baseCost = estimateCostUsd('claude-haiku-4-5', usage);
    expect(versionedCost).toBe(baseCost);
  });

  it('falls back to sonnet pricing for unrecognised models without crashing', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const fallbackCost = estimateCostUsd('unknown-model-xyz', usage);
    const sonnetCost = estimateCostUsd('claude-sonnet-4-6', usage);
    expect(fallbackCost).toBe(sonnetCost);
  });

  it('logs a warning for unrecognised models', () => {
    const warnFn = vi.fn();
    const mockLogger = { warn: warnFn } as never;
    const usage = makeUsage({ inputTokens: 100 });
    estimateCostUsd('mystery-model', usage, mockLogger);
    expect(warnFn).toHaveBeenCalledOnce();
    expect(warnFn.mock.calls[0]![0]).toMatchObject({ actualModel: 'mystery-model', fallback: 'claude-sonnet-4-6' });
  });

  it('returns 0 when all token counts are 0', () => {
    const cost = estimateCostUsd('claude-sonnet-4-6', makeUsage());
    expect(cost).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/pricing.test.ts`
Expected: FAIL — `createEstimateCostUsd` does not exist.

- [ ] **Step 3: Rewrite pricing.ts**

Replace the full contents of `src/agents/llm/pricing.ts`:

```typescript
// pricing.ts — LLM call cost estimation backed by the model registry.
//
// createEstimateCostUsd() returns a closure pre-wired with a ModelRegistry
// instance. The closure's signature is the same as the old estimateCostUsd()
// so callers don't change.
//
// Unrecognised models fall back to the default tier's model pricing with a
// warn log — a silent zero would make cost dashboards misleading.

import type { Logger } from '../../logger.js';
import type { LLMUsage } from './provider.js';
import type { ModelRegistry, ModelPricing } from './model-registry.js';

const FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Creates an estimateCostUsd function backed by the given model registry.
 * Call once at startup; use the returned function for all cost estimation.
 */
export function createEstimateCostUsd(
  registry: ModelRegistry,
): (actualModel: string, usage: LLMUsage, logger?: Logger) => number {
  return (actualModel: string, usage: LLMUsage, logger?: Logger): number => {
    let pricing: ModelPricing | undefined = registry.getPricing(actualModel);

    if (!pricing) {
      logger?.warn({ actualModel, fallback: FALLBACK_MODEL }, 'Unrecognised model — using fallback pricing for cost estimate');
      pricing = registry.getPricing(FALLBACK_MODEL);
      if (!pricing) {
        // Registry doesn't even have the fallback — return 0 to avoid crashing.
        logger?.warn({ actualModel, fallback: FALLBACK_MODEL }, 'Fallback model also missing from registry — returning $0 cost');
        return 0;
      }
    }

    // Divide by 1_000_000 to convert from per-million-token rate to per-token rate.
    // Cache fields default to 0 when the model doesn't support caching.
    return (
      (usage.inputTokens * pricing.inputPerMToken +
       usage.outputTokens * pricing.outputPerMToken +
       usage.cacheCreationInputTokens * (pricing.cacheCreationPerMToken ?? 0) +
       usage.cacheReadInputTokens * (pricing.cacheReadPerMToken ?? 0)) /
      1_000_000
    );
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/pricing.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/pricing.ts src/agents/llm/pricing.test.ts
git -C /path/to/worktree commit -m "refactor: pricing.ts delegates to ModelRegistry via createEstimateCostUsd"
```

---

## Task 4: Migrate token-estimator.ts — remove model metadata

**Files:**
- Modify: `src/agents/llm/token-estimator.ts`

- [ ] **Step 1: Remove model-specific exports from token-estimator.ts**

Delete lines 80–116 (everything from the `-- Context window map --` comment through `DEFAULT_MODEL_NAME`). Keep `estimateTokens`, `estimateMessagesTokens`, and `DEFAULT_SAFETY_MARGIN`. The file should end with:

```typescript
/** Safety margin (5%) subtracted from the context window before budgeting. */
export const DEFAULT_SAFETY_MARGIN = 0.05;
```

Specifically remove: `CONTEXT_WINDOWS`, `SORTED_WINDOW_ENTRIES`, `FALLBACK_WINDOW_MODEL`, `getContextWindow()`, `isKnownContextWindowModel()`, and `DEFAULT_MODEL_NAME`.

- [ ] **Step 2: Run full test suite to see what breaks**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/ 2>&1 | tail -30`
Expected: model-registry and pricing tests pass; any tests importing `getContextWindow` or `DEFAULT_MODEL_NAME` from `token-estimator.js` will fail. These will be fixed in later tasks when updating runtime.ts and index.ts.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/token-estimator.ts
git -C /path/to/worktree commit -m "refactor: remove model metadata from token-estimator.ts (moved to ModelRegistry)"
```

---

## Task 5: Update config.ts and config/default.yaml

**Files:**
- Modify: `src/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Update the YAML config — remove provider from tiers, change autonomy_scoring.model to .model_tier**

In `config/default.yaml`, replace the `model_routing` section (lines 0–15) with:

```yaml
# Capability-tier model routing (ADR-014).
# Agents declare a tier (fast | standard | powerful) — this config maps each
# tier to a concrete model. The provider is resolved from the model registry.
# Change these values to upgrade all agents of a tier in one place.
model_routing:
  tiers:
    fast:
      model: claude-haiku-4-5
    standard:
      model: claude-sonnet-4-6
    powerful:
      model: claude-opus-4-6
  default_tier: standard
```

And in the `autonomy_scoring` section (~line 271–279), change:
```yaml
    model: "claude-haiku-4-5"     # cheaper model for the LLM judge
```
to:
```yaml
    model_tier: fast              # tier for the LLM judge (resolved via ModelRouter)
```

- [ ] **Step 2: Update the YamlConfig type in config.ts**

In `src/config.ts`, find the `model_routing` type (around line 242–249) and replace:

```typescript
  model_routing?: {
    tiers: {
      fast: { provider: string; model: string };
      standard: { provider: string; model: string };
      powerful: { provider: string; model: string };
    };
    default_tier: 'fast' | 'standard' | 'powerful';
  };
```

with:

```typescript
  model_routing?: {
    tiers: {
      fast: { model: string };
      standard: { model: string };
      powerful: { model: string };
    };
    default_tier: 'fast' | 'standard' | 'powerful';
  };
```

- [ ] **Step 3: Update autonomy_scoring validation in config.ts**

Find the validation block for `autonomy_scoring.model` (~line 559) and replace:

```typescript
      if (autonomyScoring.model !== undefined && (typeof autonomyScoring.model !== 'string' || autonomyScoring.model.trim().length === 0)) {
        throw new Error(`dreaming.autonomy_scoring.model must be a non-empty string, got: ${String(autonomyScoring.model)}`);
      }
```

with:

```typescript
      if (autonomyScoring.model_tier !== undefined && (typeof autonomyScoring.model_tier !== 'string' || autonomyScoring.model_tier.trim().length === 0)) {
        throw new Error(`dreaming.autonomy_scoring.model_tier must be a non-empty string, got: ${String(autonomyScoring.model_tier)}`);
      }
```

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add config/default.yaml src/config.ts
git -C /path/to/worktree commit -m "refactor: drop provider from tier config, rename autonomy_scoring.model to .model_tier"
```

---

## Task 6: Update index.ts — new startup wiring

**Files:**
- Modify: `src/index.ts`

This task updates the bootstrap orchestrator to use the new registry and updated types. Note: this task has multiple sub-changes across `index.ts`.

- [ ] **Step 1: Add ModelRegistry import and instantiation**

Near the top of `src/index.ts`, add the import:

```typescript
import { ModelRegistry } from './agents/llm/model-registry.js';
```

Then, right before the `modelRouter` construction (~line 277), add:

```typescript
  const modelRegistry = new ModelRegistry(logger);
```

- [ ] **Step 2: Update ModelRouter construction**

Change the ModelRouter construction (~line 282) from:

```typescript
  const modelRouter = new ModelRouter(modelRoutingConfig, logger);
```

to:

```typescript
  const modelRouter = new ModelRouter(modelRoutingConfig, modelRegistry, logger);
```

- [ ] **Step 3: Update provider registry to resolve from model registry**

The existing `providerRegistry` construction (~line 283) stays the same:

```typescript
  const providerRegistry = new Map<string, LLMProvider>([
    ['anthropic', llmProvider],
  ]);
```

But after it, add a validation step that ensures every provider referenced by registry models is available:

```typescript
  // Validate that every provider referenced by a model in the registry has
  // an entry in providerRegistry. Fail-fast if an operator adds a model
  // requiring a provider that isn't instantiated.
  for (const [modelId, meta] of Object.entries(modelRegistry.getAllModels())) {
    if (!providerRegistry.has(meta.provider)) {
      logger.warn(
        { model: modelId, provider: meta.provider },
        'Model in registry references a provider that is not registered — model will be unusable',
      );
    }
  }
```

This requires adding a `getAllModels()` method to `ModelRegistry`. Add it:

```typescript
  /** Returns all registered models. Used for startup validation only. */
  getAllModels(): Readonly<Record<string, ModelMetadata>> {
    return MODEL_REGISTRY;
  }
```

And add a test for it in `model-registry.test.ts`:

```typescript
  describe('getAllModels', () => {
    it('returns all registered models', () => {
      const all = registry.getAllModels();
      expect(Object.keys(all)).toContain('claude-sonnet-4-6');
      expect(Object.keys(all)).toContain('claude-haiku-4-5');
      expect(Object.keys(all)).toContain('claude-opus-4-6');
    });
  });
```

- [ ] **Step 4: Create estimateCostUsd closure**

Add the import at the top of `index.ts`:

```typescript
import { createEstimateCostUsd } from './agents/llm/pricing.js';
```

After the ModelRegistry is instantiated, create the cost function:

```typescript
  const estimateCostUsd = createEstimateCostUsd(modelRegistry);
```

Then pass `estimateCostUsd` to wherever `AgentRuntime` is constructed (or make it available in the scope where `publishLlmCallEvent` is defined in runtime.ts — this will be addressed in Task 7).

- [ ] **Step 5: Update working memory summarization config**

Change the working memory construction (~lines 291–298) to pass the resolved model:

```typescript
  const summarizationCfg = yamlConfig.workingMemory?.summarization;
  const summarizationModel = modelRouter.resolve('standard').model;
  const memory = WorkingMemory.createWithPostgres(pool, logger, summarizationCfg
    ? {
        threshold: summarizationCfg.threshold ?? 20,
        keepWindow: summarizationCfg.keepWindow ?? 10,
        provider: llmProvider,
        model: summarizationModel,
      }
    : undefined,
  );
```

- [ ] **Step 6: Update autonomy scoring config**

Change the scoring pass config (~line 952–954) from:

```typescript
  const scoringPassConfig: ScoringPassConfig = {
    intervalMs: yamlConfig.dreaming?.autonomy_scoring?.intervalMs ?? 86_400_000,
    model: yamlConfig.dreaming?.autonomy_scoring?.model ?? 'claude-haiku-4-5',
```

to:

```typescript
  const scoringModelTier = yamlConfig.dreaming?.autonomy_scoring?.model_tier ?? 'fast';
  const scoringModel = modelRouter.resolve(scoringModelTier).model;
  const scoringPassConfig: ScoringPassConfig = {
    intervalMs: yamlConfig.dreaming?.autonomy_scoring?.intervalMs ?? 86_400_000,
    model: scoringModel,
```

- [ ] **Step 7: Update agent bootstrap — resolve provider from registry**

Change the agent bootstrap loop (~lines 1115–1121) from:

```typescript
    const resolved = modelRouter.resolve(agentConfig.model.tier, agentConfig.model.needs);
    const agentProvider = providerRegistry.get(resolved.provider);
    if (!agentProvider) {
      logger.fatal({ provider: resolved.provider, agent: agentConfig.name, tier: resolved.tier },
        'No provider registered for tier-resolved provider name');
      process.exit(1);
    }
```

to:

```typescript
    const resolved = modelRouter.resolve(agentConfig.model.tier, agentConfig.model.needs);
    const resolvedProvider = modelRegistry.getProvider(resolved.model);
    if (!resolvedProvider) {
      logger.fatal({ model: resolved.model, agent: agentConfig.name, tier: resolved.tier },
        'Model not found in registry — cannot resolve provider');
      process.exit(1);
    }
    const agentProvider = providerRegistry.get(resolvedProvider);
    if (!agentProvider) {
      logger.fatal({ provider: resolvedProvider, agent: agentConfig.name, tier: resolved.tier },
        'No provider registered for model\'s provider');
      process.exit(1);
    }
```

- [ ] **Step 8: Remove old imports**

Remove any remaining imports of `getContextWindow`, `isKnownContextWindowModel`, `DEFAULT_MODEL_NAME` from `token-estimator.js`, and `estimateCostUsd` from `pricing.js` (replaced by `createEstimateCostUsd`).

- [ ] **Step 9: Commit**

```bash
git -C /path/to/worktree add src/index.ts src/agents/llm/model-registry.ts src/agents/llm/model-registry.test.ts
git -C /path/to/worktree commit -m "feat: wire ModelRegistry into startup — registry, router, provider validation"
```

---

## Task 7: Update runtime.ts — registry-backed lookups

**Files:**
- Modify: `src/agents/runtime.ts`

- [ ] **Step 1: Update context budget setup**

Find the context budget block (~lines 326–333). Change:

```typescript
    const modelName = this.config.resolvedModel ?? this.config.modelName ?? DEFAULT_MODEL_NAME;
    const contextWindow = getContextWindow(modelName);
    if (!isKnownContextWindowModel(modelName)) {
      logger.warn(
        { agentId, modelName, fallbackWindow: contextWindow },
        'Model not in context window map — using fallback; budget may be incorrect. Add this model to token-estimator.ts',
      );
    }
```

to:

```typescript
    const modelName = this.config.resolvedModel ?? this.config.modelName;
    if (!modelName) {
      throw new Error(`Agent ${agentId} has no resolvedModel or modelName — cannot create context budget`);
    }
    const contextWindow = this.config.modelRegistry.getContextWindow(modelName);
    if (!this.config.modelRegistry.isKnownModel(modelName)) {
      logger.warn(
        { agentId, modelName },
        'Model not in model registry — context budget will use 0 window. Add this model to model-registry.ts',
      );
    }
```

This requires `modelRegistry` on the `AgentRuntime` config. Add it to whatever config interface `AgentRuntime` uses (likely a `config` object passed to the constructor). The exact interface name will be visible in the file — add `modelRegistry: ModelRegistry` to it.

- [ ] **Step 2: Update estimateCostUsd usage**

The `estimateCostUsd` call on ~line 1038 currently imports the function directly. Change the runtime to accept it as a config parameter:

Add `estimateCostUsd: (actualModel: string, usage: LLMUsage, logger?: Logger) => number` to the config interface, and update the call from:

```typescript
          estimatedCostUsd: estimateCostUsd(response.provenance.actualModel, response.usage, logger),
```

to:

```typescript
          estimatedCostUsd: this.config.estimateCostUsd(response.provenance.actualModel, response.usage, logger),
```

- [ ] **Step 3: Remove old imports**

Remove imports of `getContextWindow`, `isKnownContextWindowModel`, `DEFAULT_MODEL_NAME` from `token-estimator.js`, and the direct import of `estimateCostUsd` from `pricing.js`.

Add import:

```typescript
import type { ModelRegistry } from './llm/model-registry.js';
```

- [ ] **Step 4: Update AgentRuntime construction in index.ts**

In `src/index.ts`, pass the new config to `AgentRuntime`:

```typescript
    const agent = new AgentRuntime({
      // ... existing fields ...
      modelRegistry,
      estimateCostUsd,
    });
```

- [ ] **Step 5: Run the full test suite**

Run: `npx --prefix /path/to/worktree vitest run 2>&1 | tail -40`
Expected: model-registry, pricing, and model-router tests pass. Some integration tests may need updates if they construct `AgentRuntime` directly.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/agents/runtime.ts src/index.ts
git -C /path/to/worktree commit -m "refactor: runtime.ts uses ModelRegistry for context window and cost estimation"
```

---

## Task 8: Update anthropic.ts — remove hardcoded fallback, use registry for maxOutputTokens

**Files:**
- Modify: `src/agents/llm/anthropic.ts`

- [ ] **Step 1: Accept ModelRegistry in constructor**

Add a `modelRegistry` parameter to `AnthropicProvider`'s constructor and store it as a private field:

```typescript
import type { ModelRegistry } from './model-registry.js';

// In the class:
  private readonly modelRegistry: ModelRegistry;

  constructor(apiKey: string, logger: Logger, modelRegistry: ModelRegistry) {
    // ... existing init ...
    this.modelRegistry = modelRegistry;
  }
```

- [ ] **Step 2: Remove the hardcoded model fallback**

Find ~line 108–109:

```typescript
    const optionsModel = typeof options?.model === 'string' ? options.model : undefined;
    const model = modelOverride ?? optionsModel ?? 'claude-sonnet-4-6';
```

Replace with:

```typescript
    const optionsModel = typeof options?.model === 'string' ? options.model : undefined;
    const model = modelOverride ?? optionsModel;
    if (!model) {
      throw new Error('AnthropicProvider.chat() requires a model — no model was provided and no default is configured');
    }
```

This is safe because the runtime always passes `model: this.config.resolvedModel` explicitly (~line 1053).

- [ ] **Step 3: Use registry for max_tokens**

Find the hardcoded `max_tokens: 4096` (~line 114) and replace with:

```typescript
        max_tokens: this.modelRegistry.getModel(model)?.maxOutputTokens ?? 4096,
```

- [ ] **Step 4: Update AnthropicProvider construction in index.ts**

Change:

```typescript
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger);
```

to:

```typescript
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger, modelRegistry);
```

Note: the `ModelRegistry` must be instantiated before `AnthropicProvider` in the startup sequence.

- [ ] **Step 5: Run tests**

Run: `npx --prefix /path/to/worktree vitest run src/agents/ 2>&1 | tail -30`
Expected: PASS. Any test that relied on the implicit default will now need to pass a model explicitly. Tests constructing `AnthropicProvider` will need to pass a `ModelRegistry` instance.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/anthropic.ts src/index.ts
git -C /path/to/worktree commit -m "refactor: AnthropicProvider uses registry for maxOutputTokens, removes hardcoded fallback"
```

---

## Task 9: Add llmProvider and modelRouter to SkillContext

**Files:**
- Modify: `src/skills/types.ts`
- Modify: `src/skills/loader.ts`
- Modify: `src/skills/execution.ts`

- [ ] **Step 1: Add capabilities to VALID_CAPABILITIES in loader.ts**

In `src/skills/loader.ts`, find the `VALID_CAPABILITIES` set (~line 27–32) and add `'llmProvider'` and `'modelRouter'`:

```typescript
export const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'bus', 'agentRegistry', 'outboundGateway', 'heldMessages',
  'schedulerService', 'entityMemory', 'nylasCalendarClient',
  'autonomyService', 'executiveProfileService', 'browserService', 'bullpenService', 'skillSearch',
  'actionLogRepo', 'executionLayer', 'confidencePipeline', 'tempFileStore',
  'llmProvider', 'modelRouter',
]);
```

- [ ] **Step 2: Add properties to SkillContext in types.ts**

In `src/skills/types.ts`, within the `SkillContext` interface, add after the existing capability-gated properties (before the closing `}`):

```typescript
  /** LLM provider — available to skills declaring 'llmProvider' in capabilities.
   *  Grants direct LLM access — use only for infrastructure skills (extract-facts,
   *  extract-relationships, file-parse). See #637 for planned redesign. */
  llmProvider?: import('../agents/llm/provider.js').LLMProvider;
  /** Model router — available to skills declaring 'modelRouter' in capabilities.
   *  Resolves tier names to model strings. See #637 for planned redesign. */
  modelRouter?: import('../agents/llm/model-router.js').ModelRouter;
```

- [ ] **Step 3: Wire injection in execution.ts**

In `src/skills/execution.ts`, find the `capabilityServices` map (~line 497). The `ExecutionLayer` class needs to receive `llmProvider` and `modelRouter` in its constructor. Add them as constructor parameters and add to the capability map:

```typescript
      llmProvider: this.llmProvider,
      modelRouter: this.modelRouter,
```

Also update the `ExecutionLayer` constructor to accept and store these:

```typescript
  private readonly llmProvider?: LLMProvider;
  private readonly modelRouter?: ModelRouter;
```

And in the constructor:

```typescript
  constructor(opts: {
    // ... existing opts ...
    llmProvider?: LLMProvider;
    modelRouter?: ModelRouter;
  }) {
    // ... existing assignments ...
    this.llmProvider = opts.llmProvider;
    this.modelRouter = opts.modelRouter;
  }
```

- [ ] **Step 4: Update ExecutionLayer construction in index.ts**

In `src/index.ts`, where the `ExecutionLayer` is constructed, pass the new dependencies:

```typescript
  const executionLayer = new ExecutionLayer({
    // ... existing params ...
    llmProvider,
    modelRouter,
  });
```

- [ ] **Step 5: Run tests**

Run: `npx --prefix /path/to/worktree vitest run src/skills/ 2>&1 | tail -30`
Expected: PASS. No existing skill declares these capabilities, so nothing breaks.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/skills/types.ts src/skills/loader.ts src/skills/execution.ts src/index.ts
git -C /path/to/worktree commit -m "feat: add llmProvider and modelRouter as SkillContext capabilities"
```

---

## Task 10: Migrate extract-facts handler

**Files:**
- Modify: `skills/extract-facts/handler.ts`
- Modify: `skills/extract-facts/skill.json`
- Modify: `skills/extract-facts/handler.test.ts` (if it has Anthropic SDK mocks)

- [ ] **Step 1: Update skill.json — declare capabilities, remove ANTHROPIC_API_KEY secret**

In `skills/extract-facts/skill.json`, change:

```json
  "secrets": ["ANTHROPIC_API_KEY"],
  "timeout": 15000,
  "capabilities": ["entityMemory"]
```

to:

```json
  "secrets": [],
  "timeout": 15000,
  "capabilities": ["entityMemory", "llmProvider", "modelRouter"]
```

- [ ] **Step 2: Rewrite handler imports and constructor**

In `skills/extract-facts/handler.ts`:

Remove:
```typescript
import Anthropic from '@anthropic-ai/sdk';
```
and the model constants:
```typescript
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACTION_MODEL = 'claude-sonnet-4-6';
```

Remove the constructor's Anthropic client parameter:
```typescript
  constructor(private readonly anthropicClient?: Anthropic) {}
```
Replace with a no-arg constructor (or remove the constructor entirely).

- [ ] **Step 3: Update the classifier LLM call**

Find the classifier call (uses `CLASSIFIER_MODEL` and the `Anthropic` client). Replace it with:

```typescript
    if (!ctx.llmProvider || !ctx.modelRouter) {
      return { success: false, error: 'extract-facts requires llmProvider and modelRouter capabilities' };
    }

    const classifierModel = ctx.modelRouter.resolve('fast').model;
    const extractionModel = ctx.modelRouter.resolve('standard').model;
```

Then replace each `this.anthropicClient.messages.create(...)` call with the equivalent `ctx.llmProvider.chat(...)` call. The Anthropic SDK returns `response.content[0].text`; `LLMProvider.chat()` returns `{ type: 'text', content: string }`. Adjust response handling accordingly.

For the classifier call, replace:

```typescript
    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });
    const classifyResponse = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: classifyPrompt }],
    });
```

with:

```typescript
    const classifyResponse = await ctx.llmProvider.chat({
      model: classifierModel,
      messages: [{ role: 'user', content: classifyPrompt }],
      options: { max_tokens: 10 },
    });
    if (classifyResponse.type === 'error') {
      ctx.log.error({ error: classifyResponse.error }, 'extract-facts: classifier LLM call failed');
      return { success: false, error: `Classifier LLM call failed: ${classifyResponse.error.message}` };
    }
```

And adjust the response content extraction from `classifyResponse.content[0].text` to `classifyResponse.content` (since `LLMProvider.chat()` returns `{ type: 'text', content: string }`).

- [ ] **Step 4: Update the extraction LLM call**

Same pattern for the extraction call — replace `client.messages.create({ model: EXTRACTION_MODEL, ... })` with `ctx.llmProvider.chat({ model: extractionModel, ... })`. Adjust response handling.

- [ ] **Step 5: Update tests**

The handler tests likely mock the `Anthropic` client. Update them to mock `ctx.llmProvider` and `ctx.modelRouter` instead. The `modelRouter` mock returns `{ model: 'claude-haiku-4-5', tier: 'fast' }` for 'fast' and `{ model: 'claude-sonnet-4-6', tier: 'standard' }` for 'standard'.

- [ ] **Step 6: Run tests**

Run: `npx --prefix /path/to/worktree vitest run skills/extract-facts/ 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /path/to/worktree add skills/extract-facts/
git -C /path/to/worktree commit -m "refactor: extract-facts uses shared LLMProvider + ModelRouter instead of raw SDK"
```

---

## Task 11: Migrate extract-relationships handler

**Files:**
- Modify: `skills/extract-relationships/handler.ts`
- Modify: `skills/extract-relationships/skill.json`
- Modify: `skills/extract-relationships/handler.test.ts`

Follow the same pattern as Task 10:

- [ ] **Step 1: Update skill.json**

Change:
```json
  "secrets": ["ANTHROPIC_API_KEY"],
  "capabilities": ["entityMemory"]
```
to:
```json
  "secrets": [],
  "capabilities": ["entityMemory", "llmProvider", "modelRouter"]
```

- [ ] **Step 2: Rewrite handler — remove Anthropic SDK import and model constants**

Remove `import Anthropic from '@anthropic-ai/sdk'` and the `CLASSIFIER_MODEL` / `EXTRACTION_MODEL` constants. Remove the Anthropic client constructor parameter.

- [ ] **Step 3: Update classifier and extraction LLM calls**

Same pattern as Task 10 — resolve models from ctx.modelRouter, use ctx.llmProvider.chat(), handle response types.

- [ ] **Step 4: Update tests**

Mock `ctx.llmProvider` and `ctx.modelRouter` instead of the Anthropic client.

- [ ] **Step 5: Run tests**

Run: `npx --prefix /path/to/worktree vitest run skills/extract-relationships/ 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add skills/extract-relationships/
git -C /path/to/worktree commit -m "refactor: extract-relationships uses shared LLMProvider + ModelRouter instead of raw SDK"
```

---

## Task 12: Migrate file-parse handler

**Files:**
- Modify: `skills/file-parse/handler.ts`
- Modify: `skills/file-parse/skill.json`
- Modify: `skills/file-parse/handler.test.ts`

- [ ] **Step 1: Update skill.json**

Change:
```json
  "secrets": ["ANTHROPIC_API_KEY"],
  "capabilities": []
```
to:
```json
  "secrets": [],
  "capabilities": ["llmProvider", "modelRouter"]
```

- [ ] **Step 2: Rewrite handler — remove Anthropic SDK import and model constant**

`file-parse` only has `EXTRACTION_MODEL = 'claude-sonnet-4-6'` (no classifier stage). Remove the import and constant. Remove the Anthropic client constructor parameter if present.

- [ ] **Step 3: Update LLM calls**

Replace each `client.messages.create({ model: EXTRACTION_MODEL, ... })` with `ctx.llmProvider.chat({ model: ctx.modelRouter.resolve('standard').model, ... })`. Note: `file-parse` uses the vision API for images — check that the `LLMProvider.chat()` interface supports image content blocks. If it doesn't, this may need an adjustment (pass the image as a content block in the messages array).

- [ ] **Step 4: Update tests**

Mock `ctx.llmProvider` and `ctx.modelRouter`.

- [ ] **Step 5: Run tests**

Run: `npx --prefix /path/to/worktree vitest run skills/file-parse/ 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add skills/file-parse/
git -C /path/to/worktree commit -m "refactor: file-parse uses shared LLMProvider + ModelRouter instead of raw SDK"
```

---

## Task 13: Update autonomy scoring-pass — tier instead of model

**Files:**
- Modify: `src/autonomy/scoring-pass.ts`

- [ ] **Step 1: Update ScoringPassConfig**

The `model` field stays as-is in `ScoringPassConfig` — it receives the resolved model string. The change is in `index.ts` (already done in Task 6 step 6), where the tier is resolved to a model before being passed. No changes needed to `scoring-pass.ts` itself beyond verifying the `model` field is still used correctly.

Actually — re-reading the code, `scoring-pass.ts` passes the model via `options: { model: this.config.model }`. This works as-is because `index.ts` now resolves the tier to a model before constructing the config. Verify this is the case and move on.

- [ ] **Step 2: Run tests**

Run: `npx --prefix /path/to/worktree vitest run src/autonomy/ 2>&1 | tail -30`
Expected: PASS (config shape unchanged — the model field still receives a string).

- [ ] **Step 3: Commit (skip if no changes)**

If no code changes were needed, skip the commit.

---

## Task 14: Update working-memory — add model to SummarizationConfig

**Files:**
- Modify: `src/memory/working-memory.ts`

- [ ] **Step 1: Add model to SummarizationConfig**

In `src/memory/working-memory.ts`, update the `SummarizationConfig` interface (~line 15–22):

```typescript
export interface SummarizationConfig {
  threshold: number;
  keepWindow: number;
  provider: LLMProvider;
  /** Resolved model string for the summarization call. */
  model: string;
}
```

- [ ] **Step 2: Pass model to provider.chat()**

Find the `provider.chat()` call (~line 230):

```typescript
    const response = await provider.chat({
      messages: [{ role: 'user', content: summaryPrompt }],
    });
```

Change to:

```typescript
    const response = await provider.chat({
      messages: [{ role: 'user', content: summaryPrompt }],
      model: this.summarizationConfig.model,
    });
```

The exact way `this.summarizationConfig` is accessed depends on how the class stores it — check the code. The summarization config is passed through `createWithPostgres`. Thread the model through to wherever `provider.chat()` is called.

- [ ] **Step 3: Run tests**

Run: `npx --prefix /path/to/worktree vitest run src/memory/ 2>&1 | tail -30`
Expected: PASS (or tests may need the `model` field added to test fixtures).

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add src/memory/working-memory.ts
git -C /path/to/worktree commit -m "refactor: working-memory summarization passes explicit model to provider.chat()"
```

---

## Task 15: Update drift-detector — add model config

**Files:**
- Modify: `src/scheduler/drift-detector.ts`

- [ ] **Step 1: Add model to DriftDetector config**

Find the `DriftDetector` class constructor. Add a `model` parameter (string) to whatever config it accepts. Store it as a private field.

- [ ] **Step 2: Pass model to provider.chat()**

Find the `provider.chat()` call (~line 86):

```typescript
      const response = await this.provider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userLines.join('\n') },
        ],
        options: { max_tokens: 200, temperature: 0 },
      });
```

Change to:

```typescript
      const response = await this.provider.chat({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userLines.join('\n') },
        ],
        options: { max_tokens: 200, temperature: 0 },
      });
```

- [ ] **Step 3: Update DriftDetector construction in index.ts**

Pass the resolved model from `modelRouter.resolve('standard').model` (or whatever tier is appropriate — standard is a safe default for a quick LLM judge call):

```typescript
  const driftDetector = new DriftDetector({
    // ... existing config ...
    model: modelRouter.resolve('standard').model,
  });
```

- [ ] **Step 4: Remove the TODO comment**

Delete the TODO comment at ~lines 11–12:

```typescript
// TODO: When multi-model support is added, make the LLM provider here independently
// configurable from the coordinator's provider (cheaper/faster model for this check).
```

Replace with:

```typescript
// Model is resolved from the standard tier at startup via ModelRouter.
```

- [ ] **Step 5: Run tests**

Run: `npx --prefix /path/to/worktree vitest run src/scheduler/ 2>&1 | tail -30`
Expected: PASS (tests may need the model field added to fixtures).

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/scheduler/drift-detector.ts src/index.ts
git -C /path/to/worktree commit -m "refactor: drift-detector passes explicit model to provider.chat()"
```

---

## Task 16: Final validation and cleanup

- [ ] **Step 1: Run the full test suite**

Run: `npx --prefix /path/to/worktree vitest run 2>&1 | tail -60`
Expected: All tests PASS.

- [ ] **Step 2: Run the TypeScript compiler**

Run: `npx --prefix /path/to/worktree tsc --noEmit 2>&1 | tail -30`
Expected: No type errors.

- [ ] **Step 3: Verify no remaining hardcoded model IDs outside the registry**

Search for stale model references:

Run: `grep -rn "claude-haiku-4-5\|claude-sonnet-4-6\|claude-opus-4-6" /path/to/worktree/src/ /path/to/worktree/skills/ /path/to/worktree/config/ --include="*.ts" --include="*.yaml" --include="*.json" | grep -v node_modules | grep -v model-registry.ts | grep -v ".test.ts"`

Expected: Only `config/default.yaml` (tier mappings) should reference model names. No `.ts` files outside of `model-registry.ts` and test files should contain hardcoded model IDs.

- [ ] **Step 4: Verify no remaining imports of deleted exports**

Search for stale imports:

Run: `grep -rn "getContextWindow\|isKnownContextWindowModel\|DEFAULT_MODEL_NAME\|ANTHROPIC_PRICING" /path/to/worktree/src/ --include="*.ts" | grep -v ".test.ts" | grep -v token-estimator.ts`

Expected: No results.

- [ ] **Step 5: Update CHANGELOG.md**

Add under `## [Unreleased]`:

```markdown
### Changed
- **Model registry** — consolidated scattered model metadata (pricing, context windows, capabilities) into a single `ModelRegistry` in `src/agents/llm/model-registry.ts`. (#556)
- **`model_routing` config** — tier definitions no longer include `provider` (resolved from registry); `autonomy_scoring.model` renamed to `.model_tier`.
- **`extract-facts`, `extract-relationships`, `file-parse`** — migrated from raw Anthropic SDK to shared `LLMProvider` via SkillContext capabilities; LLM calls now appear in cost telemetry. (#556)
```

- [ ] **Step 6: Commit changelog**

```bash
git -C /path/to/worktree add CHANGELOG.md
git -C /path/to/worktree commit -m "docs: update CHANGELOG for model registry consolidation"
```
