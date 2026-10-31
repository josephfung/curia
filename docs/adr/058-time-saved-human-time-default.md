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

The effort is estimated once, offline, by reading the names. A call contributes its anchor when a person would plausibly have spent time doing that thing. The anchor is the nearest describer figure (half a minute for a click, 5 for writing a post, 3 for an edit, 15 for a new document). A lookup contributes nothing. So does bookkeeping the agent does for itself: stamping a sender as last-seen, an inter-agent thread, a sweep, a shadow draft that is never shown. Those calls stay in the denominator. They are part of the set the backstop covers, and the backstop does not sort them again at runtime.

The first census used the 60 days of production `audit_log` ending 31 October 2026. A call counts when it is a successful `tool.result` or `skill.result` whose invoke is a `tool.invoke` or `skill.invoke`, and that invoke's parent is an `agent.task`. The tool name is read the same way as the tile. "Described" means the name is a key of `DESCRIBERS` at `86911016`, hidden keys included.

| | Calls |
|---|---:|
| All successful calls | 98,817 |
| Already described | 53,184 |
| Undescribed | 45,633 |
| Distinct undescribed names | 108 |

Of the undescribed calls, 35,368 were lookups and 8,444 were bookkeeping. Both contribute 0 to the effort. The remaining 1,821 calls are the work a person would have done. At the describer anchors they come to **2,390 minutes**:

| Minutes | Calls × anchor | What |
|---:|---|---|
| 379 | 758 × 0.5 | `like_post` |
| 370 | 74 × 5 | `create_post` |
| 300 | 20 × 15 | `create_drive_file` |
| 261 | 87 × 3 | `modify_sheet_values` |
| 255 | 17 × 15 | `create_doc` |
| 227 | 454 × 0.5 | `bluesky-unfollow` |
| 140 | 28 × 5 | `manage_event` (create, update, or delete; the update anchor) |
| 129 | 129 × 1 | `repost` |
| 60 | 4 × 15 | `import_to_google_doc` |
| 56.5 | 113 × 0.5 | `follow_user` |
| 55 | 11 × 5 | `reply_to_post` |
| 48 | 16 × 3 | `update_drive_file` |
| 32 | 64 × 0.5 | `contact-dedup-exclude` |
| 14 | 7 × 2 | `behavioral-preferences-update` |
| 12 | 4 × 3 | `find_and_replace_doc` |
| 10 | 2 × 5 | `meeting-agenda-park` |
| 8 | 4 × 2 | `manage_drive_access` |
| 7 | 7 × 1 | `contact-unlink-identity` |
| 6 | 6 × 1 | `contact-link-identity` |
| 4 | 2 × 2 | `copy_drive_file` |
| 3 | 1 × 3 | `batch_update_doc` |
| 3 | 1 × 3 | `insert_doc_elements` |
| 3 | 1 × 3 | `modify_doc_text` |
| 2 | 4 × 0.5 | `dismiss-action` |
| 1.5 | 3 × 0.5 | `approve-action` |
| 1 | 1 × 1 | `contact-set-identity-status` |
| 1 | 1 × 1 | `create_drive_folder` |
| 1 | 1 × 1 | `deliver-approval` |
| 1 | 1 × 1 | `deny-action` |

The default divides that effort by every undescribed call, not only the 1,821:

**2,390 / 45,633 = 0.052 minutes** (about 3 seconds).

That is the backstop. It replaces one minute per undescribed action. Multiplying it back by 45,633 returns the 2,390 minutes. The code does not inspect the call to decide whether it was a read, bookkeeping, or work. Any name the describers do not list is worth 0.052 minutes.

The largest bookkeeping names, all at zero effort, were `contact-register` (5,129), `bullpen` (1,095), `approval-expiry-sweep` (839), `bullpen-post` (472), and `ceo-inbox-shadow-draft` (432). The largest lookups were `ceo-inbox-list` (7,788) and `task-list` (7,419).

### Recalculating

1. Run the same census for a new window. Count described and undescribed successful calls, and list undescribed names with their counts.
2. Estimate the human effort of the work in that undescribed list, using the describer anchors. Lookups and self-bookkeeping contribute 0. New names get an anchor only in this step.
3. Divide that total by the undescribed call count. Round to three decimal minutes.
4. Replace the constant and the tables in this ADR, and record the window.

## Consequences

- The formula is easy to state. Named actions use their anchors. Anything else is 0.052 minutes, from this office's 60 days ending 31 October 2026.
- The number will not match a stopwatch, an agent's elapsed time, or another person's pace. That is accepted. Another office, or a later window with a different mix of tools, recomputes the constant rather than inheriting this one by assumption.
- Undescribed lookups add the default too. That is how 2,390 minutes of posts, edits, and new documents is spread across 45,633 calls. It is a property of the formula. A named read stays at 0, because its describer already says so.
- Treating a new Drive file as a 2-minute save instead of a 15-minute document would have lowered the effort from 2,390 to 1,857 and the default from 0.052 to 0.041. The 15-minute anchor is the one the describers use for a new document, so the census uses it too.
- The tile applies both parts. A named call uses its describer anchor. A successful call whose name is not in the describers adds 0.052 minutes, including a lookup. A hidden describer stays at zero. Replacing the constant means editing `UNDESCRIBED_CALL_MINUTES` and the tables in this ADR together.
