# Relay budget: outsider-triggered messages to the principal

Issue: #1320 (sub-issue of #2159, ADR-049). Status: design approved 2026-10-19.

## Problem

An external contact can make Curia message the principal as often as they like. Writing to
Curia repeatedly gets the coordinator to call a send skill with `recipient: "principal"` each
time, and nothing in the send path limits that:

- The band send review skips sends where the principal is the sole recipient
  (`principalIsSoleRecipient` in `OutboundGateway.send()`), because nobody else reads them.
- Gate C under band leaves sends to the gateway. Under tier, a `known` initiator may send to
  the principal alone (`escalation-policy.ts`), and a `trusted` one may take any
  reversible-external action.
- The autonomy gate skips principal recipients.

The result is the noise #2159 measures (its target is under 5 immediate principal-bound
messages per piece of work; the Manulife thread produced about 20), with nothing to stop it.

## Paths in scope

The only path by which an outsider produces an *immediate* message to the principal is a
coordinator (or specialist) call to one of the human send skills addressed to the principal:
`email-send`, `signal-send`, `slack-send`, `sms-send`. The others are already bounded or out
of scope:

| Path | Why out of scope |
|---|---|
| Dispatcher relay of `agent.response` | Goes to the inbound sender. Reaches the principal only when the principal wrote in. |
| Principal notes | Digest-only `principal.report`. |
| Approval prompts (`deliver-approval`, expiry sweep) | Exempt by design; delivered once per approval as system notifications. |
| `report-to-principal` | A record, never a message. |
| Gateway and scheduler system notices | `isSystemNotification`; system-caused. |
| `email-reply` with the principal in cc | Not principal-alone: the band review already sees it. |

## Rule

A send is **budgeted** when all of these hold:

1. The principal is the sole recipient (the same `principalIsSoleRecipient` the gateway already
   computes).
2. It is not a system notification, not `humanApproved`, and not `principalDirected` (a live
   principal turn).
3. The send carries an `originator` (new send option, below) whose `systemRole` is neither
   `principal`, `system` nor `agent`, and whose tier is `known`, `unknown`, `blocked`, or
   missing. A missing tier counts as `unknown`, following the fail-closed rule from #1059.
   `trusted` (and `principal`-tier) originators are never budgeted.

A send with no `originator` at all is not budgeted. Only the four send skills set it; adapter
relays and system paths don't, and none of those reach the principal on an outsider's behalf.

The bypass ladder does not interfere: it downgrades only principal and system lineage to
`agent`, never an external originator, so a woken task working for an outsider still counts
against that outsider.

### The budget

- `RelayBudget` (`src/autonomy/relay-budget.ts`): an in-memory sliding window of timestamps per
  originator contact id, with an injectable clock. Modelled on `FailOpenLimiter`
  (`band-policy.ts`) for the window and on the inbound `RateLimiter` (#1665) for evicting
  idle keys.
- `tryAcquire(contactId)` returns `allowed` (and records the send) or `over` (records
  nothing). A relay counts when the budget lets it through, whatever happens at transport.
- `shouldNotify(contactId)`: true for the first over-budget relay in a window, then false until
  a full window has passed since that notice.
- Config: `autonomy.relay_budget.per_hour` (integer, default `3`; `0` turns the budget off). The
  window is one hour. Validated at boot like the rest of `autonomy.*`.
- In memory only. A restart resets the counts; an outsider cannot cause a restart, and a
  durable counter is not worth a table for this.

### Over budget

The gateway does not deliver the relay. Instead, in this order:

1. **Digest item.** Publishes `principal.report` with a new source, `relay_deferred`,
   `urgency: 'digest'`. The summary names the contact (display name, falling back to "a
   contact") and carries the relay's full redacted text, so nothing is lost. If this publish
   fails, the gateway **delivers the relay after all** and logs an error: noise beats a lost
   message.
2. **One notice per window.** When `shouldNotify` is true, sends one line on the same channel
   to the same principal address, as a system notification:
   `[Contact name] has more updates. I'm holding them for your digest.`
   Built from the relay's request with the body replaced, threading and attachments removed,
   and, for email, the subject set to `Holding updates from [Contact name]`. A failed notice
   logs a warning; the relay is still deferred.
3. **Record.** A structured `warn` log line (`originatorContactId`, `tier`, `channel`,
   `count`), and a new audit event, `autonomy.relay_deferred`
   (`originatorContactId`, `tier`, `channel`, `conversationId?`, `taskEventId?`,
   `noticeSent`). Neither carries message content.
4. **Result.** Returns `{ success: true, deferredToDigest: true }`. A failure would make the
   coordinator retry on another channel and defeat the budget. The four skills pass
   `deferredToDigest` through in their result data with a one-line note telling the agent the
   message is queued for the principal's digest and must not be re-sent another way.

### Where it sits in `send()`

After Step 2 (content filter and PII redaction), so blocked content is never queued and the
digest item carries redacted text; before Step 2.5 (band review, which principal-alone sends
skip anyway) and channel dispatch. It applies under both `autonomy.gating: tier` and `band`:
the gap exists in both.

### The originator option

`OutboundGateway.send()` options gain `originator?: TaskOriginator`. The four send skills set it
from `ctx.taskMetadata.originator` through one shared helper next to `isPrincipalDirectedSend`
(`skills/_shared/principal-directed.ts`), so every send skill reads the originator the same way.

## Docs

- Spec 14: a "Relay budget" subsection beside the band send review and Gate C, including the
  exemption list.
- Spec 15: one line under Outbound Gateway naming the step.
- CHANGELOG, `config/default.yaml` (commented), and the config JSON schema.

## Testing

- Unit, `RelayBudget`: window slides; `0` disables; over-budget calls don't consume; idle keys
  evicted; notice once per window.
- Unit, gateway: budgeted send deferred with digest item, event, notice and result; second
  over-budget send in the window gets no notice; each exemption (system notification,
  `humanApproved`, `principalDirected`, principal/system/agent originators, `trusted`, no
  originator, principal not sole recipient) delivers normally; missing tier is budgeted;
  digest publish failure delivers the relay; notice failure still defers.
- Unit, skills: each of the four passes `originator` and surfaces `deferredToDigest`.
- Report queue: a `relay_deferred` row lists with its own source (unit, `report-queue.test.ts`). No integration test: `principal.report` already reaches `audit_log` through the audit logger like every other source, and the only new code on that path is the `SOURCE_KEYS` entry.

## Out of scope

- A global cap across all originators (one sender with many throwaway addresses). The inbound
  rate limiter caps per-sender volume per minute; revisit with #2193's numbers.
- A durable counter.
- Tuning `per_hour`: #2193's two-week metrics feed that.
