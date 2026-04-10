# Sender Trust & Routing — Completion Design

**Issue:** josephfung/curia#192  
**Date:** 2026-04-09  
**Branch:** feat/sender-trust

## Context

Most of issue #192 is already implemented: migration 020 (trust columns), `trust-scorer.ts`, the full dispatcher trust pipeline, unknown-sender routing, trust floor, configurable weights, and coordinator system prompt thresholds. Two acceptance criteria remain open:

1. **`routingDecision` on `contact.unknown` event** — the AC requires the event to include the routing decision alongside sender, channel, and score. The event is currently published before policy is evaluated, so it lacks this field.
2. **Test coverage** — the AC requires an integration test for the unknown-sender → `hold_and_notify` path with a correct `messageTrustScore`. We will address this with both a unit-level payload assertion and an integration scenario in the existing vertical-slice suite.

---

## Change 1: `routingDecision` on `contact.unknown`

### Event schema (`src/bus/events.ts`)

Add `routingDecision: UnknownSenderPolicy` to `ContactUnknownPayload`:

```typescript
interface ContactUnknownPayload {
  channel: string;
  senderId: string;
  channelTrustLevel: 'low' | 'medium' | 'high';
  messageTrustScore: number;
  routingDecision: 'allow' | 'hold_and_notify' | 'ignore';
}
```

`UnknownSenderPolicy` is already defined in `src/contacts/types.ts`; we reuse it here rather than duplicating the union.

### Dispatcher restructure (`src/dispatch/dispatcher.ts`)

In the unknown-sender branch, the current order is:
1. Publish `contact.unknown` (without routing decision)
2. Read policy
3. Execute routing

We reorder to:
1. Read policy (pure lookup, no side effects)
2. Determine `routingDecision`: `'hold_and_notify'` if policy is `hold_and_notify` and `heldMessages` is available; `'ignore'` if policy is `ignore`; otherwise `'allow'`
3. Publish `contact.unknown` with all four fields
4. Execute routing (unchanged logic)

No behavior change — only the publish call moves after the policy lookup.

---

## Change 2: Unit test — `contact.unknown` payload

In `tests/unit/dispatch/dispatcher.test.ts`, add three cases to the existing `Dispatcher — messageTrustScore` describe block. Each test uses `makeResolverWithNoContact()`, captures the `contact.unknown` event off the bus, and asserts the full payload:

| Test | Channel policy | Expected `routingDecision` | Expected `messageTrustScore` |
|---|---|---|---|
| hold_and_notify channel | email / hold_and_notify | `'hold_and_notify'` | ≈ 0.12 (low channel, 0.0 confidence) |
| ignore channel | http / ignore | `'ignore'` | ≈ 0.12 |
| allow channel | cli / allow | `'allow'` | ≈ 0.4 (high channel, 0.0 confidence) |

These tests require no DB and run in < 5 ms each.

---

## Change 3: Integration scenario — `vertical-slice.test.ts`

Add one scenario to the existing integration suite. Setup reuses the test DB and the real `HeldMessageService`. The dispatcher is wired with:
- Real `HeldMessageService` (backed by the `held_messages` table)
- A mock `ContactResolver` returning an unknown sender (no real DB contact lookup needed — the resolver interface is thin and the test is about dispatcher + DB, not resolver logic)
- Channel policies: `{ email: { trust: 'low', unknownSender: 'hold_and_notify' } }`

**Scenario:** email arrives from `stranger@example.com` (no contact record).

**Assertions:**
1. No `agent.task` event published
2. `message.held` event published with `senderId: 'stranger@example.com'`, `channel: 'email'`
3. `contact.unknown` event has `routingDecision: 'hold_and_notify'` and `messageTrustScore` ≈ 0.12
4. `SELECT COUNT(*) FROM held_messages WHERE sender_id = 'stranger@example.com'` returns 1

---

## What is NOT in scope

- `last_seen_at` write-back: the migration adds the column; updating it on each inbound message is explicitly deferred via a TODO in `contact-service.ts` and has no AC checkbox in this issue.
- `contact_confidence` accumulation: future scoring infrastructure.
- Any other open items in the spec 06 completion table (rate limiting, SPF/DKIM, etc.) — those are separate issues.
