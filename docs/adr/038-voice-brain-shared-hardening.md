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
coordinator. Shared-hardening is only safe once a **first-class async
off-ramp handoff is real** (not merely prompt-recognized) — see gates below.

### Evaluation standard

Counts are **utterances / assertion-checks**, not "N tests". Run ≥5
**interleaved** reps (arms paired on per-rep difficulty). Prefer the
**per-rep paired delta** (`shared − baseline`, `shared − full`) over
marginal min/max ranges — marginal overlap can hide a consistent paired
effect. Call a comparison a **paired win** when the delta is positive in
≥4/5 reps and never negative (`variance.json` → `paired`). Marginal
min>max separation remains a stricter optional signal.

## Proposed decision

**Reject full consolidation** as the voice brain direction — the ~25×
instruction-token cost alone carries that rejection (latency microbench +
prompt-size estimates). Paired deltas also favor shared-hardening over
full consolidation on every rep (see below); consolidation does not win
quality.

**Lean shared-hardening**, but **do not Accept yet**, and **do not bundle
module compose**. Gates:

1. **Quality claim (paired, not marginal).** Across 5 interleaved reps,
   `shared − baseline` check-rate delta is positive on **5/5** reps
   (mean +0.068) — a paired win the marginal ranges understated. That win
   is **largely carried by `async-offramp`**, which is still a mocked
   capability. Net of offramp, remaining modules must each earn compose
   on their own paired benefit (see per-module table) — not ride a
   bundled "shared-hardening wins" claim.
2. **`date-resolve` → brief handoff is a structural bug, not a prompt gap**
   (#1612). The guardrail induces the tool call; the model can still put a
   wrong date in the delegate brief. Fix calendar/delegate validation
   orthogonally (and preferably before Accept).
3. **Off-ramp acceptance gates on a real handoff**, not mock recognition.
   `VOICE_ASYNC_OFFRAMP_GUIDANCE` + fixture `mustCallTools: ["async-offramp"]`
   measure recognition only. Acceptance requires an `async-offramp` tool that
   actually enqueues coordinator work and reaches the principal on
   Signal/email. Do not ship the prompt that offers follow-ups until that
   path exists. Implementation tracked in #1614.

### Per-module compose gates (#1605 reframed)

Baseline already composes `DATE_RESOLVE_GUARDRAIL`. The shared-hardening
eval arm adds routing + pronouns + off-ramp. Gate each production compose
on its own measured benefit — do **not** ship the bundle:

| Module | Paired evidence vs baseline | Production compose |
|---|---|---|
| **Routing** (`ROUTING_DECISION_GUARDRAIL`) | transfer-ownership Δ mean +0.075; never negative (3/5 +, 2/5 0) | **Compose** — modest, consistent non-regression (#1613) |
| **Pronoun** (`PRONOUN_RESOLUTION_GUARDRAIL`) | Δ identically 0; `pronoun-your` 0/5 either way | **Hold** until it moves `pronoun-your` — pure token cost today (#1613) |
| **Off-ramp** (`VOICE_ASYNC_OFFRAMP_GUIDANCE`) | paired win (Δ mean +0.40, 5/5 +) but **mocked** tool | **Compose only after real handoff** (gate #3, handoff #1614; compose per #1613) |
| **Date-resolve** (already in prod) | wash / distraction risk (`date-next-friday` ↑, `date-next-tuesday` ↓, honest-negative dipped once) | Keep; close handoff via **#1612**, not more prompt text |

### Evidence — variance rerun (5 interleaved reps, 2026-07-28)

> ⚠️ These figures were produced by an eval harness that carried two scoring
> bugs since fixed in this PR (CodeRabbit review): asymmetric weekday matching
> in `resolveExpectedIso`, and delegate checks scoring the first (possibly
> rejected) `delegate` call rather than the final one. Both could only *under*-
> count self-correcting or bare-weekday turns. Re-run the harness with the fixes
> before citing these numbers for Acceptance.

Harness: `scripts/spikes/voice-brain-parity/` — Haiku 4.5, `stream()` + tools.
**19 utterances / ~50 assertion-checks × 5 reps.** Arms interleaved within
each rep. Calendar mock is load-bearing. Canonical artifact: `variance.json`
(incl. `paired`).

**Paired check-rate deltas** (preferred statistic):

| Comparison | mean Δ | per-rep Δ | paired win? |
|---|---|---|---|
| shared − baseline | **+0.068** | +0.04, +0.06, +0.02, +0.12, +0.10 | **yes (5/5 +)** |
| shared − full | **+0.072** | +0.06, +0.12, +0.06, +0.04, +0.08 | **yes (5/5 +)** |
| baseline − full | +0.004 | +0.02, +0.06, +0.04, −0.08, −0.02 | no |

Utterance-rate paired deltas tell the same story (shared − baseline mean
+0.158, 5/5 +).

**Marginal pass-rates** (secondary; ranges overlap even when paired wins):

| Arm | Prompt tokens (est.) | Check pass-rate mean [min, max] | Utterance pass-rate |
|---|---|---|---|
| baseline (prod slim + date-resolve) | ~656 | 0.888 [0.860, 0.920] | 0.737 [0.684, 0.789] |
| shared-hardening (+ routing, pronouns, off-ramp) | ~1 563 | 0.956 [0.900, 0.980] | 0.895 [0.789, 0.947] |
| full-consolidation | ~12 415 | 0.884 [0.840, 0.940] | 0.726 [0.632, 0.842] |

**Per-category paired Δ (shared − baseline)** and marginal rates:

| Category | paired Δ mean (signs) | paired win? | marginal shared / baseline |
|---|---|---|---|
| async-offramp | **+0.400** (5/5 +) | **yes** | 0.933 / 0.533 (also marginal ★) |
| routing-transfer-ownership | +0.075 (3+, 2×0) | no (≥4/5) | 1.000 / 0.925 |
| day-of-week-arithmetic | +0.067 (3+, 2×0) | no | 0.967 / 0.900 |
| pronoun-resolution | **0** (5×0) | no | 0.800 / 0.800 |
| honest-negative | −0.050 (1−, 4×0) | no | 0.950 / 1.000 |

**Focus cases** (utterance all-checks-pass / 5 reps):

| Case | baseline | shared | full |
|---|---|---|---|
| `pronoun-your-calendar` | 0/5 | 0/5 | 1/5 |
| `date-next-friday-meeting` | 2/5 | 5/5 | 0/5 |
| `date-next-tuesday` | 5/5 | 3/5 | 4/5 |

`pronoun-your` ("your calendar" → Avery) is a **known gap** — the pronoun
module earns nothing on this fixture until that case moves. Wrong-date-in-
brief failures (even after calling `date-resolve`) are tracked as #1612.

Bare-turn latency (prior interleaved microbench, 5 reps): baseline p50 TTFT
~526 ms; shared-hardening ~657 ms; full-consolidation ~782 ms. Full
consolidation remains ~25× the instruction tokens every spoken turn.

Outbound-context: both prototype arms inject `formatInjectionBlock` **once**
on the voice system-prompt path. Preserve that invariant.

### Async off-ramp design (required mitigation — handoff not done)

When a request exceeds live-call scope, voice should:

1. **Recognize** — heavyweight / long-running / clarification-loop /
   coordinator-depth (see `VOICE_ASYNC_OFFRAMP_GUIDANCE`).
2. **Offer** — natural spoken deferral.
3. **Hand off** — on agreement, call `async-offramp` with brief + follow-up
   channel. **Implementation required before Accept:** enqueue on the normal
   async dispatch path (coordinator task / inbound.message).
4. **Close the loop** — reach the principal on Signal/email when done.
   Never claim a follow-up that was not handed off.

Prompt module: `src/agents/prompts/voice-async-offramp.ts` (voice-only).
Eval currently measures recognition against a **mocked** tool only.

### Tentative resolution of #1563's blocking question

**Pending ADR acceptance:** if shared-hardening is Accepted (gates cleared),
text channels **may** use `LLMProvider.stream()` — convergence onto the
shared streaming primitive with separately composed prompts. Until then
Issue #1563 stays blocked on this decision.

### What is / is not in production on this branch

| Module | In eval shared-hardening arm | Wired into prod voice / coordinator |
|---|---|---|
| `DATE_RESOLVE_GUARDRAIL` | yes | **yes** (both; YAML has no pointer stub) |
| `ROUTING_DECISION_GUARDRAIL` | yes | **eligible to compose** (#1613) — modest paired benefit |
| `PRONOUN_RESOLUTION_GUARDRAIL` | yes | **hold** — zero paired benefit until `pronoun-your` moves (#1613) |
| `VOICE_ASYNC_OFFRAMP_GUIDANCE` + real `async-offramp` tool | guidance yes / tool mocked | **no** — real handoff (#1614) is an Accept + compose gate (compose per #1613) |

### Prompt-shape rule

Never put repo paths, ADR numbers, or "injected from …" plumbing into
model-visible prompts. Provenance belongs in code comments (`runtime.ts`).
The coordinator's sole `### Date & time` instruction is the composed
`DATE_RESOLVE_GUARDRAIL` module.

### Related issues

- #1612 — structural date-resolve → brief validation (orthogonal, high impact)
- #1613 — compose modules that **pay for themselves** (routing yes; pronoun hold; off-ramp after real handoff); supersedes bundled #1605
- #1614 — implement the real async off-ramp handoff (gate #3)
- #1563 — text → streaming (unblocks on Accept)

## Consequences (if Accepted)

- Voice stays a curated subset brain (ADR-037) **plus** shared guardrail
  modules **plus** a real async off-ramp — no full YAML on the spoken path.
- Guardrail drift is structural: channel-agnostic rules live in
  `src/agents/prompts/`. Copy-pasting coordinator lines into `VOICE_*` is
  out of policy.
- Text → streaming (#1563) unblocks on acceptance.
- Full consolidation remains rejected unless a later variance run shows a
  failure mode that uniquely requires the full YAML *and* cannot be closed by
  shared modules + off-ramp + #1612.
- Spike harness retained under `scripts/spikes/voice-brain-parity/` (`REPS=N`
  for variance).
