# Finesse benchmark v0.1: baseline

Working note · Issue #2556 · 2026-11-21 · Draft

The finesse benchmark is the 46 scenario cases written from the casebook (`docs/wip/2026-11-10-finesse-casebook.md`), as revised from six executive assistants' reviews (`docs/wip/2026-11-21-finesse-ea-review-synthesis.md`). This note is its v0.1 baseline, measured before any product fix. Later work is compared against it.

**Versioning.** v0.1 was provisional: its judge (gpt-4o, the suite default) had not been checked against human grades. The grading round below picked `anthropic/claude-opus-5.5` (`TAG_JUDGE_MODELS.finesse`) and settled two criteria, and that makes the benchmark v1. v1's baseline is these transcripts re-judged by Opus (pending). After that, a change to a case's setup or criteria, or to the judge, means a new version and a new baseline, not a re-score against this one.

## Summary

- **Curia decides better than it writes.** Decision averaged 70% and voice 44%. 12 of 46 cases passed every critical behavior.
- **Rescheduling and running late are weakest.** Task 51 scored 15% on voice and task 52 17%.
- **Curia rarely looks people up.** At information level 4 (only a web search shows who someone is), decision scored 42% and voice 33%.
- **The new excuse case (51g) scores 51%.** Asked outright for an excuse, Curia mostly refused or asked instead of writing one.
- **Before the review**, a pilot run of the draft casebook (2026-11-14, 45 cases) scored about the same overall: decision 70%, voice 48%, 7 cases passing. Its cases were graded differently, so it isn't a baseline. What it taught is under Background.

## What was run

| | |
|---|---|
| Cases | 46 finesse cases, tasks 50–59, all `release_gate: false` |
| Runs | 5 per case (230) |
| Model | `deepseek/deepseek-v4.1-flash`, real delegation to specialists |
| Autonomy | 84, band gating (each case's fixture) |
| Identity | `finesse` fixture: neutral office tone, three standing preferences |
| Judge | `openai/gpt-4o` (the suite default) |
| Results | `tests/scenarios/results/2026-11-21-finesse-baseline-combined.json` (local): 15 cases from the first full run, 34 re-run (see below) |
| Time, cost | $13.44 in all: $7.48 for the full run, then $5.96 to re-run 34 cases |

**Why 34 cases were re-run.** The machine was an Intel Mac, where `onnxruntime-node` has no native binding (#2706). Entity memory was therefore off, and every `query-relationships` call (the contacts specialist checking how people are connected) was refused. On a machine with entity memory those calls return an empty list, since no case seeds a relationship. The fix stubs the call in `finesse-office` with that same empty answer, and the 34 cases that had called it were re-run. Two consequences:

- The 15 cases kept from the first run carry the setup hash from before that stub. They never called the tool, so their behavior is unaffected. A re-score that checks hashes will see them as changed.
- 57e's coordinator called `decay-warnings-list` once, refused for the same reason. It is allowed in `stub-coverage.json`, citing #2706.

A review after the runs found that calendar listings were replayed twice. The branch's own replay of moves and cancellations duplicated one main already does (#2588). That fix is in, but these runs had the duplicate. Its effect was small: of 528 stubbed listings, one (a single 53e run) showed an event twice, and none of the 10 events created across all runs appeared in a later listing.

The first run also caught six cases that forbid sending Avery's draft while `finesse-office` refused the send. Those cases now stub a succeeding send, so the forbidden path is open to be chosen.

## Results

### By task

| Task | Cases | Passed | Decision | Voice |
|---|---|---|---|---|
| 50 An attendee drops out | 4 | 2 | 90% | 56% |
| 51 Rescheduling | 7 | 0 | 50% | 15% |
| 52 Running late | 5 | 1 | 59% | 17% |
| 53 Asking for time | 5 | 1 | 63% | 57% |
| 54 Nudging after no reply | 5 | 2 | 85% | 53% |
| 55 Declining a request for time | 4 | 1 | 85% | 43% |
| 56 Declining an invitation | 3 | 2 | 86% | 78% |
| 57 Family and household | 5 | 1 | 62% | 51% |
| 58 Mixed audiences | 3 | 2 | 85% | 71% |
| 59 A casual invitation | 5 | 0 | 58% | 36% |
| **All** | **46** | **12** | **70%** | **44%** |

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

Score is the weighted mean over the case's behaviors; **pass** means every critical behavior met the 80% bar.

| Case | | Score | Decision | Voice |
|---|---|---|---|---|
| 50a | drops out of board update | **pass** 81% | 89% | 50% |
| 50b | drops out of board deep dive | 75% | 80% | 55% |
| 50c | drops out of one-on-one | **pass** 91% | 93% | 80% |
| 50d | drops out of vendor demo | 85% | 95% | 40% |
| 51a | reschedules a direct report | 31% | 41% | 0% |
| 51b | reschedules an agency | 32% | 34% | 20% |
| 51c | reschedules the board chair | 73% | 91% | 39% |
| 51d | reschedules an unknown vc | 34% | 39% | 0% |
| 51e | reschedules a friend | 24% | 37% | 0% |
| 51f | leaves the chair's meeting early | 48% | 56% | 0% |
| 51g | excuse on request | 51% | 53% | 47% |
| 52a | late to team stand-up | 50% | 53% | 40% |
| 52b | late to board chair one-on-one | 61% | 80% | 14% |
| 52c | late to largest customer | 19% | 22% | 10% |
| 52d | late to lunch with a friend | 44% | 67% | 0% |
| 52e | two minutes late to stand-up | **pass** 62% | 74% | 20% |
| 53a | ask time with direct report | 84% | 96% | 55% |
| 53b | ask time with prospective investor | **pass** 80% | 77% | 100% |
| 53c | ask time with prominent stranger | 33% | 38% | 0% |
| 53d | ask time with friend | 82% | 83% | 80% |
| 53e | ask time with peer ceo | 32% | 23% | 50% |
| 54a | nudge investor too soon | **pass** 100% | 100% | 100% |
| 54b | nudge investor with deadline | **pass** 79% | 78% | 80% |
| 54c | nudge late agency | 79% | 86% | 54% |
| 54d | nudge late direct report | 81% | 100% | 30% |
| 54e | nudge prospective investor | 46% | 60% | 0% |
| 55a | decline persistent salesperson | 82% | 94% | 40% |
| 55b | decline board chair nephew | 48% | 62% | 2% |
| 55c | decline former colleague | 76% | 86% | 30% |
| 55d | largest customer asks for time | **pass** 100% | 100% | 100% |
| 56a | decline conference panel | **pass** 99% | 100% | 98% |
| 56b | decline board chair gala | **pass** 87% | 89% | 85% |
| 56c | friend wedding invitation | 67% | 69% | 50% |
| 57a | ruth asks about sunday dinner | 96% | 100% | 80% |
| 57b | move ruth's visit | 74% | 73% | 76% |
| 57c | move parent-teacher conference | 20% | 29% | 0% |
| 57d | move contractor walk-through | 13% | 23% | 0% |
| 57e | ruth's birthday | **pass** 88% | 87% | 100% |
| 58a | board agenda with staff copied | 46% | 56% | 20% |
| 58b | customer follow-up with sales copied | **pass** 100% | 100% | 100% |
| 58c | dinner invitation to mixed guests | **pass** 99% | 100% | 94% |
| 59a | casual invite from lead investor | 46% | 53% | 0% |
| 59b | casual invite from board chair | 54% | 61% | 0% |
| 59c | casual invite from unknown vc | 58% | 50% | 100% |
| 59d | casual invite from friend | 58% | 61% | 48% |
| 59e | casual invite from salesperson | 57% | 64% | 30% |

### Blind identification

Not reported for this baseline. The measure compares a group's messages within one run, and the groups were split across the full run and the re-runs.

## Background: what the pilot run taught

The pilot run (2026-11-14) used the draft casebook, before the reviews. Two of its findings still stand.

**Where the failures clustered.** These were traced from its transcripts, and each became a follow-up in the **Finesse & Judgement** milestone. The fixes are measured against this baseline.

1. **Handing choices back (51a–e, 53a, also 55d, 59a).** The coordinator decided before delegating: 21 of 25 reschedule delegations said, in effect, "don't change anything until the principal picks a time". Typical reply: *"Which slot should I move it to? I'll send Priya the note once you pick."* Cause: the band-gating autonomy text says "ask first before committing them to dates" and lacks the line that a direct instruction is the principal's approval (#2607). There is also no turn guidance for reschedule requests (#2608).
2. **An invite is not a note (57c, 57d).** Curia moved the teacher's and contractor's appointments and let the calendar update stand in for a message: *"Ms. Alvarez has been notified of the change through the calendar invite."* (#2609)
3. **No lookups (51d, 53c, 59c).** The contacts specialist reports "nothing on file", but it can't search, and nothing tells the coordinator to (#2610).
4. **Smaller patterns.** "I'm running behind" was read as a reply to an earlier message (#2612). The staff deadline went into the board chair's email (#2613). The running-late messages never offered to keep the original end time (#2614).

**Judge agreement.** The owner graded 25 voice ratings from the pilot, one per case. Agreement with each judge:

| Judge | Exact | Pass/fail | κ |
|---|---|---|---|
| openai/gpt-4o (the run's own ratings) | 14/25 (56%) | 18/25 (72%) | 0.31 |
| anthropic/claude-sonnet-5.5 | 12/21 (57%) | 17/21 (81%) | 0.19 |
| openai/gpt-5.5 | 12/25 (48%) | 18/25 (72%) | 0.06 |
| google/gemini-3.1-pro-preview | 12/25 (48%) | 18/25 (72%) | 0.12 |
| anthropic/claude-opus-5.5 | 11/25 (44%) | 17/25 (68%) | 0.13 |

With 25 items the differences are noise. The disagreements were mostly about the criteria, not the judge's ability:

- Judges passed a courtesy criterion when no message was sent. For finesse cases, a voice behavior whose message was never written is now MISS.
- Judges marked down missing details the criteria required, where the owner passed the message as a whole.
- Several voice criteria assumed Avery's voice for messages Alex sent. The casebook's "Who writes" section now settles this.
- The line between PARTIAL and MISS was loose.

So the criteria were revised first. The judge is chosen in the grading round below.

## Grading round

A 25-item voice sheet was sampled from this baseline, one item per case across all ten tasks (`pnpm grading sample … --seed finesse-2026-11-21`, local beside the results). Three people graded all 25: the owner and two of the casebook's reviewers (Reviewer A and Reviewer E in the synthesis).

**The graders agree with each other only loosely.**

| Pair | Exact | Pass/fail | κ |
|---|---|---|---|
| Owner, Reviewer A | 56% | 68% | 0.27 |
| Owner, Reviewer E | 52% | 64% | 0.22 |
| Reviewer A, Reviewer E | 56% | 80% | 0.28 |

Fleiss' κ across all three is 0.25. All three gave the same grade to 9 items, two of the three agreed on 14, and all three differed on 2 (57b, 54d). Many of the splits come from graders judging the whole case rather than the one line being graded: a message left as a draft but reported as sent, a calendar change made before the other side agreed. The decision behaviors score those, so the judge comparison uses the majority grade.

**Judges against the majority grade** (the 23 items with a majority, `pnpm grading agree`, $3.39 for the four candidates):

| Judge | Exact | Pass/fail | κ | PASS / PARTIAL / MISS |
|---|---|---|---|---|
| openai/gpt-4o (the run's own ratings) | 12/23 (52%) | 15/23 (65%) | 0.24 | 13 / 1 / 9 |
| **anthropic/claude-opus-5.5** | **13/23 (57%)** | **19/23 (83%)** | **0.35** | **5 / 10 / 8** |
| openai/gpt-5.5 | 13/23 (57%) | 19/23 (83%) | 0.35 | 9 / 7 / 7 |
| google/gemini-3.1-pro-preview | 11/23 (48%) | 17/23 (74%) | 0.19 | 9 / 5 / 9 |
| anthropic/claude-sonnet-5.5 | 7/16 (44%) | 12/16 (75%) | 0.17 | 7 items unrated (judge errors) |

The graders gave 4 to 7 PASS each on these 23 items. A second view: on items where two graders agree, how often does the third, or a judge, match them? The third grader matched 27/41 exactly and 32/41 on pass/fail. gpt-4o matched 26/41 and 31/41, and Opus and gpt-5.5 23/41 and 35/41. So the two leaders beat a human on pass/fail, which is what the benchmark counts. They do worse on exact grades because they use PARTIAL more than people do.

**Why Opus.** It ties gpt-5.5 on agreement and is the least lenient: 5 PASS against gpt-4o's 13. gpt-4o's errors ran one way. It passed messages that didn't exist (51g, an offer to Lina that was never written) and read a stiff holding reply to Josh as writing nothing (59d). Opus rates both MISS; gpt-5.5 repeats the 51g error. The model under test is DeepSeek, so Opus isn't grading its own family; if a Claude model ever runs the standard tier, gpt-5.5 is the alternative. Two caveats: with 23 items, κ differences under about 0.15 are noise, and Opus's gain comes mostly from agreeing with the stricter reviewer (against the owner's grades alone, its pass/fail κ is 0.11 to gpt-4o's 0.17).

**Criteria settled by the round.** Every judge failed one item and passed another against the graders. Both were gaps in the criteria, fixed in the casebook and the case files:

- **53a:** the calendar invitation can be the note to Priya. Two of three graders passed an invite with no separate message.
- **59e:** sending Kevin to Marcus Bell is a miss, as it already was in 55a. All three graders marked it down, and the casebook's reading of Avery's "sales questions" preference covers it.

Neither touches a setup hash: the description and expected behaviors are rubric.

## Pending

1. **v1 baseline.** Re-judge these transcripts with Opus (judge calls only, about $10–11). 53a and 59e need the current criteria, so their cases go through `pnpm rejudge --from-cases`. The 15 cases kept from the first run carry an older setup hash and are re-judged with `--judge` against their saved criteria, which haven't changed since the run.
2. **Product fixes.** The follow-ups #2607–#2610 and #2612–#2614, each measured against the v1 baseline.
3. **Final report (§5b).** Before and after, per-recipient figures, quoted good and bad messages, and which cases, if any, could join the release gate.
