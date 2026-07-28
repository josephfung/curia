# Voice brain parity spike (#1595) — notes

Date: 2026-07-27 (updated 2026-07-28 after second PR #1608 review)

ADR-038 is **Proposed** — Accept gates: variance-backed quality claim (or
narrowed claim), #1612 date-in-brief structural fix, real async-offramp handoff.

## Artifacts

| Path | Role |
|---|---|
| `fixtures.json` | Frozen eval set (19 utterances; load-bearing tools) |
| `run.ts` | Three-arm harness; `REPS=N` for interleaved variance |
| `variance.json` | 5-rep pass-rate mean [min,max] overall + per category |
| `results.json` | Raw per-rep rows (large) |
| `src/agents/prompts/` | Shared modules + voice-only async off-ramp guidance |

## Variance (5 interleaved reps)

Overall check pass-rate mean [min, max]:

- baseline: 0.888 [0.860, 0.920]
- shared-hardening: 0.956 [0.900, 0.980] — leads mean, **no interval separation** vs baseline
- full-consolidation: 0.884 [0.840, 0.940]

Category with clean separation (shared min > others' max): **async-offramp only**.

Focus: `pronoun-your-calendar` 0/5 shared & baseline, 1/5 full — known #1605 gap.
Wrong-date-in-brief after calling date-resolve → #1612.

## Counting

Say **"19 utterances / ~50 assertion-checks × N reps"**, not "N tests".

## Re-run

```bash
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
```
