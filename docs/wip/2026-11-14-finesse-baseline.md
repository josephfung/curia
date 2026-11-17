# Finesse baseline: pre-feedback run

Working note · Issue #2556 · 2026-11-14 · Draft

This is the §5a note for the run against the draft casebook (`docs/wip/2026-11-10-finesse-casebook.md`), before the EA reviewers' feedback. It grows into the §5b report: sections marked **Pending** fill in after the feedback, the new baseline and the human grading round.

## Summary

- **Curia decides better than it writes.** Over the 45 cases, the decision layer averaged 70% and the voice layer 48%. Only 7 of 45 cases passed every critical behavior.
- **Most decision failures come from one cause.** At autonomy 84 (band gating, as in production), Curia hands choices back to the principal instead of acting on a direct instruction. Every reschedule run offered Avery slots rather than moving the meeting. The injected band text says "ask first before committing them to dates", and band gating dropped the line that a direct instruction is the principal's approval (#2607).
- **Curia never looked anyone up.** In the three cases where the only way to learn who someone is was a web search, it never searched (decision 36% at information level 4).
- **The rubric had a hole of its own.** The casebook never said whether a message comes from Curia (signed Alex) or is written as the principal. It does now ("Who writes"), and that changes several cases' expectations.
- **No judge is chosen yet.** Against 25 human grades, gpt-4o and four stronger candidates agreed about equally poorly (κ 0.06–0.31). The disagreements were mostly about the criteria, not about how capable the judge was. The choice waits for cleaner criteria and a second grader.

## What was run

| | |
|---|---|
| Cases | 45 finesse cases, tasks 50–59, all `release_gate: false` |
| Runs | 5 per case (225) |
| Model | `deepseek/deepseek-v4.1-flash`, real delegation to specialists |
| Autonomy | 84, band gating (each case's fixture; production's level) |
| Identity | `finesse` fixture: neutral office tone, two standing preferences |
| Judge | `openai/gpt-4o` (the suite default) |
| Commit | `aa7c814` |
| Results | `tests/scenarios/results/2026-11-14T20-32-20-897Z.json` (local) |
| Time, cost | 77 minutes; $7.26 ($3.94 of it judging) |

No run errored or timed out. The judge failed to rate one run (59a), and 7 cases had refused side-task calls, since stubbed (see Harness changes).

## Results

### By task

| Task | Cases | Passed | Decision | Voice |
|---|---|---|---|---|
| 50 An attendee drops out | 4 | 0 | 73% | 49% |
| 51 Rescheduling | 6 | 0 | 41% | 10% |
| 52 Running late | 5 | 1 | 76% | 26% |
| 53 Asking for time | 5 | 0 | 47% | 48% |
| 54 Nudging after no reply | 5 | 1 | 92% | 68% |
| 55 Declining a request for time | 4 | 1 | 87% | 54% |
| 56 Declining an invitation | 3 | 1 | 91% | 77% |
| 57 Family and household | 5 | 1 | 66% | 49% |
| 58 Mixed audiences | 3 | 2 | 85% | 82% |
| 59 A casual invitation | 5 | 0 | 68% | 54% |
| **All** | **45** | **7** | **70%** | **48%** |

Layer scores are weighted means over each case's behaviors. A case passes when every critical behavior fully passed in at least 80% of runs. The cases that passed were 52e, 54b, 55d, 56a, 57e, 58b and 58c.

### By information level

How Curia could learn who the recipient is (casebook, "How to read a case"):

| Level | How Curia could know | Cases | Decision | Voice |
|---|---|---|---|---|
| 1 | Stated in the request | 5 | 78% | 57% |
| 2 | Contact record only | 20 | 70% | 52% |
| 3 | Notes or memory only | 12 | 76% | 39% |
| 4 | Only by looking it up | 3 | 36% | 47% |
| 5 | Only from earlier threads | 3 | 73% | 53% |

Two cases (50a, 55b) have no level marked in their file and are left out. Level 4 is the clear gap. Level 3's low voice score is mostly task 51, which falls there.

### By recipient

**Pending.** Per-recipient figures come from the new baseline: "who writes" changes several recipients' expected behavior.

### Blind identification

A judge matches each group's messages to recipient descriptions, without names. It is tracked, not gated.

| Group | Matched | Chance |
|---|---|---|
| 52 Running late | 19/28 (68%) | 40% |
| 53 Asking for time | 14/14 (100%) | 44% |
| 54 Nudging | 30/38 (79%) | 27% |
| 55 Declining | 20/20 (100%) | 50% |
| 59 Casual invitation | 25/50 (50%) | 20% |

Groups 50, 51 and 57 couldn't be measured: in most runs Curia wrote nothing to those recipients, a decision rather than a harness fault. Where Curia did write, its messages are recognisably different per recipient. The casual invitations are the weakest group.

## Where the failures cluster

Traced from the saved transcripts. The full diagnosis covers each pattern's evidence and where a fix belongs (ADR-046).

1. **Handing choices back (51a–e, 53a, also 55d, 59a).** The coordinator decides before delegating: 21 of 25 reschedule delegations said, in effect, "don't change anything until the principal picks a time". Typical reply: *"Which slot should I move it to? I'll send Priya the note once you pick."* Cause: the band-gating autonomy text (#2607), and no turn guidance for reschedule requests (#2608).
2. **An invite is not a note (57c, 57d).** Curia moved the teacher's and contractor's appointments and let the calendar's update stand in for a message: *"Ms. Alvarez has been notified of the change through the calendar invite."* (#2609)
3. **No lookups (51d, 53c, 59c).** The contacts specialist reports "nothing on file", but it can't search, and nothing tells the coordinator to (#2610).
4. **Smaller patterns.** "I'm running behind" was read as a reply to an earlier message in 3 of 15 runs (#2612). The staff deadline went into the board chair's email in every 58a run (#2613). The running-late messages never offered to keep the original end time (#2614).

Two quoted messages:

- A good one (52d, to a friend, by text): *"Avery's running about ten minutes behind — see you at Café Lumen shortly."* The register is right, though "see you" is wrong coming from the assistant.
- A typical miss (57b, Avery's draft to their mother-in-law): *"A quick note to let you know that your visit is now Saturday, November 28."* A reviewer's version: *"I'm so sorry, but something came up… Hoping the Saturday after works for you. I'm really looking forward to it!"*

All seven follow-ups are in the **Finesse & Judgement** milestone (#2607–#2610, #2612–#2614). They land after the new baseline, so it measures Curia before any fix.

## Rubric and harness changes since the run

**The casebook** (revised and corrected 2026-11-14):
- A "Who writes" section and a line in every case. From Alex: third person, an assistant's voice, crediting Avery's decisions to Avery. As Avery: written in Avery's mailbox, sent from there when Avery asked Curia to send it, otherwise left as a draft.
- Avery's standing preference: emails to customers and investors come from Avery, except to their assistants or when running late on the day.
- Voice notes corrected from the owner's grading (52d, 55a, 55c, 56b, 57b, 59d).

**The harness:**
- Calls the baseline refused are stubbed: `send-draft` as production answers it, `contact-merge`, `contact-rename`, `ceo-inbox-sent-observe` and `bullpen-post`.
- 56b's own mailbox holds the invitation. 58a and 58b may send from Avery's mailbox, since Avery asked. 57c and 57d events name their organizer.
- The judge reads the first complete JSON answer, retries unreadable replies, and treats a revised second answer as unreadable.
- For finesse cases, a voice behavior whose message was never written is MISS, unless the behavior says writing nothing is acceptable. The release-gate cases are judged as before.
- Blind identification says why a case went unmeasured. Runs record refusals the capture missed.
- Grading sheets keep their cells as text in spreadsheets, and mark a reply production's lock would drop.

These change every finesse case's setup, so the next run is a new baseline rather than a re-score.

## Judge agreement

The owner graded 25 voice ratings, one per case, across all ten tasks. Agreement with the judges, on the baseline's criteria:

| Judge | Exact | Pass/fail | κ | Cost |
|---|---|---|---|---|
| openai/gpt-4o (the run's own ratings) | 14/25 (56%) | 18/25 (72%) | 0.31 | n/a |
| anthropic/claude-sonnet-5.5 | 12/21 (57%) | 17/21 (81%) | 0.19 | $0.42 |
| openai/gpt-5.5 | 12/25 (48%) | 18/25 (72%) | 0.06 | $0.91 |
| google/gemini-3.1-pro-preview | 12/25 (48%) | 18/25 (72%) | 0.12 | $0.66 |
| anthropic/claude-opus-5.5 | 11/25 (44%) | 17/25 (68%) | 0.13 | $0.90 |

Sonnet failed to rate 4 items. With 25 items, these differences are noise. What the disagreements show:

- **Missing messages.** Judges passed "any message to Kevin is courteous" when nothing went to Kevin; the owner marked it MISS. Now covered by the voice rule above.
- **Literal reading.** Judges marked down missing details the criteria require (54d's new deadline, 58c's "Avery and Morgan's home") where the owner passed the message as a whole. Either the criteria or the judge is too strict.
- **Who writes.** Several voice criteria assumed Avery's voice for messages Alex sent (59a, 59d, 59e). The casebook now settles this; the case files follow after the feedback.
- **PARTIAL versus MISS.** The line between them is loose.

Re-scoring with gpt-4o on the updated criteria ($0.34) barely moved agreement (κ 0.30). gpt-4o didn't reliably apply the new rule, and in one run it said no reply was sent when one was.

Decision: no finesse judge yet (`TAG_JUDGE_MODELS` stays empty). The release gate keeps gpt-4o regardless.

## Pending

1. **EA feedback (5–7 reviewers).** Synthesise per task, fold into the casebook, then into the case files. Add the "who writes" rules and Avery's customer and investor preference to the identity fixture.
2. **New baseline.** All 45 cases, run count and cost agreed first. Remove the coverage allowances once re-measured.
3. **Grading round.** A fresh 25-item sheet from the new baseline, graded by the owner and one or two EAs on the same items, to measure how far people agree with each other.
4. **Judge choice.** Re-run the strongest candidates against those grades (`pnpm grading agree --current-cases`). Set `TAG_JUDGE_MODELS.finesse`.
5. **Final report (§5b).** Before/after comparison, per-recipient figures, quoted good and bad messages, product recommendations, and which cases, if any, could join the release gate.
