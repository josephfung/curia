# ADR-038: Voice brain parity via shared-hardening (not full consolidation)

Date: 2026-07-27
Status: Accepted

## Context

Voice runs a deliberately thin, separately maintained brain
(`buildVoiceSystemPrompt` in `src/channels/voice/voice-runtime.ts`) over the
same coordinator tool pins and `ExecutionLayer`, while text channels run
`AgentRuntime.processTask` with the full ~660-line `agents/coordinator.yaml`
prompt and a non-streaming `chat()` tool loop. The thin voice prompt drifted
from the coordinator's hardened guardrails — especially the **date-resolve**
day-of-week rule, three-way routing / transfer-ownership, and pronoun
resolution before delegate — so spoken turns repeated mistakes the coordinator
already learned to avoid (#1595).

Two directions were on the table:

1. **Shared-hardening** — extract channel-agnostic guardrails into
   `src/agents/prompts/` modules that both the coordinator and
   `buildVoiceSystemPrompt` compose. Voice keeps its streaming loop
   (`streaming-turn.ts`, 8-round cap) and spoken-brevity addendum.
2. **Full consolidation** — feed the coordinator prompt (plus a spoken-output
   post-processing layer) into the voice streaming path.

This decision is coupled to #1563 (opt `AgentRuntime.handleTask` into the
shared streaming primitive). That issue was blocked on an explicit "text may
use `stream()`" call. Shared-hardening vs full consolidation determines the
convergence direction: text → voice's streaming loop, or voice → the
coordinator's chat loop.

Also in scope for the spike measurement:

- Frozen 8-turn voice fixture (`scripts/spikes/voice-brain-parity/fixtures.json`)
  covering day-of-week arithmetic, calendar delegation, honest-negative, and
  pronoun resolution.
- Latency on the real voice model (`claude-haiku-4-5` / `fast` tier) —
  time-to-first-token (TTFT, proxy for time-to-first-audio) and full-turn.
- Outbound-context bridge (#1594): both arms must preserve **exactly one**
  injection. Voice injects via system prompt today; the dispatcher injects into
  user content for text and **skips** `channelId === 'voice'`. Full
  consolidation that also kept `buildTurnSystemPrompt`'s getActive path would
  double-inject.

## Decision

**Choose shared-hardening.** Reject full consolidation as the voice brain
direction.

Recorded measurements (Haiku 4.5, streaming + tools, frozen fixture,
2026-07-27; raw data in `scripts/spikes/voice-brain-parity/results.json` and
`latency-microbench.json`):

| Arm | Prompt tokens (est.) | Fixture checks | Bare-turn p50 TTFT (5 interleaved reps) | Fixture avg full-turn |
|---|---|---|---|---|
| baseline (today's slim prompt) | ~488 | 19 pass / 2 fail | 526 ms | 2460 ms |
| **shared-hardening** | ~1080 | **20 / 1** | **657 ms** | 2661 ms |
| full-consolidation | ~12 120 | 20 / 1 | 782 ms | 2616 ms |

Quality: shared-hardening matched full consolidation on the fixture (both
20/21) and beat baseline. The decisive baseline miss was pronoun resolution
on "What's on your calendar tomorrow?" — the slim prompt delegated to the
**principal's** calendar; shared routing/pronoun modules corrected it. All
three arms still soft-missed "should call date-resolve" on one tomorrow-morning
lookup (delegate alone was enough for the mock calendar) — not a differentiator.

Latency: shared-hardening adds ~130 ms p50 TTFT on bare turns vs baseline
(~2× prompt tokens). Full consolidation is only ~250 ms slower than baseline
*with* Anthropic prompt caching warm, but carries **~25×** the instruction
tokens every spoken turn (cost, cache-write, cold-cache risk) and imports
text-channel mechanics (transfer-ownership "do not reply", email CC rules,
40-turn budget semantics) that fight live-call UX.

Outbound-context: shared-hardening keeps the existing single voice injection
site (`outboundContext.getActive` → system prompt). Full consolidation must
not also run the dispatcher user-content path for voice — the spike prototype
injected once on the system suffix only; any future consolidate attempt must
keep that invariant.

### Resolution of #1563's blocking question

**Yes — text channels may use `LLMProvider.stream()`.** Convergence is onto
the shared streaming tool-loop primitive voice already uses
(`src/agents/llm/streaming-turn.ts`), with **separate composed prompts** per
ADR-038. Do **not** fold voice into `handleTask`'s non-streaming loop, and do
not make voice adopt the full coordinator YAML as its system prompt.

#1563 remains the implementation vehicle for the text opt-in (retry/fallback,
DelegationGuard, clarification, tool bus events must still work on the text
path; round-cap stays parameterized — voice 8 vs per-agent `maxTurns`).

### First relief shipped with this ADR

`DATE_RESOLVE_GUARDRAIL` lives in
`src/agents/prompts/date-resolve-guardrail.ts` and is composed by both
`buildVoiceSystemPrompt` and coordinator `processTask` (YAML body replaced
with a pointer). Routing and pronoun modules exist beside it for the
follow-up wiring issue; they were measured in the shared-hardening arm but are
not yet composed into production voice prompts beyond what
`VOICE_DELEGATION_GUIDANCE` already compresses.

## Consequences

- Voice stays a curated subset brain (ADR-037) **plus** shared guardrail
  modules — no full YAML on the spoken critical path.
- Guardrail drift is structural: new channel-agnostic rules go in
  `src/agents/prompts/` and are composed by both brains. Copy-pasting
  coordinator lines into `VOICE_*` constants is out of policy.
- Text → streaming (#1563) is unblocked and is the loop-axis companion to
  this prompt-axis decision.
- Remaining voice quality gaps (full routing / pronoun parity, provenance
  rules that matter on principal-only voice) are follow-up implementation
  issues (#1605), not a reopen of shared-hardening vs consolidation.
- Text → streaming implementation is #1606 (successor to blocked #1563).
- Full consolidation remains a rejected alternative; revisit only if shared
  modules fail to close a measured failure mode that uniquely requires the
  full YAML (none observed on this fixture).
- Spike harness retained under `scripts/spikes/voice-brain-parity/` for
  re-runs when adding the next shared module.
