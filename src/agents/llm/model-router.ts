// model-router.ts — resolves capability tiers to concrete provider + model pairs.
//
// Agents declare a tier (fast | standard | powerful) in their YAML config.
// The operator maps tiers to models in config/default.yaml. This class
// performs the lookup at startup so the runtime knows which model to use.
//
// Capability needs (vision, large_context, etc.) are accepted but not
// validated in this version — they are documentary-only, logged at debug
// level for observability. Validation is deferred until multi-model
// support lands (#379).

import type { Logger } from '../../logger.js';

export type Tier = 'fast' | 'standard' | 'powerful';

export interface TierConfig {
  provider: string;
  model: string;
}

export interface ModelRoutingConfig {
  tiers: Record<Tier, TierConfig>;
  default_tier: Tier;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  tier: Tier;
}

const VALID_TIERS: ReadonlySet<string> = new Set<string>(['fast', 'standard', 'powerful']);

export class ModelRouter {
  private readonly config: ModelRoutingConfig;
  private readonly logger: Logger;

  constructor(config: ModelRoutingConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Resolve a tier (and optional needs) to a concrete provider + model.
   *
   * Throws if the tier is unknown — this is a startup-fatal misconfiguration.
   * `needs` is accepted but not validated; logged at debug level so operators
   * can see what capabilities agents are requesting.
   */
  resolve(tier: string, needs?: string[]): ResolvedModel {
    if (!VALID_TIERS.has(tier)) {
      throw new Error(`Unknown model tier "${tier}". Valid tiers: ${[...VALID_TIERS].join(', ')}`);
    }

    const tierConfig = this.config.tiers[tier as Tier];

    if (needs && needs.length > 0) {
      // TODO: validate that the resolved model supports the declared needs
      // when capability metadata is available (model registry consolidation).
      this.logger.debug({ tier, needs, model: tierConfig.model }, 'Model tier resolved (needs not validated)');
    } else {
      this.logger.debug({ tier, model: tierConfig.model }, 'Model tier resolved');
    }

    return {
      provider: tierConfig.provider,
      model: tierConfig.model,
      tier: tier as Tier,
    };
  }
}
