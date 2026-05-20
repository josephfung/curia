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
        // The fallback model is hardcoded to a known registry entry. If it's missing,
        // the registry was modified incorrectly — throw rather than silently returning $0
        // which would corrupt all cost dashboards.
        throw new Error(`Fallback pricing model '${FALLBACK_MODEL}' is not in the model registry — add it or update FALLBACK_MODEL`);
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
