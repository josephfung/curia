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
//
// Fallback tier rules (#813): when a tier's primary model is unavailable
// (NOT_FOUND from the provider), the runtime re-routes to the fallback tier.
// Rules are fixed — no config knob needed:
//   fast     → standard  (lateral upgrade to a capable model)
//   standard → powerful  (upgrade to strongest model)
//   powerful → standard  (degrade gracefully rather than fail)

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

// Fixed fallback tier for each tier (#813). No config needed — these rules are intentional:
// fast→standard (upgrade), standard→powerful (upgrade), powerful→standard (graceful degrade).
const FALLBACK_TIER: Record<Tier, Tier> = {
  fast: 'standard',
  standard: 'powerful',
  powerful: 'standard',
};

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

  /**
   * Return the fallback tier to use when this tier's primary model is unavailable.
   * Rules are fixed (#813): fast→standard, standard→powerful, powerful→standard.
   */
  getFallbackTier(tier: Tier): Tier {
    return FALLBACK_TIER[tier];
  }
}
