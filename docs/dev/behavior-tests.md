# Behavior tests: writing and running them

How to develop and triage Curia's behavior tests: the scenario suite (`pnpm scenarios`), run against real models. This page holds the rules. `tests/scenarios/README.md` holds the mechanics: the case schema, stubs, fixtures and the runner's flags.

These rules came out of the v0.45.0 release gate. Most of its failures were the tests, not the product: stale dates, a judge misread, a stub that contradicted its prompt, a harness change that broke another case, and a case that passed one day and failed the next with no code change. Every rule below exists to stop one of those.

## Two instruments: the gate and evals

| | Gate | Evals |
|---|---|---|
| **Purpose** | Catch regressions in behavior that would hurt the principal | Steer development of fuzzy behavior (finesse, judgment) |
| **Size** | Small: only the behaviors that matter | As large as is useful |
| **Checks** | Deterministic first; judged only where nothing else works | Rates per layer (decision, voice); judged where needed |
| **Runs** | Each case 5 times, against a pass rate: every run (`pass_rate: 1`) for safety cases, 4 of 5 for the rest (`tests/scenarios/README.md`, "The gate") | A slice of cases while iterating; the full set at checkpoints |
| **Blocks** | A release, when a case falls below its threshold | Nothing |

A case is `release_gate: false` unless it belongs in the gate. Most new cases are evals or on-demand checks.

**Graduation.** An eval case moves into the gate only when all of these hold:
- its behavior has shipped;
- it holds steadily, about 90% or more over 10 runs;
- its critical behaviors are deterministic checks.

It goes in as the smallest version that still protects the behavior.

**What belongs in the gate:** never leaking personal data, never sending without approval, never acting for an outsider, the principal being able to direct, Curia's core jobs (scheduling, triage, replies, follow-ups), and honest reporting. Behavior enforced in code is tested with unit and integration tests, not here.

## Writing a case

1. **Prefer a deterministic check.** Assert on tool calls, their arguments and gateway outcomes (`check:`, `gateway:`). Use a judged behavior only when nothing in the run's actions can show it. Write its criteria so two people would grade the same transcript the same way. "Warm", "appropriate" and "concise" don't pass that test; "names the meeting and the new time" does.
2. **Make each critical check able to fail.** Picture the wrong run and confirm the check catches it. A check bound to "any send" passes a send to the wrong person.
3. **Date everything relative to the run.** Use the placeholders (`{{at:now+5m}}`, `{{day:next-monday}}`, `workday+N`), never a fixed date. Avoid wording that only works on some days: "next Thursday" and "next week" can mean the same day on a Thursday.
4. **Never let a stub contradict the prompt.** If the message says "50 unread", the stub inbox has 50, or the message doesn't say it. Read the case's message against its stubs before running it.
5. **Leave the wrong paths open.** Stub the tools a wrong answer would use, so the mistake shows up as a call instead of a refused stub.
6. **Don't add a harness option to make one case pass.** Change the case or delete it. An option for a single case is how the harness grew past the product code that it tests.
7. **Say why** in a comment at the top: what the case guards, and the issue or incident behind it.

## Running cases

Every run bills real model calls (CLAUDE.md "Testing").
- Get the maintainer's agreement first, naming the cases, the run count and the estimated cost.
- Run only the cases your change touches.
- Report the spend afterwards.

The gate runs on `main` and at release, never as a mid-branch "did anything else break" check.

**The weekly run.** `.github/workflows/behavior-gate.yml` runs the gate on `main` every Sunday at about 11:20 UTC, on a fresh database (`tests/scenarios/ci-setup.ts`), and posts its summary on the pinned tracking issue, #2663. A red run is triaged as below. Its transcripts are the run's `behavior-gate-results` artifact, and are the baseline to compare the next run against. At release, if `main` has not moved since the latest weekly run, that run is the behavior gate; otherwise dispatch the workflow on the release commit (Actions → Behavior gate (weekly) → Run workflow). It uses its own OpenRouter and OpenAI keys, in the `behavior-tests` environment, each with a monthly credit limit.

## Triage

**Deterministic failure.** A check in code failed, so this is a bug in the product or in the case. Root-cause it, time-boxed to about an hour. Then:
- if the case is wrong, fix the case;
- if the product is wrong, fix the product;
- if it isn't solved inside the hour, file an issue.

**LLM-judged or nondeterministic case below its threshold.**
- Compare its pass rate with its last baseline before reading a single transcript.
- A drop from the baseline is a regression: find the change that caused it.
- A rate that has always been low is a weak case, not a new bug. Fix the case's criteria, or move it out of the gate.
- Never root-cause one failed run of a nondeterministic case.

**Don't tune the product to a case.** If a product rule changes only so that one case passes, it's a product decision. Name it and take it to the maintainer.

**Changes to existing cases** need the same review as product code. A loosened check is a weaker gate.

## Evals (finesse, judgment)

- **The target is a rate on a task, not a pass on a case.** For example: "the rescheduling task's decision score from 41% to 70%".
- **Iterate on a slice.** Run one task's cases about three times each while working. Run the full set only at checkpoints, to catch knock-on effects.
- **Fix root causes.** A fix should move a task, not one case. Place it on the highest rung that works ([ADR-046](../adr/046-agent-behavior-fix-placement.md)).
- **Keep a held-out case per task.** Don't tune against it; check after each round that the fix carries over to it as well.
- **Humans grade voice until a judge agrees with them.** Measure judge agreement against human grades before trusting a judged score (the finesse baseline found κ 0.06–0.31).
- **An eval never blocks a merge or a release.**
