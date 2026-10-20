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
}

/**
 * Reasoning fields for an `llm.call` payload, from a successful response.
 * `reasoningEffort` is null until the reasoning setting lands: no request
 * sends one yet, so every call ran at the provider default.
 */
export function llmCallReasoningFields(
  usage: LLMUsage,
  provenance: LLMCallProvenance,
): LlmCallReasoningFields {
  return {
    reasoningTokens: usage.reasoningTokens ?? null,
    reasoningEffort: null,
    upstreamProvider: provenance.upstreamProvider ?? null,
  };
}
