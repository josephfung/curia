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
each rep. Calendar mock is load-bearing. Canonical artifact: `variance-adr038.json`
(`variance.json` now holds the #1968 rerun)
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

> **Annotation (2026-10-22, #1968): these latency figures exclude tool
> definitions.** The microbench sent `tools: []`, while every production spoken
> turn carried the coordinator's 73 pinned tools plus `async-offramp` (~23.5k
> tokens). Tools were most of the request, so the "~19×" ratio overstated
> consolidation's cost: with tools counted, full consolidation added roughly
> 50% per turn, not 19×. Measured with tools, cold and warm, in the
> [2026-10-22 addendum](#addendum-2026-10-22--slim-core-rerun-1968).

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

## Addendum (2026-10-22) — slim-core rerun (#1968)

**Full consolidation stays rejected for the production voice model.** The question was
reopened once the coordinator context diet (#1954) had thinned the coordinator prompt:
could voice run on the coordinator's core plus a voice module, instead of a separately
maintained voice prompt? The rerun covered two placements of the voice module and three
models.
- On claude-haiku-4-5, prod's voice model, both placements score below the voice
  prompts.
- On claude-haiku-5-5 and claude-sonnet-5-5, the better placement ties them. Haiku 5.5
  was run twice: at its default thinking, and at `effort: none`, which is what voice sends.
- No model shows a quality gain that would justify consolidation's cost.
- Haiku 5.5 is only viable for voice at `none`. At its default effort, the first spoken
  word comes 2.4–3.5 s into the turn (p50).

### What was measured

- **Harness** (`scripts/spikes/voice-brain-parity/`, `production-context.ts`).
  - Every arm gets the production specialist roster and voice's real tool definitions.
  - `delegate` is scored on its real `agent`/`task`/`outbound_entry_id` arguments.
  - So absolute rates are not comparable with the July run above; the paired deltas
    within each run are.
  - Every call's usage is metered and priced from the model registry.
- **Arms.**
  - `baseline` is the production voice prompt.
  - `shared-hardening` is baseline plus the held routing and pronoun modules.
  - `slim-core` is the coordinator's production system string (`assembleAgent` +
    `buildBaseSystemPrompt`, #1966), with the voice module heading the caller's message
    as turn guidance (#1959). The voice module is the spoken-style addendum, the
    tool-result policy, the off-ramp, and the voice length reminder.
  - `slim-core-system` is the same core with the voice module and outbound context
    appended to the system string, where the voice prompt keeps them. That is the shape
    a voice migration would most likely ship.
  - Full consolidation was not rerun.
- **Run.** 19 utterances × 4 arms × 5 interleaved reps per model. Artifacts:
  `variance.json` (haiku-4-5), `variance.claude-haiku-5-5.json`,
  `variance.claude-haiku-5-5.effort-none.json`, `variance.claude-sonnet-5-5.json`.
  - **Effort.** The first runs sent no reasoning option (`VOICE_SPIKE_EFFORT` unset), so
    both 5.5 models ran at their default adaptive effort. Voice's turn runner sends
    `reasoning: NO_REASONING`, which on haiku-5-5 is `thinking: disabled` (ADR-048 §3).
    The `effort-none` run matches production: 0 reasoning tokens against ~14–19k per arm
    at the default. Haiku 4.5 is unaffected, since Curia sends it no thinking parameter.
    Sonnet 5.5 was run only at its default.
  - A first haiku-4-5 run without `slim-core-system` agreed in direction: slim-core −0.068
    against baseline, 0 reps positive.
- **Size.** The slim core renders at ~5.5k tokens of system string plus ~0.5k of voice
  module, against ~1.4k for the voice prompt. The core's always-on budget (YAML +
  SKILL.md, ~3.1k) leaves out its runtime blocks: security, contact details, roster,
  date guardrail, time and turn budget.
- **Spend.** $5.25 for the four spikes (haiku-4-5 $1.13, haiku-5-5 $0.21 at the default
  and $0.16 at `none`, sonnet-5-5 $3.75) and $3.19 for the four microbenches.

### Quality (paired check-rate Δ, mean and reps positive/negative of 5)

| Comparison | haiku-4-5 (prod) | haiku-5-5 default | haiku-5-5 `none` | sonnet-5-5 |
|---|---|---|---|---|
| slim-core − baseline | −0.028 (1+/4−) | −0.024 (0+/4−) | −0.032 (1+/3−) | +0.032 (3+/1−) |
| slim-core-system − baseline | −0.052 (1+/4−) | 0.000 (1+/1−) | +0.012 (2+/2−) | +0.028 (3+/2−) |
| slim-core − shared-hardening | −0.036 (0+/3−) | −0.028 (1+/4−) | −0.032 (2+/3−) | 0.000 (2+/3−) |
| slim-core-system − shared-hardening | −0.060 (0+/5−) | −0.004 (2+/2−) | +0.012 (3+/1−) | −0.004 (2+/3−) |
| slim-core-system − slim-core | −0.024 (2+/3−) | +0.024 (4+/1−) | **+0.044 (4+/0−)** | −0.004 (0+/1−) |
| shared-hardening − baseline | +0.008 (2+/3−) | +0.004 (2+/2−) | 0.000 (2+/2−) | +0.032 (3+/2−) |

The only paired win on check rate is `slim-core-system` over `slim-core` on haiku-5-5 at
`none`: on the coordinator core, the voice module belongs in the system string. Nothing
beats the voice prompts. On utterance rate the only paired win is shared-hardening over
baseline on sonnet-5-5 (+0.084, 4+/0−). Marginal check rates:

| Arm | haiku-4-5 | haiku-5-5 default | haiku-5-5 `none` | sonnet-5-5 |
|---|---|---|---|---|
| baseline | 0.944 | 0.968 | 0.960 | 0.912 |
| shared-hardening | 0.952 | 0.972 | 0.960 | 0.944 |
| slim-core | 0.916 | 0.944 | 0.928 | 0.944 |
| slim-core-system | 0.892 | 0.968 | 0.972 | 0.940 |

| Category (check rate, haiku-4-5) | baseline | shared | slim-core | slim-core-system |
|---|---|---|---|---|
| routing-transfer-ownership | 0.900 | 0.950 | **0.525** | 0.700 |
| outbound-context-ack | 1.000 | 1.000 | 1.000 | 0.800 |
| day-of-week-arithmetic | 1.000 | 0.983 | 1.000 | 0.900 |
| pronoun-resolution | 0.800 | 0.800 | 0.920 | 0.920 |

- **Transfer-ownership is a Haiku 4.5 failure.** With an active outbound entry and "Yes,
  Thursday works — go ahead and send it", slim-core on haiku-4-5 answered "I'll let the
  inbox team know to send that right away" and called no tool. Once it said "All set —
  I've sent it to Sam". Moving the module into the system string helps (0.525 → 0.700)
  but stays well below the voice prompts. On haiku-5-5 and sonnet-5-5 every arm scores
  0.925–1.0 here, with one exception. Slim-core on haiku-5-5 at `none` scores 0.850,
  with the same failure in 2 of 5 reps ("I'll pass your yes on Thursday to the inbox
  team", no tool). `slim-core-system` scores 1.0 there.
- **The core names tools voice does not carry.** On haiku-4-5, slim-core called
  `email-send` 3 times and `email-reply` once. They are described in the pinned
  SKILL.md bodies but are not in voice's tool list. In production that is a wasted
  round and a "not found" error. The voice prompts on haiku-4-5 called the `contacts`
  specialist as if it were a tool (5 times). The 5.5 models never called a tool they
  were not given.
- **The pronoun module needs thinking.** On `pronoun-your-calendar`, baseline passes 0/5
  on every model and effort. The held pronoun module (shared-hardening) passes 5/5 on both
  5.5 models at their default effort. It passes 0/5 on haiku-4-5, and 0/5 on haiku-5-5
  at `none`. Slim-core passes 2–5/5 at the default and 1/5 at `none`. So with thinking
  off, the module doesn't fix this case. The #1613 hold stands for voice at `none`.
- **Sonnet 5.5 struggles with dates in every arm.** `date-next-friday-meeting` passes
  1–2/5, so its higher scores elsewhere are not a uniform lift.

### Latency

**Spoken turns** (from the spikes: 95 turns per arm, real utterances, voice's tools).
"First speech" is the time from the start of the turn to the first spoken text, after any
tool rounds that came first. That is the silence the principal hears. These are p50 / p90
in ms, from `turnLatency` in each variance file.

| Arm | haiku-4-5 first speech | haiku-4-5 full turn | haiku-5-5 default first speech | haiku-5-5 `none` first speech | haiku-5-5 `none` full turn | sonnet-5-5 first speech |
|---|---|---|---|---|---|---|
| baseline | 393 / 1677 | 2195 / 4102 | 2383 / 4768 | 660 / 1267 | 2577 / 3793 | 3621 / 6356 |
| shared-hardening | 392 / 1603 | 2145 / 3921 | 2690 / 4900 | 662 / 1612 | 2498 / 4208 | 3574 / 6421 |
| slim-core | 377 / 487 | 2277 / 3979 | 3086 / 5237 | 646 / 1264 | 2067 / 3692 | 3783 / 6027 |
| slim-core-system | 388 / 1599 | 2236 / 3472 | 3459 / 6307 | 681 / 1356 | 2391 / 3920 | 3209 / 5871 |

- **Thinking decides whether Haiku 5.5 can take a call.** At its default effort, Haiku
  5.5 thinks, calls its tools, and only then speaks, so first speech is close to the full
  turn. At `none` it speaks within ~0.66 s and runs the tools after. That is about
  +270 ms over haiku-4-5 at p50. Full turns are within ±0.4 s of haiku-4-5's.
- **At `none` the prompt shape costs no first-speech time.** The four arms are within
  35 ms of each other at p50.
- The spikes ran one model after another, not interleaved, so read cross-model gaps as
  approximate.

**Single request** (microbench: TTFT p50 / p95 ms, 10 reps per cell, voice's tools unless
noted, one short utterance).

| Prompt | haiku-4-5 cold | haiku-4-5 warm | haiku-5-5 cold | haiku-5-5 warm | haiku-5-5 `none` cold | haiku-5-5 `none` warm | sonnet-5-5 cold | sonnet-5-5 warm |
|---|---|---|---|---|---|---|---|---|
| baseline + coordinator tools (voice before #1968) | 489 / 695 | 430 / 716 | 1274 / 2338 | 781 / 1519 | 1244 / 1815 | 811 / 3526 | 1823 / 6331 | 1016 / 1446 |
| baseline (voice after #1968) | 379 / 525 | 393 / 405 | 630 / 1213 | 633 / 1718 | 737 / 1080 | 651 / 1129 | 751 / 7582 | 666 / 5800 |
| shared-hardening | 374 / 669 | 389 / 486 | 714 / 1124 | 675 / 1742 | 652 / 1242 | 616 / 1600 | 1087 / 1500 | 827 / 1414 |
| slim-core | 416 / 500 | 368 / 925 | 956 / 1858 | 725 / 1271 | 895 / 1538 | 661 / 1200 | 1091 / 2267 | 870 / 1310 |
| slim-core-system | 402 / 589 | 359 / 492 | 865 / 2092 | 697 / 1262 | 837 / 1571 | 591 / 799 | 1426 / 8040 | 933 / 7617 |

- **Cold vs warm.** Cold means a fresh nonce in the first tool and the system string, so
  the whole prefix is a cache write. Warm is the same request again, read from cache. p95
  is the slowest of 10.
- **The toolset change pays most on the newer models.** It cuts cold p50 by ~110 ms on
  haiku-4-5 and ~640 ms on haiku-5-5. An earlier haiku-4-5 bench measured 565 → 396 ms.
- **The slim core costs time cold on haiku-5-5:** about +100–235 ms p50 (+100 at
  `none`). Warm, the gap is under 100 ms.
- **The microbench does not exercise thinking.** Its one utterance ("Thanks, that is all
  for now.") gets a 16–19 token reply even at the default effort, so Haiku 5.5's adaptive
  thinking stays off and the default and `none` columns differ only by noise. The spike
  table is the one that shows thinking's cost.
- **Sonnet 5.5's cold first token is too slow for a live call** in any arm, with p95
  outliers of 6–8 s.

### Decision

- **Production (haiku-4-5).** Both slim-core placements trail the voice prompts. On this
  model voice stays on its own prompt (ADR-037, this ADR).
- **Voice moves to haiku-5-5 at `effort: none`** (#2245). The principal accepts the
  move's latency and cost trade-off.
  - First speech goes from ~390 to ~660 ms p50. Per-token price drops about 8×, and the
    `none` spike cost $0.16 against $1.13 for haiku-4-5.
  - `none` is what voice's turn runner already sends. The default effort is ruled out:
    first speech is 2.4–3.5 s p50. `low` is unmeasured, and #2245 decides whether a rerun
    at `low` is worth it, for the pronoun case above.
  - **Prompt shape is for #2245.** At `none`, `slim-core-system` ties the voice prompt and
    the shared modules: +0.012 against each (2+/2− and 3+/1−).
    It adds no first-speech time in the spike, ~+100 ms cold in the microbench, and ~1.45×
    the spend per turn. Under #1968's rule ("ties or beats the shared modules, with TTFT
    within an agreed budget"), it qualifies. The choice is whether one prompt instead of
    two is worth that cost. If the core is used, the voice module goes in the system
    string, not the turn guidance.
- **Sonnet 5.5** is not a voice candidate at its default effort: first speech is 3.2–3.8 s
  p50. It was not run at `none`. Its single-request TTFT is still the slowest of the
  three, so it is not pursued.
- **The voice toolset ships** (#1968): `VOICE_TOOL_NAMES` in
  `src/channels/voice/voice-tools.ts`, derived from production voice sessions, with no
  discovery tools. It is 9 tools (~3.6k tokens) instead of 74 (~23.5k).
- **#1613.** The routing and pronoun modules stay on hold. Their bundle ties baseline on
  haiku-4-5, and on haiku-5-5 at `none`. The pronoun module solves
  `pronoun-your-calendar` only when Haiku 5.5 thinks.
