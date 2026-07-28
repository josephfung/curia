# Voice brain parity spike (#1595) — notes

Date: 2026-07-27 (updated 2026-07-28 after third PR #1608 review)

ADR-038 is **Proposed**. Prefer **paired per-rep deltas** over marginal
min/max. Compose modules only when each pays for itself (#1605 reframed).

## Artifacts

| Path | Role |
|---|---|
| `fixtures.json` | Frozen eval set (19 utterances; load-bearing tools) |
| `run.ts` | Three-arm harness; `REPS=N` interleaved variance + paired deltas |
| `variance.json` | Marginal rates **and** `paired` check/utterance/category deltas |
| `src/agents/prompts/` | Shared modules + voice-only async off-ramp guidance |

## Paired overall (5 interleaved reps)

| Comparison | mean Δ | signs | paired win |
|---|---|---|---|
| shared − baseline | +0.068 | 5/5 + | yes |
| shared − full | +0.072 | 5/5 + | yes |

Carried largely by mocked `async-offramp`. Net of that: routing modest +;
pronoun Δ=0; date wash with distraction risk → #1612.

## Per-module compose (#1613; supersedes bundled #1605)

- Routing — compose
- Pronoun — hold until `pronoun-your` moves
- Off-ramp — compose only after real handoff

## Re-run

```bash
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
```
