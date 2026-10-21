// llm-call-reasoning.ts — the reasoning fields every llm.call publisher sets.
//
// One helper so the five publishers (runtime, TelemetryLlmProvider, both
// judges, infra-llm) cannot drift apart (ADR-048 §5).

import type { LLMCallProvenance, LLMUsage } from './provider.js';
import type { ReasoningEffort } from './sampling-options.js';

export interface LlmCallReasoningFields {
  reasoningTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
  upstreamProvider: string | null;
  reasoningBlocksDropped: number;
}

/**
 * Reasoning fields for an `llm.call` payload, from a successful response.
 * `reasoningEffort` is what the provider reports it sent, so the row matches
 * the request even when the provider dropped an effort the model does not
 * take; null means the provider default applied.
 */
export function llmCallReasoningFields(
  usage: LLMUsage,
  provenance: LLMCallProvenance,
): LlmCallReasoningFields {
  return {
    reasoningTokens: usage.reasoningTokens ?? null,
    reasoningEffort: provenance.reasoningEffort ?? null,
    upstreamProvider: provenance.upstreamProvider ?? null,
    reasoningBlocksDropped: provenance.reasoningBlocksDropped ?? 0,
  };
}
