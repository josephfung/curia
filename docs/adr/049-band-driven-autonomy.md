# ADR-049: The autonomy band decides when Curia asks first

Date: 2026-10-18
Status: Accepted

## Context

The autonomy score was meant to be the main dial for how freely Curia acts. In practice two
later gates overruled it and never read the score:

- **Gate C** (`src/skills/execution.ts`) escalated any consequential action whose *initiating*
  contact was below `trusted`, "even when the autonomy score permits them".
- **Stage 2.5** of the outbound filter blocked content by `recipientTier × disclosureClass`
  (`src/autonomy/escalation-policy.ts`). A `known` recipient could never receive
  `third-party` or `confidential` content, even after the principal approved the send.

In October 2026 a time-sensitive billing thread stalled on these gates at a score of 84, the
spot-check band, whose own description says "No need to stop and ask":

| What Curia tried | Outcome | Why |
|---|---|---|
| The same reply to the same recipient | Sent, then escalated | It depended on who wrote last on the thread |
| A reply the principal had approved | Blocked two seconds later | It named the recipient's own colleague, which counts as `third-party` |
| A payment confirmation to the desk that issued the account reference | Blocked | The account reference counted as `confidential` |

The gates did catch one real defect: a draft told a counterparty "I'm out of office until the
13th", which was a false statement in the principal's voice. No tier rule caught it; a human
reading did.

Alternatives considered and rejected:

- **Persisted mandates or counterparty lists** that say who Curia may talk to about what.
  They need fields operators cannot fill well, and they go stale.
- **A deterministic "never by email" list or PII regex.** It brings back the false positives
  this decision removes, and the regex cannot read context.
- **Keeping tier as a veto** on top of the score. That is the arrangement that stalled.

## Decision

1. **The autonomy score is the primary dial.** Each band's behaviour is a row of the table in
   [spec 14](../specs/14-autonomy-engine.md#band-gating-2159); each lower band adds a check.
   Gates A and B (score vs. `action_risk`) are unchanged.
2. **Contact tier only matters when an outsider is steering Curia**, and the escalation judge
   decides that ("purpose: serving or steered"). A steered action is held at every band.
3. **Claims about the principal are fact-checked before sending.** The judge checks them
   against what the drafting turn actually looked up (its tool results, read back from the
   audit log) and the "Who you serve" block. The evidence is passed beside the message, never
   written into it.
4. **One bounce.** Unsupported claims or unneeded disclosures go back to the drafter once.
   After that, at 80+ the quoted statements are cut and the trimmed message is rechecked and
   sent with a digest item; below 80 it is held.
5. **Below 80, speaking or committing as the principal asks first.** Gate C asks the judge
   before the skill runs; the gateway asks of relayed replies.
6. **Judge failure fails open at 80+ only,** with a "sent without review" digest item, capped
   at five an hour (then everything holds until the judge answers). Below 80 it holds.
7. **Code guards only Curia's integrity.** The deterministic rules that stay are
   `secret-pattern`, `system-prompt-fragment`, `internal-structure`, `principal-note-markup`,
   the KG-write block for unknown senders (#1290) and the missing-tier fail-closed rule
   (#1059). `contact-data-leak` and the tier × disclosure table are off under band gating.
8. **Rollback is one setting.** `autonomy.gating: band | tier` ships as `tier`. Prod flips it
   to `band`; the default changes after a clean week; the tier code paths are deleted in a
   follow-up once `band` has run in prod.

## Consequences

- An approved, legitimate reply is no longer blocked because of whom it mentions or who wrote
  last. The approvals the principal sees at spot-check should be close to zero apart from
  `steered` holds.
- A false statement in the principal's voice is caught by the grounding check rather than by
  luck. A true but unverified claim costs one round trip: the drafter has to look it up.
- More depends on the judge. A judge that is down sends unreviewed at 80+ (bounded by the
  cap) and holds below. Under band, the judge must be enabled; config refuses `band` with
  `escalation.judge.enabled: false`.
- A send the principal directs in a live turn is asked only the grounding question, so a
  prompt injection that steers a principal-directed send is no longer backstopped by the
  `contact-data-leak` regex. This is accepted per the design; sampling (Phase 3) is how the
  judge's mistakes are found.
- There is no hard "never by email" list. If sampling shows the judge getting a class of
  disclosure wrong, structure is added then, not before.
- Each send at band gating costs one judge call (at most two below 80: one at Gate C, one at
  the gateway). Evidence read from the audit log is trimmed to about 12,000 characters, and
  credentials are redacted before it leaves for the judge's provider.

See issue #2159 and `docs/wip/2026-10-15-band-driven-autonomy-design.md`.
