# CEO Recipient Bypass for Outbound Autonomy Gate

**Date:** 2026-05-05
**Issue:** #454 — Approval/denial lifecycle rollback when notification email is gated
**Status:** Design

## Problem

When an approval or denial is submitted via email and the autonomy score is below
the outbound email threshold (< 70), the coordinator's confirmation reply to the
CEO gets gated by the outbound gateway. This creates a new `pending_approval` row
for the gated reply, making it appear that the original request is still pending
even though the approval state transition succeeded at the DB level.

More broadly, gating communications *to the CEO* is counterproductive. The
autonomy gate exists to prevent the agent from autonomously reaching out to
external parties when trust is low. Communications to the CEO are the opposite —
they are the agent reporting to its principal. Gating these reduces oversight
rather than improving it, and causes the agent to go effectively mute to its own
oversight authority.

## Design

### Core Change: CEO Recipient Bypass in Outbound Gateway

In `outbound-gateway.ts send()`, the autonomy gate (Step 0) currently has three
bypass branches:

1. `humanApproved` — CEO explicitly authorized a re-execution
2. `isSystemNotification` — infrastructure alert to CEO
3. Default — check score, block if below threshold

Add a fourth branch between `isSystemNotification` and the default:

4. **Recipient is CEO** — agent-to-principal communication

The check resolves the recipient from the request:

- **Email:** `request.to` compared case-insensitively against `this.ceoEmail`
- **Signal:** `request.recipient` compared against `this.ceoSignalNumber` (new
  config field)

If either matches, the autonomy gate is skipped. All other safety checks
(blocked-contact, content filter, PII redaction) still run. This is purely an
autonomy-gate bypass — it says "you're allowed to send to the CEO without score
gating," not "anything goes."

### Config Change: `ceoSignalNumber`

`OutboundGatewayConfig` gets a new optional field:

```typescript
ceoSignalNumber?: string;  // E.164 format, e.g. "+14155551234"
```

Sourced from a new `CEO_SIGNAL_NUMBER` env var, parsed in `src/config.ts`
(same pattern as `CEO_PRIMARY_EMAIL` → `ceoPrimaryEmail`), and wired through
`src/index.ts` to the gateway config. If not configured, the Signal bypass
does not fire (same pattern as `ceoEmail` — absent means the feature is inert,
not broken).

### Logging

The CEO-recipient bypass logs at `info` level, matching the existing pattern:

```
outbound-gateway: autonomy gate skipped — recipient is CEO
  (agent-to-principal communication)
```

Includes `channel` in the log context so operators can distinguish email vs
Signal bypasses.

No new bus event. The existing audit trail (outbound.message event + gateway
send logs) captures the send. The bypass means `autonomy.send_blocked` is never
published for CEO-bound messages, which is the desired behavior.

### What This Does NOT Change

- **Execution layer gates (A and B)** — unchanged. Skills are still gated by
  their `action_risk` threshold regardless of who the eventual recipient is. The
  execution layer doesn't know the recipient at gate time, and that's correct.
- **Content filter** — still runs on CEO-bound messages. Defense-in-depth.
- **PII redaction** — still runs.
- **Blocked-contact check** — still runs (the CEO should never be blocked, but
  the check is harmless).
- **`isSystemNotification` path** — unchanged. System notifications continue as
  before; the CEO bypass is a separate, broader exemption.

## Test Strategy

### Unit Tests (outbound gateway)

1. **CEO email bypass** — send to CEO email at score 69, gate skipped, send
   succeeds.
2. **CEO Signal bypass** — send to CEO Signal number at score 69, gate skipped.
3. **Case-insensitive email match** — CEO email is `Joseph@Example.com`,
   recipient is `joseph@example.com`, bypass fires.
4. **Non-CEO still gated** — send to third-party email at score 69, gate blocks.
5. **CEO bypass + content filter still runs** — send to CEO with content that
   triggers the filter, verify it's still blocked.
6. **No ceoEmail configured** — send to any address at score 69, bypass doesn't
   fire, normal gating applies.

### Integration Test (acceptance criterion #4 from issue)

Approve and deny at score 69: confirm the row state transitions to
`approved`/`denied` and `list-pending-actions` excludes the resolved request.
Validates that the confirmation reply to the CEO goes through instead of
creating a phantom pending row.

## Future Work

The current approach adds `ceoSignalNumber` as a standalone config field
alongside `ceoEmail`. This sets a precedent of per-channel config parameters —
each new channel requires a new field on `OutboundGatewayConfig` and wiring in
`src/index.ts`. A tracked issue should be filed to refactor toward a
`CeoIdentity` map (channel → identifier) that scales without per-field changes.
