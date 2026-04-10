# ADR 015 — LLM-as-judge for intent drift detection over embedding cosine similarity

**Status:** Accepted  
**Date:** 2026-04-10

## Context

Intent drift detection (spec §06) requires comparing the current `task_payload` of a
scheduled job against its original `intent_anchor` to determine whether the task has
meaningfully deviated from its mandate. Two approaches were considered:

1. **Embedding cosine similarity** — embed both texts with OpenAI text-embedding-3-small
   (already used for the knowledge graph) and compare cosine distances against a numeric
   threshold.

2. **LLM-as-judge** — prompt the coordinator's LLM to evaluate whether the task has
   drifted, returning a structured `{ drifted, reason, confidence }` verdict.

## Decision

Use LLM-as-judge (option 2).

Embedding similarity cannot distinguish between these two cases:
- "Research AI safety articles weekly" → "Summarise recent AI safety papers" (aligned, just rephrased)
- "Research AI safety articles weekly" → "Draft a market report on SaaS pricing" (clearly drifted)

Both pairs may have similar cosine distances depending on training data. The result is
unpredictable false-positive and false-negative rates that depend on embedding model
characteristics, not on semantic intent.

The LLM can reason about the *purpose* of a task and apply judgment that is not reducible
to vector distance. The `confidence` field also allows operators to tune sensitivity via
`minConfidenceToPause` without needing to calibrate a numeric threshold against
embedding geometry.

The `reason` field provides an audit trail that a similarity score cannot: it explains
*why* the LLM concluded the task has or has not drifted.

## Consequences

- **Easier:** Adding or tuning drift detection requires no knowledge of embedding geometry
  or threshold calibration. The natural language config (`minConfidenceToPause: high`) is
  self-documenting.
- **Harder:** LLM calls have latency and cost. One judge call per burst per persistent task
  is acceptable at current scale; at high job counts, `checkEveryNBursts` can reduce
  frequency.
- **Future:** When multi-model routing is added, the drift judge should be independently
  configurable to use a cheaper/faster model (e.g. Haiku instead of Sonnet). A TODO comment
  is placed at each wiring point.
- **Existing ADR 012** documents LLM-as-judge for outbound safety evaluation. This ADR
  extends the same pattern to a new evaluation surface (task integrity).
