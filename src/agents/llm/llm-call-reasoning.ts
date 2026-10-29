// llm-call-reasoning.ts — the reasoning and attempt fields every llm.call publisher sets.
//
// One helper so the five publishers (runtime, TelemetryLlmProvider, both
// judges, infra-llm) cannot drift apart (ADR-048 §5, #1915).

import type { LLMCallProvenance, LLMUsage } from './provider.js';
import type { ReasoningEffort } from './sampling-options.js';
import type { ReasoningWatchdogRecord } from './reasoning-watchdog.js';

export interface LlmCallReasoningFields {
  reasoningTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
  upstreamProvider: string | null;
  reasoningBlocksDropped: number;
  attempts: number | null;
  failedAttemptsMs: number | null;
  reasoningWatchdog: ReasoningWatchdogRecord | null;
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
    // null, not 1, where the provider does not count: its SDK may retry unseen.
    attempts: provenance.attempts ?? null,
    failedAttemptsMs: provenance.failedAttemptsMs ?? null,
    reasoningWatchdog: provenance.reasoningWatchdog ?? null,
  };
}
