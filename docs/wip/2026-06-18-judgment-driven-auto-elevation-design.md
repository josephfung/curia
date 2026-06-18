# Judgment-Driven Auto-Elevation — Design

**Issue:** #951
**Milestone:** v0.36 — Contacts redesign
**Depends on:** #945 (unified tier + kind — closed/merged)
**Date:** 2026-06-18

---

## Context

The contact ledger currently starts every new sender at `tier='unknown'`. Promotion to `tier='known'` has no automated path — it requires a manual confirm step, which contradicts the goal of a self-maintaining entity database. This design adds three automated elevation paths that match how a good EA would manage a contact list: act on signals, don't ask for confirmation.

`known` only unlocks light principal context and availability disclosure. Third-party PII and confidential content always escalate regardless of tier (the bounded profile is the guardrail). This means false positives from generous elevation are low-cost.

Demotion fires only on an explicit negative signal (blocked, marked spam, Joseph says so) — never on inactivity.

`kind='automated'` contacts skip all elevation logic. The tier gate already bypasses them on inbound; auto-elevation should not apply either.

---

## Three Elevation Paths

### Path 1: Correspondence (`unknown → known`)

**Trigger:** `email-reply` or `email-send` skill succeeds (Joseph or Curia sends outbound email to the contact).

**Rationale:** An explicit outbound to someone is the clearest possible signal that the relationship is real.

**Hook:** `Dispatcher.handleSkillResult()` — already parses the `to` field for the reply-lock. After reply-lock logic, resolve each recipient email via `this.contactResolver.resolve('email', address)` (read — already wired) and call `this.contactService.elevateTierToKnown(contactId, 'correspondence')` (write — new field).

**Scope:** Only contacts that already exist in the DB (resolved contactId). Brand-new outbound targets have no contact record yet; they get created and elevated when they reply (path 2 handles org replies; path 3 handles person replies).

**Note on outbound gating:** The tier gate is inbound-only. The outbound gateway only blocks `tier='blocked'` contacts; unknown-tier contacts pass through unconditionally. Elevation is not a prerequisite for sending.

---

### Path 2: Domain-Validated Org (`unknown → known`)

**Trigger:** First (or any) inbound from a contact with `kind='organization'` and `tier='unknown'`.

**Rationale:** Repeated receipt from a resolvable business domain that is never blocked or marked spam is sufficient. No interaction required. DKIM/DMARC alignment is a corroborating bonus, not a gate.

**Hook:** `Dispatcher.handleInboundMessage()` — after contact resolution succeeds and `senderContext.kind === 'organization' && senderContext.tier === 'unknown'`, call `contactService.elevateTierToKnown(contactId, 'domain-validated')`. Fire-and-forget.

---

### Path 3: Judgment (`unknown → known`)

**Trigger:** `contact_confidence` crosses `JUDGMENT_ELEVATION_THRESHOLD` (0.20) after a confidence update.

**Rationale:** A person who has sent a handful of recent emails "seems reasonable" to a good EA — accumulated signals are sufficient without requiring an explicit reply. The 0.20 threshold requires either recent activity (the recency component alone is worth 0.20) or a moderate history of messages.

**Hook:** `Dispatcher.handleInboundMessage()` — after `confidencePipeline.incrementalUpdate()` returns the new confidence value, check: `senderContext.tier === 'unknown' && !isAutomatedKind(senderContext.kind) && newConfidence >= JUDGMENT_ELEVATION_THRESHOLD`. If true, call `contactService.elevateTierToKnown(contactId, 'judgment')`. Fire-and-forget, chained on the confidence update promise.

**Threshold constant:** `JUDGMENT_ELEVATION_THRESHOLD = 0.20`, exported from `src/contacts/confidence-scorer.ts` alongside the existing tunable constants (`SATURATION`, `W_INTERACTION`, etc.).

---

## Components

### 1. `ContactService.elevateTierToKnown(contactId, reason)`

New method on `ContactService` and `ContactServiceBackend`.

**Backend SQL (atomic, TOCTOU-safe):**
```sql
UPDATE contacts
SET tier = 'known', updated_at = now()
WHERE id = $1
  AND tier = 'unknown'
  AND kind NOT IN ('automated', 'agent')
```

Returns `true` if a row was updated, `false` otherwise (already known/blocked/trusted/principal, or automated). Same pattern as `promoteToConfirmed()`.

**Service method:** Calls the backend, logs provenance with `reason` at `info` level on success, `warn` on DB error. Non-throwing — catches internally and returns `false` on error. The `reason` parameter (`'correspondence' | 'domain-validated' | 'judgment'`) is recorded in the structured log only (not persisted to the DB), consistent with the issue's "audit log only" decision.

**`InMemoryContactBackend`:** Implements the same guard logic in-memory for tests.

### 2. `DispatcherConfig` — new optional field

```typescript
contactService?: ContactService;
```

Same injection pattern as `confidencePipeline`. When absent, all three elevation paths are silently skipped.

### 3. `ConfidencePipeline.incrementalUpdate()` — return type change

Changes from `Promise<void>` to `Promise<number>`. Returns `newConfidence` after persisting the update. Allows the dispatcher to chain judgment elevation without a separate DB read. Backward-compatible — existing callers that ignore the return value are unaffected.

### 4. `contact.elevated` bus event

Added to `src/bus/events.ts`:

```typescript
type: 'contact.elevated';
payload: {
  contactId: string;
  reason: 'correspondence' | 'domain-validated' | 'judgment';
  parentEventId?: string;
}
```

Emitted by `ContactService.elevateTierToKnown()` on success via an optional `onContactElevated` callback added to `ContactServiceOptions` (same callback pattern as `onContactMerged`). The callback is wired in `src/index.ts` to publish the bus event on the `'dispatch'` topic. Provides an audit trail consistent with `contact.resolved`, `contact.merged`, etc.

---

## Data Flow Summary

```
Inbound email arrives
  → contact-resolver resolves sender
  → kind='organization' && tier='unknown'?  → elevateTierToKnown('domain-validated')  [Path 2]
  → confidence pipeline updates
  → newConfidence >= 0.20 && tier='unknown' && !automated? → elevateTierToKnown('judgment')  [Path 3]

Outbound email-reply / email-send succeeds
  → parse `to` recipients
  → resolve each to contactId
  → elevateTierToKnown('correspondence') for each resolved contactId  [Path 1]
```

---

## Error Handling

All elevation calls are fire-and-forget. Failures must never drop an inbound message or block an outbound send.

- `elevateTierToKnown()` catches internally, logs at `warn`, returns `false`
- Call sites use `.catch(err => this.logger.warn(...))` on the promise chain
- Transient DB failures: contact stays at `unknown`, elevation retries on the next qualifying event — no manual recovery needed

---

## Testing

### `contact-service.test.ts`
- `elevateTierToKnown()` from `unknown` → succeeds, returns `true`, tier is `'known'`
- From `known` → no-op, returns `false`
- From `blocked` → no-op, returns `false`
- From `trusted` / `principal` → no-op, returns `false`
- `kind='automated'` with `tier='unknown'` → no-op, returns `false`
- `kind='agent'` with `tier='unknown'` → no-op, returns `false`
- On DB error → returns `false`, does not throw

### `confidence-pipeline.test.ts`
- `incrementalUpdate()` returns the new confidence value (return-type change)

### `dispatcher.test.ts`
- Correspondence: mock `email-reply` result with `to` field; assert `elevateTierToKnown('correspondence')` called for resolved contact
- Correspondence: recipient resolves to `null` (no contact yet) → no elevation call
- Domain-validated: mock inbound with `kind='organization'`, `tier='unknown'`; assert elevation called
- Domain-validated: `kind='organization'`, `tier='known'` → no elevation call
- Judgment: mock confidence update returning 0.22; `tier='unknown'`, `kind='person'`; assert elevation called
- Judgment: mock confidence update returning 0.18 → no elevation call
- Judgment: mock confidence update returning 0.22; `kind='automated'` → no elevation call
- No `contactService` wired → all paths silently skip, no error

---

## What This Does Not Change

- Demotion logic — unchanged. Only explicit negative signals (blocked, spam, Joseph says so) demote a contact.
- `kind='automated'` routing — unchanged. Automated contacts bypass the tier gate on inbound and are excluded from all elevation paths.
- Disclosure behavior — provenance (`correspondence` / `domain-validated` / `judgment`) is audit-log only. All `known` contacts get the same runtime treatment regardless of how they were elevated.
- No DB migration needed — `elevateTierToKnown()` writes to the existing `tier` column (migration 055).
