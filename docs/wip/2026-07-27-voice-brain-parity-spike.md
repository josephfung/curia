# Voice brain parity spike (#1595) — notes

Date: 2026-07-27

Decision recorded in **ADR-038**. This note points at the frozen fixture and
measurement artifacts; it is not a second decision log.

## Artifacts

| Path | Role |
|---|---|
| `scripts/spikes/voice-brain-parity/fixtures.json` | Frozen 8-turn eval set (do not edit utterances mid-comparison) |
| `scripts/spikes/voice-brain-parity/run.ts` | Three-arm quality + latency harness (Haiku stream + mock tools) |
| `scripts/spikes/voice-brain-parity/results.json` | Fixture run used for ADR-038 |
| `scripts/spikes/voice-brain-parity/latency-microbench.ts` | Interleaved bare-turn TTFT microbench |
| `scripts/spikes/voice-brain-parity/latency-microbench.json` | 5-rep interleaved TTFT used for ADR-038 |
| `src/agents/prompts/` | Shared guardrail modules (date-resolve shipped; routing + pronouns staged) |

## Re-run

```bash
ANTHROPIC_API_KEY=… pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/latency-microbench.ts
```

## Outbound-context check

Both prototype arms injected `formatInjectionBlock` **once** on the system
prompt suffix (voice path). Neither re-entered the dispatcher user-content
injection. Preserve that invariant in follow-ups.
