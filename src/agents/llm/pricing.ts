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

// Hard-coded last-resort fallback — only used when the caller doesn't pass a
// fallbackModel and the registry lookup fails. Kept as a constant so the throw
// message is informative about what to fix.
const HARD_FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Creates an estimateCostUsd function backed by the given model registry.
 * Call once at startup; use the returned function for all cost estimation.
 *
 * @param registry - the model registry to look up pricing from
 * @param fallbackModel - model to use for cost estimates when actualModel is
 *   not in the registry. Defaults to claude-sonnet-4-6 but callers should pass
 *   their configured default tier model so estimates track operator routing.
 */
export function createEstimateCostUsd(
  registry: ModelRegistry,
  fallbackModel = HARD_FALLBACK_MODEL,
): (actualModel: string, usage: LLMUsage, logger?: Logger) => number {
  return (actualModel: string, usage: LLMUsage, logger?: Logger): number => {
    let pricing: ModelPricing | undefined = registry.getPricing(actualModel);

    if (!pricing) {
      logger?.warn({ actualModel, fallback: fallbackModel }, 'Unrecognised model — using fallback pricing for cost estimate');
      pricing = registry.getPricing(fallbackModel);
      if (!pricing) {
        // The fallback model is not in the registry — the caller passed a model
        // that isn't registered, or the default HARD_FALLBACK_MODEL was removed.
        // Throw rather than silently returning $0, which corrupts cost dashboards.
        throw new Error(`Fallback pricing model '${fallbackModel}' is not in the model registry — add it or update the fallback`);
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
