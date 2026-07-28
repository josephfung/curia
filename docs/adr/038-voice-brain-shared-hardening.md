# ADR-038: Voice brain parity — shared-hardening vs full consolidation

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

## Decision

**Reject full consolidation** as the voice brain direction — the ~19×
instruction-token cost alone carries that rejection (latency microbench +
prompt-size estimates). On quality it does not win either: full-consolidation
trails shared-hardening (Δ +0.044, not a paired win) and is roughly tied with
baseline, while carrying that token load on every spoken turn.

**Accept shared-hardening.** All three gates below are now cleared (quality
evidence, #1612 date-in-brief, #1614 off-ramp handoff). Compose modules **per
measured benefit, not as a bundle**. Gates:

1. **Quality claim (paired, not marginal).** Across 5 interleaved reps
   (corrected harness), the `shared − baseline` **check-rate** delta is +0.036
   (4/5 reps positive, one negative) — **not** a check-level paired win; the
   **utterance-rate** delta is +0.105 (4/5 positive, none negative) — a paired
   win, but thin. Either way it is **entirely carried by `async-offramp`** (the
   only category paired win), a still-**mocked** capability. Net of off-ramp:
   routing is marginal (+0.075, not a win), pronoun is **zero**, day-of-week is a
   **tie**, and the bundle **regressed** honest-negative (−0.05). So each module
   must earn compose on its own benefit — there is no bundled "shared-hardening
   wins" claim.
2. **`date-resolve` → brief handoff is a structural bug, not a prompt gap**
   (#1612). The guardrail induces the tool call; the model can still put a
   wrong date in the delegate brief. Fix calendar/delegate validation
   orthogonally (and preferably before Accept).
3. **Off-ramp acceptance gates on a real handoff**, not mock recognition.
   `VOICE_ASYNC_OFFRAMP_GUIDANCE` + fixture `mustCallTools: ["async-offramp"]`
   measure recognition only. Acceptance requires an `async-offramp` tool that
   actually enqueues coordinator work and reaches the principal on
   Signal/email. **Shipped in #1614** — compose into production voice is now
   safe.

### Per-module compose gates (#1605 reframed)

Baseline already composes `DATE_RESOLVE_GUARDRAIL`. The shared-hardening
eval arm adds routing + pronouns + off-ramp. Gate each production compose
on its own measured benefit — do **not** ship the bundle:

| Module | Paired evidence vs baseline (corrected harness) | Production compose |
|---|---|---|
| **Routing** (`ROUTING_DECISION_GUARDRAIL`) | transfer-ownership Δ +0.075 (3/5 +, 2/5 0) — **not** a ≥4/5 paired win | **Hold** — no clean win, and the bundle it rides in regresses honest-negative (#1613) |
| **Pronoun** (`PRONOUN_RESOLUTION_GUARDRAIL`) | Δ identically **0**; `pronoun-your` 0/5 — yet full-consolidation solves it 5/5, so the case is solvable, the module just doesn't | **Hold** — pure token cost today (#1613) |
| **Off-ramp** (`VOICE_ASYNC_OFFRAMP_GUIDANCE`) | historical paired win (Δ +0.267, 5/5 +) measured while tool was mocked and baseline lacked the module | **Compose** with real handoff (#1614). Production baseline now includes it — fresh paired runs no longer isolate an off-ramp delta; archive the pre-compose evidence |
| **Date-resolve** (already in prod) | wash / distraction risk (`date-next-friday` ↑, `date-next-tuesday` ↓ 5/5→4/5) | Keep; close handoff via **#1612**, not more prompt text |
| **Bundle cost** | stacking the modules **regressed** honest-negative (−0.05; shared 2 fails vs baseline 0) | Real cost of composing more instruction — weigh per module, not as a bundle |

### Evidence — variance rerun (5 interleaved reps, 2026-07-28, corrected harness)

> Re-run after the CodeRabbit harness fixes (symmetric weekday matching in
> `resolveExpectedIso`; delegate checks now score the final delegate call, not
> the first/rejected one). Those fixes removed false-negatives that had inflated
> the `shared − baseline` gap — the corrected delta is roughly half the earlier
> draft's, and it surfaced an honest-negative regression the buggy harness hid.

Harness: `scripts/spikes/voice-brain-parity/` — Haiku 4.5, `stream()` + tools.
**19 utterances / ~50 assertion-checks × 5 reps.** Arms interleaved within
each rep. Calendar mock is load-bearing. Canonical artifact: `variance.json`
(incl. `paired`).

**Paired check-rate deltas** (preferred statistic):

| Comparison | mean Δ | per-rep Δ | paired win? |
|---|---|---|---|
| shared − baseline | **+0.036** | +0.06, +0.04, +0.06, +0.04, −0.02 | no (4/5 +, 1 −) |
| shared − full | +0.044 | +0.04, +0.04, +0.16, 0, −0.02 | no (3/5 +) |
| baseline − full | +0.008 | −0.02, 0, +0.10, −0.04, 0 | no |

Utterance-rate is the stronger signal: shared − baseline mean **+0.105**,
per-rep +0.158, +0.105, +0.158, +0.105, 0 — **a paired win** (4/5 +, none −).
So the edge is real at the utterance level but thin, and (below) concentrated
in a single category.

**Marginal pass-rates** (secondary; ranges overlap even when paired wins):

| Arm | Prompt tokens (est.) | Check pass-rate mean [min, max] | Utterance pass-rate |
|---|---|---|---|
| baseline (prod slim + date-resolve) | ~665 | 0.912 [0.880, 0.940] | 0.789 [0.737, 0.842] |
| shared-hardening (+ routing, pronouns, off-ramp) | ~1 572 | 0.948 [0.920, 0.980] | 0.895 [0.842, 0.947] |
| full-consolidation | ~12 606 | 0.904 [0.820, 0.960] | 0.811 [0.684, 0.895] |

**Per-category paired Δ (shared − baseline)** and marginal rates:

| Category | paired Δ (shared − baseline) | paired win? | marginal shared / baseline / full |
|---|---|---|---|
| async-offramp | **+0.267** (5/5 +) | **yes** | 0.967 / 0.700 / 0.767 |
| routing-transfer-ownership | +0.075 (3/5 +, 2×0) | no | 0.975 / 0.900 / 0.875 |
| day-of-week-arithmetic | 0 (1+, 1−, 3×0) | no | 0.933 / 0.933 / 0.883 |
| pronoun-resolution | **0** (5×0) | no | 0.800 / 0.800 / **0.960** |
| honest-negative | **−0.050** (1×−0.25, 4×0) | no (regression) | 0.950 / **1.000** / 0.900 |

**Focus cases** (utterance all-checks-pass / 5 reps):

| Case | baseline | shared | full |
|---|---|---|---|
| `pronoun-your-calendar` | 0/5 | 0/5 | **5/5** |
| `date-next-friday-meeting` | 3/5 | 4/5 | 3/5 |
| `date-next-tuesday` | 5/5 | 4/5 | 4/5 |

`pronoun-your` ("your calendar" → Avery): the pronoun module earns nothing
(0/5, same as baseline), yet full-consolidation nails it 5/5 — the case is
solvable, the extracted module just doesn't do it. `date-next-tuesday` even
regressed under shared (5/5 → 4/5). Wrong-date-in-brief failures (even after
calling `date-resolve`) are tracked as #1612.

Bare-turn latency (prior interleaved microbench, not re-run — prompt sizes
barely changed): baseline p50 TTFT ~526 ms; shared-hardening ~657 ms;
full-consolidation ~782 ms. Full consolidation remains ~19× the instruction
tokens every spoken turn.

Outbound-context: both prototype arms inject `formatInjectionBlock` **once**
on the voice system-prompt path. Preserve that invariant.

### Async off-ramp design (required mitigation — handoff shipped in #1614)

When a request exceeds live-call scope, voice should:

1. **Recognize** — heavyweight / long-running / clarification-loop /
   coordinator-depth (see `VOICE_ASYNC_OFFRAMP_GUIDANCE`).
2. **Offer** — natural spoken deferral.
3. **Hand off** — on agreement, call `async-offramp` with brief + follow-up
   channel. The real tool (`skills/async-offramp/`) enqueues a coordinator
   `agent.task` on the normal dispatch path (voice re-enters the path it
   bypasses at `dispatcher.ts`).
4. **Close the loop** — the async coordinator reaches the principal on
   Signal/email via existing send skills. Never claim a follow-up that was
   not handed off (tool returns `success: false` on enqueue failure).

Prompt module: `src/agents/prompts/voice-async-offramp.ts` (voice-only).
Tool: `skills/async-offramp/` — injected by the voice tool bridge
(`src/index.ts`), **not** pinned on the coordinator (the async destination
must not advertise a recursive off-ramp). Excluded from text-turn discovery;
handler rejects non-voice `channelId`.
Eval scores against the **real** handler (spike `invokeTool`), not a mock.

### Resolution of #1563's blocking question

Shared-hardening is **Accepted** (all gates cleared), so text channels **may**
use `LLMProvider.stream()` — convergence onto the shared streaming primitive
with separately composed prompts. **#1563 is unblocked** and is the follow-up.

### What is / is not in production on this branch

| Module | In eval shared-hardening arm | Wired into prod voice / coordinator |
|---|---|---|
| `DATE_RESOLVE_GUARDRAIL` | yes | **yes** (both; YAML has no pointer stub) |
| `ROUTING_DECISION_GUARDRAIL` | yes | **hold** (#1613) — no clean paired win; +0.075 transfer only |
| `PRONOUN_RESOLUTION_GUARDRAIL` | yes | **hold** — zero paired benefit until `pronoun-your` moves (#1613) |
| `VOICE_ASYNC_OFFRAMP_GUIDANCE` + real `async-offramp` tool | yes / real tool | **yes** (voice compose + voice-bridge tool — #1614; Accept gate #3 cleared). Not a coordinator pin — injected by the voice tool bridge only |

### Prompt-shape rule

Never put repo paths, ADR numbers, or "injected from …" plumbing into
model-visible prompts. Provenance belongs in code comments (`runtime.ts`).
The coordinator's sole `### Date & time` instruction is the composed
`DATE_RESOLVE_GUARDRAIL` module.

### Related issues

- #1612 — structural date-resolve → brief validation (orthogonal, high impact)
- #1613 — compose modules that **pay for themselves** (routing/pronoun still HOLD; off-ramp compose landed with #1614 once the real handoff existed); supersedes bundled #1605
- #1614 — implement the real async off-ramp handoff (gate #3) — **done**
- #1563 — text → streaming (unblocks on Accept)

## Consequences

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
