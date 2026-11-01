# ADR-058: Time saved estimates a person's time, with one default for undescribed calls

Date: 2026-10-31
Status: Accepted

## Context

The Time saved tile first counted every successful tool call as one minute (#2349). Lookups and plumbing dominated that number. Named tools now carry their own estimates, written on the activity describers: a meeting is 10 minutes, a reply or a sent email is 5, filing is half a minute, a new document is 15, an edit is 3. Those figures are best guesses of how long the work usually takes a person. A hidden describer, such as `web-search` or `config-store`, is an explicit zero.

A large share of real calls have no describer. Custom tools, MCP tools, and shipped tools that never got a feed line all fall through. On the 60 days ending 31 October 2026, 45,633 of 98,817 successful calls were in that set, across 108 names. Leaving them at zero drops that work. Putting them back at one minute restores the inflation the describers were meant to end (45,633 minutes against an estimated 2,390). Keeping a second list of names, and scoring only some of them, makes every new tool a classification problem.

The tile needs a backstop: one duration for any successful call the describers do not already name.

A perfect duration is not available, and it is not the goal. Agents finish work faster than a person would, so "how long did the agent take" and "how long would a person have taken" are different questions and give different numbers. The tile is the second question: time saved is the principal's time. People also do not share one pace. Two principals, or the same principal on two days, would not spend the same minutes on the same call. No measurement resolves that. The formula has to be plausible and easy to explain.

## Decision

Time saved is a human-time estimate. Each named tool keeps the anchor on its describer. Every successful call with no describer adds the same default. The default is the likely human effort of the work those undescribed calls accomplished, spread across every undescribed call.

The effort is estimated once, offline, by reading the names. A call contributes its anchor when a person would plausibly have spent time doing that thing. The anchor is the nearest describer figure (half a minute for a click, 5 for writing a post, 3 for an edit, 15 for a new document). A lookup contributes nothing. So does bookkeeping the agent does for itself: stamping a sender as last-seen, an inter-agent thread, a sweep, a shadow draft that is never shown. Those calls stay in the denominator unless the tool is given a hidden describer, which takes it out of the set. The backstop does not sort calls again at runtime.

The first census used the 60 days of production `audit_log` ending 31 October 2026. A call counts when it is a successful `tool.result` or `skill.result` whose invoke is a `tool.invoke` or `skill.invoke`, and that invoke's parent is an `agent.task`. The tool name is read the same way as the tile. "Described" means the name is a key of `DESCRIBERS` at `86911016`, hidden keys included. Per-name counts from that window stay in the private ops notes. This ADR keeps the totals.

| | Calls |
|---|---:|
| All successful calls | 98,817 |
| Already described | 53,184 |
| Undescribed | 45,633 |
| Distinct undescribed names | 108 |

Of the undescribed calls, 35,368 were lookups and 8,444 were bookkeeping. Both contribute 0 to the effort. The remaining 1,821 calls are the work a person would have done. At the describer anchors they come to **2,390 minutes**.

Spread across every undescribed call, that effort is 2,390 / 45,633 = 0.052 minutes. Five shipped zero-effort tools were then marked hidden, an explicit zero, the same as `memory-store`: `ceo-inbox-list`, `task-list`, `contact-register`, `bullpen-post`, and `ceo-inbox-shadow-draft`. Together they were 21,240 of the undescribed calls, and none of them contributed to the 2,390. They leave the denominator. The effort does not change.

**2,390 / 24,393 = 0.098 minutes** (about 6 seconds).

That is the backstop the tile uses. It replaces one minute per undescribed action. Multiplying 0.098 by 24,393 returns 2,391 minutes, within a minute of the 2,390. The code does not inspect the call to decide whether it was a read, bookkeeping, or work. Any name the describers do not list is worth 0.098 minutes. A hidden describer stays at zero.

Two census names are not tools, so they were not given entries. `bullpen` is the skill bundle; its tools are `bullpen-post`, `bullpen-reply`, `bullpen-read`, and `bullpen-close`. `approval-expiry-sweep` was retired as a skill and is a system interval (#2013). Historical rows under those two names stay on the default.

Custom tools and MCP tools stay undescribed on purpose. They are not given anchors in the registry. A new shipped tool gets a describer when someone writes one; until then it takes the default.

### Recalculating

1. Run the same census for a new window. Count described and undescribed successful calls. Keep the per-name list in the private ops notes.
2. Estimate the human effort of the work in that undescribed list, using the describer anchors. Lookups and self-bookkeeping contribute 0. New names get an anchor only in this step.
3. Move any shipped zero-effort tool that now has a hidden describer out of the undescribed count. Do not change the effort if those calls contributed 0.
4. Divide the effort by the undescribed call count that remains. Round to three decimal minutes.
5. Replace the constant and the totals in this ADR, and record the window.

Nothing in the running system notices when the mix of tools drifts. The constant is a snapshot until someone repeats these steps.

## Consequences

- The formula is easy to state. Named actions use their anchors. A hidden describer is zero. Anything else is 0.098 minutes, from this office's 60 days ending 31 October 2026, after the five zero-effort tools above were taken out of the set.
- The number will not match a stopwatch, an agent's elapsed time, or another person's pace. That is accepted. Another office, or a later window with a different mix of tools, recomputes the constant rather than inheriting this one by assumption.
- Undescribed lookups add the default too. That is how 2,390 minutes of work is spread across the calls the describers do not name. It is a property of the formula. A lookup with a hidden describer stays at 0.
- Treating a new file as a 2-minute save instead of a 15-minute document would have lowered the effort from 2,390 to 1,857. Spread across the 24,393 calls the default covers, that is 0.076 minutes instead of 0.098. The 15-minute anchor is the one the describers use for a new document, so the census uses it too.
- The tile applies both parts. A named call uses its describer anchor. A successful call whose name is not in the describers adds 0.098 minutes, including a lookup. A hidden describer stays at zero. Replacing the constant means editing `UNDESCRIBED_CALL_MINUTES` and the totals in this ADR together.
