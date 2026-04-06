# ADR-012: LLM-as-judge for outbound safety and smoke test evaluation

Date: 2026-03-10
Status: Accepted

## Context

Two distinct evaluation problems emerged during development:

1. **Smoke tests** — integration tests that submit real chat inputs and check whether the agent's response is correct. "Correct" is hard to define with deterministic assertions because LLM responses vary in phrasing.

2. **Outbound safety** — before sending an email or other outbound message on behalf of the executive, the system should check whether the content is appropriate (no prompt injection leakage, no internal structure exposure, no PII exfiltration).

Classic approaches for both: string matching, regex, keyword lists. These are fast and deterministic but brittle — they miss paraphrased problems and produce false positives on legitimate content.

## Decision

Use an LLM-as-judge approach for both smoke test evaluation and outbound safety review (Stage 2).

**Smoke tests:** Each test case provides a rubric and the judge LLM scores the agent's response against it. Results are aggregated into an HTML report. This allows tests to verify semantic correctness ("did the agent find the right contact?") rather than surface form ("did the response contain the word 'found'?").

**Outbound safety:** Stage 1 is a deterministic filter (regex patterns for system prompt fragments, known secret patterns, contact data exfiltration). Stage 2 — planned, not yet shipped — will use a local LLM instance running a different model from the main agent to evaluate borderline cases that Stage 1 passes. Using a *different* model provides independence: the same prompt injection that manipulates the main agent is unlikely to manipulate a different model evaluating its output.

## Consequences

- Smoke test evaluation is non-deterministic — the same response may receive slightly different scores on repeated runs. Rubrics must be written carefully to produce consistent judgments.
- LLM-as-judge adds latency and cost to the smoke test suite. Tests are run manually or in CI, not on every commit — this cost is accepted.
- Stage 2 outbound safety (LLM judge) requires a second model inference per outbound message. The local/different-model requirement means it cannot use the same Anthropic Claude instance that generated the outbound content.
- The deterministic Stage 1 filter runs first — Stage 2 is only invoked for content that passes Stage 1. This limits the latency impact to edge cases.
- This is a two-stage defense: Stage 1 catches known patterns fast; Stage 2 catches novel or subtle violations. Neither stage provides absolute guarantees.
