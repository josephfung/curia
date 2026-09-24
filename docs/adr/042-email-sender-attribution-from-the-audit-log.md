# ADR-042: Recover email sender attribution from the audit log

Date: 2026-09-24
Status: Accepted

## Context

The contact-scoped recall tier (#1599, [spec 01](../specs/01-memory-system.md)) includes an assistant turn only when every `user` turn in that conversation is attributed to the contact being recalled. A `user` row whose `sender_contact_id` is null marks the conversation shared, and the check deliberately has no time filter and no `archived` filter. That is what keeps a Signal group or a CC'd thread closed, and it is correct.

Migration 090 stamps senders for the conversation ids that encode a single peer — Signal 1:1, SMS, voice — and only for the last seven days. `backfillDirectChannelSenders` stamps the older Signal 1:1 and SMS rows after boot. Email was left out on the stated grounds that the per-turn `From` address was never written to `working_memory` and so was unrecoverable.

#1887 raised three options: **A** backfill email senders, **B** ignore nulls older than a recorded cutoff, **C** accept and document. B was rejected immediately: it buys completeness by being willing to reclassify a genuinely shared thread as private, which turns a recall gap into a disclosure risk. That left A against C, with A assumed expensive and approximate.

A probe against the production database on 2026-09-24 changed the inputs to that comparison. Four findings:

**1. The sender is exactly recoverable.** `audit_log` is append-only and nothing prunes it. Its `inbound.message` rows carry `target_id = email:<threadId>`, `initiator_id = <From address>`, and `payload.content`. Anchoring on content — the `inbound.message` in the same conversation whose `payload.content` appears verbatim inside the `working_memory` turn — resolved **1,174 of 1,185** email user rows (99.1%) to exactly one sender, with **zero** ambiguous rows. Timestamp proximity was measurably worse (94.8%) and is not used. 947 rows map to a known contact; 227 have a real sender who is not a contact and correctly stay null, because no contact-scoped read can ask for them.

**2. The 11 rows that did not resolve are not messages.** Every one is a synthetic `role='user'` turn written by Curia itself: ten `[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]` rewrite prompts and one `[Late specialist result — …]` delegation result. They are the same class as the `[Call connected …]` voice cue that `isSyntheticVoiceGreetingCue` already excludes by exact string match. They block 9 of the 17 partially-resolvable threads, and they are also a correctness bug in the Signal and SMS backfill, which matches on conversation-id pattern with no content filter and would stamp six such rows in production with a human peer's contact id. That is tracked and fixed separately (#1892, migration 092); this ADR assumes the class is excluded, and the backfill enforces it — its candidate set filters on `working_memory.synthetic = false`, the same column the recall read tests. Left in scope those rows never match an inbound audit row, so they would report as unresolved and mark 9 threads partial that recall already treats as private. With the exclusion, 757 of 965 threads resolve completely and no row is left unmatched.

**3. The TTL does not age the problem out.** #1887 reasoned that unstamped rows would normally expire and that permanence came from `archived` rows being exempt from `purgeExpired`. In production, **1,129 of 1,185** email user rows have `expires_at IS NULL`, so `purgeExpired` never considers them at all. Only 23 rows are archived. The residue is permanent for reasons that have nothing to do with archiving, and is roughly fifty times larger than the archived-only framing suggests.

This is a statement about retention, not about attribution: it says which rows persist, not which are wrongly scoped. See the Decision for the recoverable subset, which is smaller.

**4. Nothing is currently broken.** 936 email threads are from April–June 2026 and 29 are from September, with zero threads spanning both. `participated` requires a recent attributed turn, so no dormant thread is losing anything today. The first reply to any of those 936 threads arms it permanently. This is a latent trap, not an active fault, which is what makes fixing it before it fires worth doing.

Also relevant to the comparison: migration 090's seven-day window covers 15 of 1,185 email rows. As written it does effectively nothing for email, so "leave 090 alone" was never the conservative choice it appeared to be.

## Decision

**Take A.** Backfill email 1:1 sender attribution by resolving each `working_memory` email user turn against its originating `inbound.message` audit event, anchored on content containment, then mapping the recovered `From` address through `contact_channel_identities`.

Three constraints shape the implementation:

**Content anchoring, never timestamp proximity.** A row is stamped only when exactly one `inbound.message` in its conversation has `payload.content` embedded verbatim in the turn. Zero or several candidate senders means the row is left null. The probe found no ambiguous rows, so this costs nothing measurable and removes the failure mode where two messages arriving close together in one thread swap authors. The recovered address is the one the dispatcher itself read at the time, so this is recovery, not inference — which is what separates A from the heuristic "threads with exactly one non-owned participant" approach #1887 sketched, and why A does not carry B's misattribution risk.

**A one-off script, not a migration and not a boot path.** Only databases that predate migration 090 hold unstamped rows, and every new install stamps on write. Boot-time code modelled on `direct-sender-backfill.ts` would run to completion once, on one database, then re-run a no-op query on every deployment forever. The backfill ships as `scripts/backfill-email-senders.ts` with a dry-run mode that reports per-conversation outcomes, and a runbook note so a self-host upgrader crossing migration 090 can run it deliberately.

**Per conversation, not per row.** One unattributed user turn anywhere in a thread marks the whole thread shared, so stamping nine rows of ten buys nothing. The script reports fully-resolved, partially-resolved and unresolved conversations separately, and partial resolution is treated as a reportable outcome rather than a success.

A row that does not resolve stays null and its conversation stays shared, which is today's behaviour. The backfill can be incomplete without being wrong. That fail-safe property is the core reason A was chosen over B, and it remains true independent of the measured hit rate.

**C was rejected** on findings 1 and 3. The measured cost of A is roughly a day, most of which — the observability work below — C also requires.

The cost of C is **947 rows whose sender is recoverable but would stay unattributed**, across 757 threads and 176 contacts, growing with every email thread that ever resumes. Finding 3's 1,129 is a *retention* count, not this: it is every in-scope row that will never be purged, and it includes the 227 whose senders are real people with no contact record. Those 227 are correctly null under any option, so counting them as a cost of C would overstate it. The two measures overlap on **902 rows** — recoverable, unattributed, and never expiring, which is the subset for which "permanently" is literally true. The remaining 45 recoverable rows carry a TTL and would eventually be purged unarchived.

**Observability ships regardless.** A conversation excluded from contact recall by the shared check emits a log line naming the conversation and the reason. #1887's sharpest observation is that today an affected thread produces a correct-looking but incomplete block with no counter and no log line, and that silence is what made this class of fault invisible until it was looked for directly. That holds whichever option was chosen.

## Consequences

Contact recall becomes correct on 757 historical email threads covering 176 contacts, including every thread that later resumes. Long-running correspondence, which the tier exists to serve and which is the most likely to carry pre-090 turns, stops silently dropping Curia's own replies.

Attribution quality is bounded by the audit log rather than by a guess. If `audit_log` were ever pruned or its retention changed, the backfill stops being possible — it must run before any such change, and this ADR is the reason the audit log's completeness is now load-bearing for something beyond audit.

The 227 rows whose senders are real people with no contact record stay null, so 200 threads remain closed to contact recall. That is correct rather than a shortfall: with no contact there is no read to serve. Should those senders later become contacts, their threads stay shared until the script is re-run, which the runbook notes.

A one-off script is a maintenance artifact with no test coverage from normal runs and no natural trigger. It can rot silently. That is accepted in exchange for keeping a single-use rewrite off the boot path of every deployment; the regression test covering the selector's behaviour on archived pre-cutoff rows lives in the test suite, not in the script.

Migration 090 and the comments in `direct-sender-backfill.ts` currently read as though the email gap is intentional and bounded. Both are updated, as is the tier description in spec 01, which claims a backfill scope that is no longer accurate.

Finally, the probe established that the production `expires_at` population is almost entirely null, which means working memory is not aging out the way spec 01's TTL description implies. That is outside this decision's scope and is not addressed here, but it affects any future reasoning that assumes unstamped or stale rows eventually disappear on their own.
