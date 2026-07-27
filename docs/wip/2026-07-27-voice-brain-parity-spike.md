# Voice brain parity spike (#1595) — notes

Date: 2026-07-27 (updated after PR #1608 blocking review)

ADR-038 is **Proposed** — not Accepted. This note points at the frozen
fixture, measurement artifacts, and the async off-ramp design; it is not a
second decision log.

## Artifacts

| Path | Role |
|---|---|
| `scripts/spikes/voice-brain-parity/fixtures.json` | Frozen eval set (19 utterances; load-bearing tools; routing / offramp / multi-turn) |
| `scripts/spikes/voice-brain-parity/run.ts` | Three-arm quality + latency harness |
| `scripts/spikes/voice-brain-parity/results.json` | Latest expanded run (report as utterances / assertion-checks) |
| `scripts/spikes/voice-brain-parity/latency-microbench.ts` | Interleaved bare-turn TTFT microbench |
| `src/agents/prompts/` | Shared modules + voice-only async off-ramp guidance |

## Counting

Say **"19 utterances / 50 assertion-checks"**, not "50 tests". The suite is a
spike differentiator, not exhaustive coverage of coordinator depth.

## Async off-ramp

Design lives in ADR-038 and `VOICE_ASYNC_OFFRAMP_GUIDANCE`. Recognition is
evaluated in the fixture; the real dispatch handoff (async coordinator task +
Signal/email follow-up) is implementation work after the ADR is Accepted.

## Outbound-context check

Both prototype arms inject `formatInjectionBlock` **once** on the system
prompt suffix (voice path). Neither re-enters the dispatcher user-content
injection.

## Re-run

```bash
ANTHROPIC_API_KEY=… pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/latency-microbench.ts
```
