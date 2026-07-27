# ADR-038: Voice brain parity — shared-hardening vs full consolidation

Date: 2026-07-27
Status: Proposed

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

Two directions are on the table:

1. **Shared-hardening** — extract channel-agnostic guardrails into
   `src/agents/prompts/` modules that both the coordinator and
   `buildVoiceSystemPrompt` compose. Voice keeps its streaming loop
   (`streaming-turn.ts`, 8-round cap) and spoken-brevity addendum.
2. **Full consolidation** — feed the coordinator prompt (plus a spoken-output
   post-processing layer) into the voice streaming path.

This decision is coupled to #1563 (opt `AgentRuntime.handleTask` into the
shared streaming primitive). That issue is blocked on an explicit "text may
use `stream()`" call. Shared-hardening vs full consolidation determines the
convergence direction.

### Capability delta (why an off-ramp is required)

Shared-hardening gives voice date / routing / pronoun guardrails but **not**
the coordinator's operational depth. Sections in `coordinator.yaml` that no
shared module covers and that still matter on a live call include:

- Audience awareness / provenance hardening
- Active outbound-context lifecycle (release / sweep / task-wake bindings) —
  the routing module carries only the **match** rule
- Specialist clarification resume, resumable-task pauses, delegate wait timeouts
- Most of `## What I Do Directly` (memory discipline, scheduling/task
  management, email etiquette, Workspace, pending approvals, …)

Combined with voice's 8-round cap, a heavyweight / stateful /
clarification-needing request can make voice **fail or hallucinate** instead
of degrading gracefully — i.e. feel dramatically less capable than the
coordinator. Shared-hardening is only safe with a **first-class async
off-ramp** (designed below; recognition evaluated in the fixture).

### Evaluation standard

An earlier draft of this ADR treated **8 single-turn utterances /
21 assertion-checks** with a non-load-bearing calendar mock as decisive.
That is not enough to carry the call (see PR #1608 review). The current
fixture is larger and discriminating, but still a spike instrument — not a
production smoke suite. Counts are reported as **utterances /
assertion-checks**.

## Proposed decision

**Lean shared-hardening** (reject full consolidation as the voice brain
direction), **contingent on** shipping the async off-ramp alongside the
remaining shared modules. Status stays **Proposed** until the expanded
evidence below is accepted and the off-ramp handoff is implemented beyond
prompt recognition.

### Evidence (expanded fixture, 2026-07-27 re-run)

Harness: `scripts/spikes/voice-brain-parity/` — Haiku 4.5, `stream()` + tools.
**19 utterances / 50 assertion-checks.** Calendar mock is load-bearing (rejects
briefs that omit a date `date-resolve` produced this turn; ISO or natural form
accepted). Fixture covers day-of-week arithmetic, calendar delegation, honest-
negative (error / timeout / empty-success), pronouns, transfer-ownership,
borrow-then-answer, outbound-context ack (multi-turn), and async off-ramp
(positive + negative + accepted handoff).

| Arm | Prompt tokens (est.) | Assertion-checks | Failures by category |
|---|---|---|---|
| baseline (prod slim + date-resolve module only) | ~656 | 44 pass / 6 fail | date×3, pronoun×1, offramp×2 |
| **shared-hardening** (routing + pronouns + date-resolve + off-ramp) | ~1 563 | **48 / 2** | date×1, pronoun×1 |
| full-consolidation (full YAML + spoken addendum + off-ramp) | ~12 415 | 45 / 5 | date×2, transfer×3 |

Bare-turn latency (prior interleaved microbench, 5 reps): baseline p50 TTFT
526 ms (~488 tok at the time); shared-hardening 657 ms; full-consolidation
782 ms. Full consolidation remains ~25× the instruction tokens every spoken
turn (cost / cache-write / cold-cache risk) and imported text-channel
mechanics that hurt live-call UX (transfer-ownership substantive reply on
`routing-transfer-yes` in an earlier run; transfer miss on this run).

**What moved quality:** routing + pronoun + off-ramp modules in the
shared-hardening arm — not date-resolve alone. Baseline already composes
`DATE_RESOLVE_GUARDRAIL` in production; the expanded load-bearing date cases
still show residual day-arithmetic misses across all arms (model sometimes
passes a wrong calendar date into the brief despite calling `date-resolve`).
Pronoun-your ("your calendar" → Avery) remains hard on baseline and
shared-hardening; full-consolidation passed that case on this run.

**Off-ramp:** shared-hardening passed all four offramp assertion groups on
this run (offer / don't-fake-finish / accepted handoff / no spurious offer).
Baseline missed bulk-inbox offer and handoff-confirm phrasing. Full
consolidation passed offramp cases here but has previously claimed finished
heavy work — keep the negative checks.

Outbound-context: both prototype arms inject `formatInjectionBlock` **once**
on the voice system-prompt path (never also via the dispatcher user-content
path). Preserve that invariant.

### Async off-ramp design (required mitigation)

When a request exceeds live-call scope, voice should:

1. **Recognize** — heavyweight, long-running, needs a clarification loop, or
   needs coordinator-only depth (see `VOICE_ASYNC_OFFRAMP_GUIDANCE`).
2. **Offer** — natural spoken deferral: *"That'll take a bit — want me to work
   on it and follow up in a few minutes?"*
3. **Hand off** — on agreement (or clearly async-shaped asks), call
   `async-offramp` with a crisp brief + follow-up channel. Implementation
   follow-up: publish onto the normal async dispatch path (coordinator task /
   inbound.message) rather than a prompt-only stub.
4. **Close the loop** — reach the principal on Signal/email when done.

Prompt module: `src/agents/prompts/voice-async-offramp.ts` (voice-only; do
not compose into coordinator YAML). Eval cases live under category
`async-offramp` / `async-offramp-negative` in
`scripts/spikes/voice-brain-parity/fixtures.json`.

### Tentative resolution of #1563's blocking question

**Pending ADR acceptance:** if shared-hardening is accepted, text channels
**may** use `LLMProvider.stream()` — convergence onto the shared streaming
primitive with separately composed prompts. Do **not** fold voice into
`handleTask`'s non-streaming loop, and do not make voice adopt the full
coordinator YAML. Until this ADR is Accepted, #1563 stays blocked on the
decision.

### What is / is not in production on this branch

| Module | In eval shared-hardening arm | Wired into prod voice / coordinator |
|---|---|---|
| `DATE_RESOLVE_GUARDRAIL` | yes | **yes** (both; YAML has no pointer stub) |
| `ROUTING_DECISION_GUARDRAIL` | yes | no — follow-up after Accepted |
| `PRONOUN_RESOLUTION_GUARDRAIL` | yes | no — follow-up after Accepted |
| `VOICE_ASYNC_OFFRAMP_GUIDANCE` + `async-offramp` tool | yes | no — implement handoff + compose after Accepted |

Shipping date-resolve first remains a small, reversible compose; the
expanded fixture now exercises it with a load-bearing calendar mock. The
modules that moved quality (routing / pronouns / off-ramp) stay staged until
this ADR is Accepted.

### Prompt-shape rule

Never put repo paths, ADR numbers, or "injected from …" plumbing into
model-visible prompts. Provenance belongs in code comments (`runtime.ts`).
The coordinator's sole `### Date & time` instruction is the composed
`DATE_RESOLVE_GUARDRAIL` module.

## Consequences (if Accepted)

- Voice stays a curated subset brain (ADR-037) **plus** shared guardrail
  modules **plus** the async off-ramp — no full YAML on the spoken critical path.
- Guardrail drift is structural: channel-agnostic rules live in
  `src/agents/prompts/` and are composed by both brains. Copy-pasting
  coordinator lines into `VOICE_*` constants is out of policy.
- Text → streaming (#1563 / #1606) unblocks on acceptance.
- Follow-ups: compose routing + pronouns (#1605), implement async-offramp
  handoff (new issue on acceptance), keep expanding the spike fixture toward
  a durable voice eval.
- Full consolidation remains a rejected alternative unless a later fixture
  shows a failure mode that uniquely requires the full YAML *and* cannot be
  closed by shared modules + off-ramp.
- Spike harness retained under `scripts/spikes/voice-brain-parity/` for
  re-runs.
