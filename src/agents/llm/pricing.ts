// pricing.ts — Anthropic model pricing for LLM call cost estimation.
//
// estimateCostUsd() is called by the runtime after every successful provider.chat()
// to populate estimatedCostUsd in the llm.call bus event. Full float precision is
// returned — callers round for display.
//
// Pricing is matched by prefix so that minor version suffixes (e.g.
// 'claude-haiku-4-5-20251001') fall through to the correct base entry.
// Unrecognised models fall back to sonnet pricing with a warn log rather than
// silently returning 0 — a silent zero would make cost dashboards misleading.
//
// Rates as of 2026-05 (USD per million tokens):
//   Model            Input    Output   CacheCreate   CacheRead
//   claude-opus-4-6  $15.00   $75.00   $18.75        $1.50
//   claude-sonnet-4-6 $3.00   $15.00   $3.75         $0.30
//   claude-haiku-4-5  $0.80    $4.00    $1.00         $0.08

import type { Logger } from '../../logger.js';
import type { LLMUsage } from './provider.js';

interface ModelPricing {
  /** USD per million input tokens */
  inputPerMToken: number;
  /** USD per million output tokens */
  outputPerMToken: number;
  /** USD per million cache-creation tokens (written to prompt cache) */
  cacheCreationPerMToken: number;
  /** USD per million cache-read tokens (served from prompt cache) */
  cacheReadPerMToken: number;
}

// Keyed by model name prefix. Longer prefixes take precedence over shorter ones
// because we sort entries by key length descending before matching.
const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': {
    inputPerMToken: 15.00,
    outputPerMToken: 75.00,
    cacheCreationPerMToken: 18.75,
    cacheReadPerMToken: 1.50,
  },
  'claude-sonnet-4-6': {
    inputPerMToken: 3.00,
    outputPerMToken: 15.00,
    cacheCreationPerMToken: 3.75,
    cacheReadPerMToken: 0.30,
  },
  'claude-haiku-4-5': {
    inputPerMToken: 0.80,
    outputPerMToken: 4.00,
    cacheCreationPerMToken: 1.00,
    cacheReadPerMToken: 0.08,
  },
};

// Pre-sort by key length descending so the first prefix match is always the
// most specific one (e.g. 'claude-sonnet-4-6' beats 'claude-sonnet').
const SORTED_PRICING_ENTRIES = Object.entries(ANTHROPIC_PRICING)
  .sort(([a], [b]) => b.length - a.length);

const FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Estimate the cost in USD for a single LLM API call.
 *
 * Matches `actualModel` against known prefixes (longest match wins).
 * Falls back to claude-sonnet-4-6 pricing for unrecognised models, logging a
 * warning — this makes unknown-model costs visible rather than silently zero.
 *
 * @param actualModel  The model that ran, from the API response body.
 * @param usage        Token counts, including all four Anthropic token categories.
 * @param logger       Optional logger; warn is emitted for unrecognised models.
 */
export function estimateCostUsd(actualModel: string, usage: LLMUsage, logger?: Logger): number {
  const entry = SORTED_PRICING_ENTRIES.find(([prefix]) => actualModel.startsWith(prefix));

  let pricing: ModelPricing;
  if (entry) {
    pricing = entry[1];
  } else {
    logger?.warn({ actualModel, fallback: FALLBACK_MODEL }, 'Unrecognised model — using fallback pricing for cost estimate');
    pricing = ANTHROPIC_PRICING[FALLBACK_MODEL]!;
  }

  // Divide by 1_000_000 to convert from per-million-token rate to per-token rate.
  return (
    (usage.inputTokens * pricing.inputPerMToken +
     usage.outputTokens * pricing.outputPerMToken +
     usage.cacheCreationInputTokens * pricing.cacheCreationPerMToken +
     usage.cacheReadInputTokens * pricing.cacheReadPerMToken) /
    1_000_000
  );
}
