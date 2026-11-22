# Finesse baseline: after the EA review

Working note · Issue #2556 · 2026-11-21 · Draft

The second baseline: the 46 finesse cases as revised from the six EA reviews (`docs/wip/2026-11-21-finesse-ea-review-synthesis.md`), before any product fix. It follows the pre-feedback run (`docs/wip/2026-11-14-finesse-baseline.md`), and it is the baseline the grading round and the judge choice use.

## Summary

- **The overall level hasn't moved.** Decision averaged 70% (70% on 11-14) and voice 44% (48%). 12 of 46 cases passed every critical behavior, up from 7 of 45.
- **The averages hide large swings both ways.** Up: 53a (15% → 84%), 51c (34% → 73%), 53d (57% → 82%). Down: 52c (62% → 19%), 54e (83% → 46%), 59b (87% → 54%), 53e (59% → 32%). Most cases were graded differently this time: "telling Avery" in every case, the other side's reply in 51b, 52b and 54c, and who writes in seven cases whose YAML had missed the 11-14 rule. So a case's score isn't strictly comparable across the two runs. The trace-level diagnosis of the drops is pending.
- **Voice is still the weak layer.** Rescheduling (task 51) and running late (task 52) are lowest, at 15% and 17%.
- **The lookup gap remains.** Information level 4 (only a web search shows who someone is) scored 42% decision, 33% voice.
- **The new excuse case (51g) scores 51%.** Asked outright for an excuse, Curia mostly refused or asked instead of writing one.

## What was run

| | |
|---|---|
| Cases | 46 finesse cases, tasks 50–59 (51g new), all `release_gate: false` |
| Runs | 5 per case (230) |
| Model | `deepseek/deepseek-v4.1-flash`, real delegation to specialists |
| Autonomy | 84, band gating (each case's fixture) |
| Identity | `finesse` fixture: neutral office tone, three standing preferences |
| Judge | `openai/gpt-4o` (the suite default) |
| Results | `tests/scenarios/results/2026-11-21-finesse-baseline-combined.json` (local): 15 cases from the first full run, 34 re-run (see below) |
| Time, cost | $13.44 in all: $7.48 for the full run, then $5.96 to re-run 34 cases |

**Why 34 cases were re-run.** The machine was an Intel Mac, where `onnxruntime-node` has no native binding (#2706). Entity memory was therefore off, and every `query-relationships` call (the contacts specialist checking how people are connected) was refused. On 11-14 those calls passed through and returned an empty list. The fix stubs the call in `finesse-office` with that same empty answer, and the 34 cases that had called it were re-run. Two consequences:

- The 15 cases kept from the first run carry the setup hash from before that stub. They never called the tool, so their behavior is unaffected. A re-score that checks hashes will see them as changed.
- 57e's coordinator called `decay-warnings-list` once, refused for the same reason. It is allowed in `stub-coverage.json`, citing #2706.

A review after the runs found that calendar listings were replayed twice. The branch's own replay of moves and cancellations duplicated one main already does (#2588). That fix is in, but these runs had the duplicate. Its effect was small: of 528 stubbed listings, one (a single 53e run) showed an event twice, and none of the 10 events created across all runs appeared in a later listing.

The first run also caught six cases that forbid sending Avery's draft while `finesse-office` refused the send. Those cases now stub a succeeding send, so the forbidden path is open to be chosen.

## Results

### By task

| Task | Cases | Passed | Decision | Voice | 11-14 decision | 11-14 voice |
|---|---|---|---|---|---|---|
| 50 An attendee drops out | 4 | 2 | 90% | 56% | 73% | 49% |
| 51 Rescheduling | 7 | 0 | 50% | 15% | 41% | 10% |
| 52 Running late | 5 | 1 | 59% | 17% | 76% | 26% |
| 53 Asking for time | 5 | 1 | 63% | 57% | 47% | 48% |
| 54 Nudging after no reply | 5 | 2 | 85% | 53% | 92% | 68% |
| 55 Declining a request for time | 4 | 1 | 85% | 43% | 87% | 54% |
| 56 Declining an invitation | 3 | 2 | 86% | 78% | 91% | 77% |
| 57 Family and household | 5 | 1 | 62% | 51% | 66% | 49% |
| 58 Mixed audiences | 3 | 2 | 85% | 71% | 85% | 82% |
| 59 A casual invitation | 5 | 0 | 58% | 36% | 68% | 54% |
| **All** | **46** | **12** | **70%** | **44%** | **70%** | **48%** |

A case passes when every critical behavior fully passed in at least 80% of runs. Passed: 50a, 50c, 52e, 53b, 54a, 54b, 55d, 56a, 56b, 57e, 58b, 58c.

### By information level

| Level | How Curia could know | Cases | Passed | Decision | Voice |
|---|---|---|---|---|---|
| 1 | Stated in the request | 5 | 3 | 79% | 54% |
| 2 | Contact record only | 20 | 5 | 74% | 45% |
| 3 | Notes or memory only | 12 | 3 | 71% | 41% |
| 4 | Only by looking it up | 3 | 0 | 42% | 33% |
| 5 | Only from earlier threads | 3 | 0 | 48% | 33% |

Three cases (54b, 55b, 57b) mark no level in their file and are left out.

### By case

Weighted score over the case's behaviors; **pass** means every critical behavior met the 80% bar.

| Case | | 11-14 | 11-21 |
|---|---|---|---|
| 50a | drops out of board update | 68% | **pass** 81% |
| 50b | drops out of board deep dive | 58% | 75% |
| 50c | drops out of one-on-one | 80% | **pass** 91% |
| 50d | drops out of vendor demo | 63% | 85% |
| 51a | reschedules a direct report | 35% | 31% |
| 51b | reschedules an agency | 15% | 32% |
| 51c | reschedules the board chair | 34% | 73% |
| 51d | reschedules an unknown vc | 13% | 34% |
| 51e | reschedules a friend | 20% | 24% |
| 51f | leaves the chair's meeting early | 68% | 48% |
| 51g | excuse on request | new | 51% |
| 52a | late to team stand-up | 50% | 50% |
| 52b | late to board chair one-on-one | 66% | 61% |
| 52c | late to largest customer | 62% | 19% |
| 52d | late to lunch with a friend | 72% | 44% |
| 52e | two minutes late to stand-up | **pass** 58% | **pass** 62% |
| 53a | ask time with direct report | 15% | 84% |
| 53b | ask time with prospective investor | 66% | **pass** 80% |
| 53c | ask time with prominent stranger | 41% | 33% |
| 53d | ask time with friend | 57% | 82% |
| 53e | ask time with peer ceo | 59% | 32% |
| 54a | nudge investor too soon | 79% | **pass** 100% |
| 54b | nudge investor with deadline | **pass** 84% | **pass** 79% |
| 54c | nudge late agency | 87% | 79% |
| 54d | nudge late direct report | 94% | 81% |
| 54e | nudge prospective investor | 83% | 46% |
| 55a | decline persistent salesperson | 89% | 82% |
| 55b | decline board chair nephew | 53% | 48% |
| 55c | decline former colleague | 77% | 76% |
| 55d | largest customer asks for time | **pass** 98% | **pass** 100% |
| 56a | decline conference panel | **pass** 100% | **pass** 99% |
| 56b | decline board chair gala | 85% | **pass** 87% |
| 56c | friend wedding invitation | 80% | 67% |
| 57a | ruth asks about sunday dinner | 89% | 96% |
| 57b | move ruth's visit | 80% | 74% |
| 57c | move parent-teacher conference | 18% | 20% |
| 57d | move contractor walk-through | 23% | 13% |
| 57e | ruth's birthday | **pass** 90% | **pass** 88% |
| 58a | board agenda with staff copied | 52% | 46% |
| 58b | customer follow-up with sales copied | **pass** 100% | **pass** 100% |
| 58c | dinner invitation to mixed guests | **pass** 100% | **pass** 99% |
| 59a | casual invite from lead investor | 51% | 46% |
| 59b | casual invite from board chair | 87% | 54% |
| 59c | casual invite from unknown vc | 58% | 58% |
| 59d | casual invite from friend | 62% | 58% |
| 59e | casual invite from salesperson | 59% | 57% |

### Blind identification

Not reported for this baseline. The measure compares a group's messages within one run, and the groups were split across the full run and the re-runs.

## Grading round

A 25-item voice sheet is sampled from this baseline, one item per case across all ten tasks (`pnpm grading sample … --seed finesse-2026-11-21`, local beside the results). The owner and one or two EAs grade the same items. That gives human-to-human agreement first, then each judge's agreement with the graders (`pnpm grading agree --current-cases`).

## Pending

1. **Diagnose the large movers** (52c, 54e, 59b, 53e down; 53a, 51c up) from the transcripts. Separate rubric changes from behavior.
2. **Grading round and judge choice**, as above. Set `TAG_JUDGE_MODELS.finesse`.
3. **Product fixes.** The follow-ups in the Finesse & Judgement milestone (#2607–#2610, #2612–#2614) are measured against this baseline.
4. **Final report (§5b)**, from the 11-14 note's plan.
