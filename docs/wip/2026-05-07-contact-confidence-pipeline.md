# Contact Confidence Scoring Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `contact_confidence` scoring pipeline so that trust scoring uses all three formula components (channel weight, contact confidence, injection risk) instead of treating every contact as zero-confidence.

**Architecture:** A pure scoring formula (`confidence-scorer.ts`) separated from the orchestrator (`confidence-pipeline.ts`) that reads/writes DB state. Both incremental and full-recompute paths call the same formula over the same stored columns, guaranteeing convergence. The outbound-gateway's `setTrustLevel('high')` band-aid is removed.

**Tech Stack:** TypeScript (ESM), PostgreSQL, Vitest, node-pg-migrate

**Spec:** `docs/wip/2026-05-07-contact-confidence-pipeline-design.md`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/db/migrations/034_add_message_counts.sql` | Add `inbound_message_count` and `outbound_message_count` to contacts |
| Modify | `src/contacts/types.ts:3-16` | Add `inboundMessageCount` and `outboundMessageCount` to `Contact` interface |
| Create | `src/contacts/confidence-scorer.ts` | Pure formula: `computeConfidence(inputs) → number` |
| Create | `src/contacts/confidence-pipeline.ts` | Orchestrator: `incrementalUpdate()`, `fullRecompute()`, `fullRecomputeAll()` |
| Modify | `src/contacts/contact-service.ts:40-76` | Add `updateScoringFields()` to `ContactServiceBackend` interface |
| Modify | `src/contacts/contact-service.ts:745-863` | Implement `updateScoringFields()` in `PostgresContactBackend`, update `rowToContact()` and all SELECT queries |
| Modify | `src/contacts/contact-service.ts:1225-1489` | Implement `updateScoringFields()` in `InMemoryContactBackend`, update `rowToContact()` equivalent |
| Modify | `src/dispatch/dispatcher.ts:41-73` | Add `confidencePipeline` to `DispatcherConfig` |
| Modify | `src/dispatch/dispatcher.ts:~237` | Fire `message_seen` after resolving a known sender |
| Modify | `src/skills/outbound-gateway.ts:108-194` | Add `confidencePipeline` to `OutboundGatewayConfig` |
| Modify | `src/skills/outbound-gateway.ts:~884-935` | Remove `setTrustLevel('high')` band-aid, add `message_sent` |
| Modify | `skills/contact-set-trust/handler.ts` | Fire `trust_grant` after `setTrustLevel()` |
| Modify | `src/contacts/contact-service.ts:~408-448` | Fire `pairing_confirmed` in `linkIdentity()` when verified |
| Modify | `src/index.ts:~715,~1087` | Wire `ConfidencePipeline` into Dispatcher and OutboundGateway |
| Modify | `src/skills/types.ts:~127` | Add `confidencePipeline` to `SkillContext` |
| Create | `tests/unit/contacts/confidence-scorer.test.ts` | Unit tests for the pure formula |
| Create | `tests/unit/contacts/confidence-pipeline.test.ts` | Unit tests for the orchestrator |
| Modify | `tests/unit/dispatch/dispatcher.test.ts` | Update expectations for `message_seen` firing |
| Modify | `tests/unit/skills/outbound-gateway.test.ts` | Update expectations: remove `setTrustLevel('high')`, add `message_sent` |

---

## Task 1: Migration — add message count columns

**Files:**
- Create: `src/db/migrations/034_add_message_counts.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Up Migration

-- Add message count columns for the contact confidence scoring pipeline.
-- These are scoring-owned — updated by ConfidencePipeline, not by ContactService.updateContact().
ALTER TABLE contacts ADD COLUMN inbound_message_count INT NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN outbound_message_count INT NOT NULL DEFAULT 0;

ALTER TABLE contacts ADD CONSTRAINT contacts_inbound_message_count_check
  CHECK (inbound_message_count >= 0);
ALTER TABLE contacts ADD CONSTRAINT contacts_outbound_message_count_check
  CHECK (outbound_message_count >= 0);
```

- [ ] **Step 2: Verify migration numbering**

Run: `ls src/db/migrations/ | sort`

Verify `034` is unique. If another branch landed a `034` migration, renumber to the next available slot.

- [ ] **Step 3: Commit**

```
git add src/db/migrations/034_add_message_counts.sql
git commit -m "feat: add inbound/outbound message count columns to contacts (migration 034)"
```

---

## Task 2: Update Contact type and backends

**Files:**
- Modify: `src/contacts/types.ts:3-16`
- Modify: `src/contacts/contact-service.ts:40-76` (backend interface)
- Modify: `src/contacts/contact-service.ts:745-863` (Postgres backend)
- Modify: `src/contacts/contact-service.ts:1225-1489` (in-memory backend)

- [ ] **Step 1: Add fields to the Contact interface**

In `src/contacts/types.ts`, add two fields to the `Contact` interface after `lastSeenAt`:

```typescript
export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  // Trust scoring fields (migration 020)
  contactConfidence: number;         // 0.0–1.0; accumulated over time
  trustLevel: TrustLevel | null;     // nullable per-contact override
  lastSeenAt: Date | null;
  // Message count fields (migration 034) — scoring-owned
  inboundMessageCount: number;
  outboundMessageCount: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 2: Add `updateScoringFields()` to the backend interface**

In `src/contacts/contact-service.ts`, add to the `ContactServiceBackend` interface (after `deleteContact`):

```typescript
  /**
   * Update scoring-owned fields on a contact. Uses atomic increments for message
   * counts to avoid read-modify-write races. Only touches scoring-owned columns —
   * does not modify display_name, role, status, notes, or trust_level.
   */
  updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void>;
```

- [ ] **Step 3: Update all Postgres SELECT queries to include the new columns**

In `PostgresContactBackend`, every query that selects from `contacts` must include `inbound_message_count` and `outbound_message_count`. Update the type annotations and query strings in these methods:
- `getContact()` (~line 761)
- `findContactByName()` (~line 786)
- `findContactByRole()` (~line 812)
- `listContacts()` (~line 833)
- `resolveByChannelIdentity()` (~line 910) — this one does NOT need the counts (it returns `ResolvedSender`, not `Contact`)

For each, add to the type annotation:

```typescript
inbound_message_count: string;  // INT returned as string by node-pg
outbound_message_count: string;
```

And add to the SELECT column list:

```sql
inbound_message_count, outbound_message_count
```

- [ ] **Step 4: Update `rowToContact()` in `PostgresContactBackend`**

At ~line 1132, add the new fields to the row type and mapping:

```typescript
private rowToContact(row: {
    id: string;
    kg_node_id: string | null;
    display_name: string;
    role: string | null;
    status: string;
    contact_confidence: string;
    trust_level: string | null;
    last_seen_at: Date | null;
    inbound_message_count: string;
    outbound_message_count: string;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
  }): Contact {
    return {
      // ... existing fields unchanged ...
      inboundMessageCount: parseInt(row.inbound_message_count, 10) || 0,
      outboundMessageCount: parseInt(row.outbound_message_count, 10) || 0,
      // ... rest unchanged ...
    };
  }
```

- [ ] **Step 5: Implement `updateScoringFields()` in `PostgresContactBackend`**

Add after `updateContact()` (~line 863):

```typescript
  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    this.logger.debug({ contactId }, 'contacts: updating scoring fields');
    await this.pool.query(
      `UPDATE contacts
       SET contact_confidence = $2,
           inbound_message_count = inbound_message_count + $3,
           outbound_message_count = outbound_message_count + $4,
           last_seen_at = COALESCE($5, last_seen_at),
           updated_at = now()
       WHERE id = $1`,
      [
        contactId,
        updates.contactConfidence,
        updates.inboundMessageCountDelta ?? 0,
        updates.outboundMessageCountDelta ?? 0,
        updates.lastSeenAt ?? null,
      ],
    );
  }
```

- [ ] **Step 6: Update `InMemoryContactBackend`**

In the in-memory backend (~line 1225), update `resolveByChannelIdentity()` to include the new fields in `ResolvedSender` — but `ResolvedSender` doesn't have message counts, so no change needed there.

Update the `updateContact()` method — it already does `this.contacts.set(contact.id, contact)` so it handles any `Contact` shape.

Add `updateScoringFields()`:

```typescript
  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    const contact = this.contacts.get(contactId);
    if (!contact) return;
    this.contacts.set(contactId, {
      ...contact,
      contactConfidence: updates.contactConfidence,
      inboundMessageCount: contact.inboundMessageCount + (updates.inboundMessageCountDelta ?? 0),
      outboundMessageCount: contact.outboundMessageCount + (updates.outboundMessageCountDelta ?? 0),
      lastSeenAt: updates.lastSeenAt ?? contact.lastSeenAt,
      updatedAt: new Date(),
    });
  }
```

- [ ] **Step 7: Update `createContact()` defaults**

In `ContactService.createContact()` (~line 187), add the new fields to the contact object:

```typescript
const contact: Contact = {
  // ... existing fields ...
  contactConfidence: 0,
  trustLevel: null,
  lastSeenAt: null,
  inboundMessageCount: 0,
  outboundMessageCount: 0,
  // ... rest ...
};
```

- [ ] **Step 8: Run existing tests to verify nothing breaks**

Run: `npx vitest run tests/unit/contacts/contact-service.test.ts`

Expected: all existing tests pass (the new fields have defaults so existing test fixtures still work).

- [ ] **Step 9: Commit**

```
git add src/contacts/types.ts src/contacts/contact-service.ts
git commit -m "feat: add message count fields to Contact type and backends"
```

---

## Task 3: Pure scoring formula

**Files:**
- Create: `src/contacts/confidence-scorer.ts`
- Create: `tests/unit/contacts/confidence-scorer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/contacts/confidence-scorer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  SATURATION,
  W_INTERACTION,
  W_RECENCY,
  GRANT_BOOST,
  MANUAL_BOOST,
  PAIRING_BOOST,
  RECENCY_HALF_LIFE_DAYS,
  type ConfidenceInput,
} from '../../../src/contacts/confidence-scorer.js';

// Helper to build inputs with sensible defaults
function input(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    lastSeenAt: null,
    trustLevel: null,
    verifiedIdentityCount: 0,
    hasCeoStatedIdentity: false,
    now: new Date('2026-01-15T12:00:00Z'),
    ...overrides,
  };
}

describe('computeConfidence', () => {
  it('returns 0 for a brand-new contact with no signals', () => {
    expect(computeConfidence(input())).toBe(0);
  });

  it('returns > 0 after first inbound message', () => {
    const score = computeConfidence(input({
      inboundMessageCount: 1,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    expect(score).toBeGreaterThan(0);
  });

  it('interaction score saturates at SATURATION messages', () => {
    const at20 = computeConfidence(input({
      inboundMessageCount: SATURATION,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const at200 = computeConfidence(input({
      inboundMessageCount: 200,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    expect(at20).toBe(at200);
  });

  it('outbound messages contribute to interaction score', () => {
    const inboundOnly = computeConfidence(input({
      inboundMessageCount: 5,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const withOutbound = computeConfidence(input({
      inboundMessageCount: 5,
      outboundMessageCount: 5,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    expect(withOutbound).toBeGreaterThan(inboundOnly);
  });

  it('recency decays with half-life', () => {
    const today = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const ninetyDaysAgo = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2025-10-17T12:00:00Z'), // ~90 days before now
    }));
    const yearAgo = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2025-01-15T12:00:00Z'),
    }));

    expect(today).toBeGreaterThan(ninetyDaysAgo);
    expect(ninetyDaysAgo).toBeGreaterThan(yearAgo);
  });

  it('recency is 0 when lastSeenAt is null', () => {
    // 5 messages but never seen (e.g. outbound-only contact)
    const score = computeConfidence(input({
      outboundMessageCount: 5,
    }));
    // Should have interaction score but no recency
    const interactionOnly = (5 / SATURATION) * W_INTERACTION;
    expect(score).toBeCloseTo(interactionOnly);
  });

  it('CEO trust grant provides GRANT_BOOST', () => {
    const withoutGrant = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const withGrant = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
      trustLevel: 'high',
    }));
    expect(withGrant - withoutGrant).toBeCloseTo(GRANT_BOOST);
  });

  it('CEO-verified contact scores meaningfully higher than auto-resolved with same volume', () => {
    const autoResolved = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const ceoVerified = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
      trustLevel: 'high',
      hasCeoStatedIdentity: true,
    }));
    // CEO-verified should be at least 0.2 higher
    expect(ceoVerified - autoResolved).toBeGreaterThanOrEqual(0.2);
  });

  it('manual entry (ceo_stated identity) provides MANUAL_BOOST', () => {
    const without = computeConfidence(input());
    const with_ = computeConfidence(input({ hasCeoStatedIdentity: true }));
    expect(with_ - without).toBeCloseTo(MANUAL_BOOST);
  });

  it('verified identities provide pairing boost capped at 3', () => {
    const one = computeConfidence(input({ verifiedIdentityCount: 1 }));
    const three = computeConfidence(input({ verifiedIdentityCount: 3 }));
    const ten = computeConfidence(input({ verifiedIdentityCount: 10 }));
    expect(three).toBeGreaterThan(one);
    expect(ten).toBe(three); // capped at 3
  });

  it('result is clamped to [0.0, 1.0]', () => {
    // Max everything out
    const score = computeConfidence(input({
      inboundMessageCount: 1000,
      outboundMessageCount: 1000,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
      trustLevel: 'high',
      hasCeoStatedIdentity: true,
      verifiedIdentityCount: 100,
    }));
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  it('result is never negative', () => {
    // All zeros — should be exactly 0, not negative
    expect(computeConfidence(input())).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/contacts/confidence-scorer.test.ts`

Expected: FAIL — module `confidence-scorer.js` does not exist.

- [ ] **Step 3: Implement the scorer**

Create `src/contacts/confidence-scorer.ts`:

```typescript
// src/contacts/confidence-scorer.ts
//
// Pure contact confidence scoring formula. No I/O — takes pre-fetched contact
// stats and identity data, returns a float in [0.0, 1.0].
//
// Both the incremental and full-recompute paths call this function. Convergence
// is guaranteed because both paths use the same stored columns as inputs.

import type { TrustLevel } from './types.js';

// -- Tunable constants (exported for tests and documentation) --

/** Messages beyond this count produce no additional interaction score. */
export const SATURATION = 20;

/** Weight of the interaction (message volume) component. Max contribution: 0.35. */
export const W_INTERACTION = 0.35;

/** Weight of the recency component. Max contribution: 0.20. */
export const W_RECENCY = 0.20;

/** Half-life for recency decay in days. Score halves every 90 days of silence. */
export const RECENCY_HALF_LIFE_DAYS = 90;

/** Confidence boost when the CEO has explicitly set a trust level on this contact. */
export const GRANT_BOOST = 0.25;

/** Confidence boost when the contact was manually created by the CEO (ceo_stated identity). */
export const MANUAL_BOOST = 0.10;

/** Max confidence boost from verified identity pairings. Capped at 3 identities. */
export const PAIRING_BOOST = 0.10;

/** Max number of verified identities that contribute to the pairing score. */
const MAX_PAIRING_IDENTITIES = 3;

export interface ConfidenceInput {
  inboundMessageCount: number;
  outboundMessageCount: number;
  lastSeenAt: Date | null;
  trustLevel: TrustLevel | null;
  verifiedIdentityCount: number;
  hasCeoStatedIdentity: boolean;
  /** Current time — injected for testability. */
  now: Date;
}

/**
 * Compute contact confidence from stored stats and identity data.
 *
 * Formula:
 *   interactionScore = min(totalMessages / SATURATION, 1.0) × W_INTERACTION
 *   recencyScore     = lastSeenAt ? exp(-daysSince / HALF_LIFE) × W_RECENCY : 0
 *   verificationScore = grantBoost + manualBoost + pairingBoost
 *   confidence       = clamp(interaction + recency + verification, 0.0, 1.0)
 */
export function computeConfidence(input: ConfidenceInput): number {
  const {
    inboundMessageCount,
    outboundMessageCount,
    lastSeenAt,
    trustLevel,
    verifiedIdentityCount,
    hasCeoStatedIdentity,
    now,
  } = input;

  // Interaction score: message volume with saturation
  const totalMessages = inboundMessageCount + outboundMessageCount;
  const interactionScore = Math.min(totalMessages / SATURATION, 1.0) * W_INTERACTION;

  // Recency score: exponential decay from last inbound message
  let recencyScore = 0;
  if (lastSeenAt) {
    const daysSinceLastSeen = (now.getTime() - lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = Math.exp(-daysSinceLastSeen / RECENCY_HALF_LIFE_DAYS) * W_RECENCY;
  }

  // Verification score: discrete boosts from CEO actions and identity pairings
  const grantBoost = trustLevel !== null ? GRANT_BOOST : 0;
  const manualBoost = hasCeoStatedIdentity ? MANUAL_BOOST : 0;
  const pairingBoost =
    (Math.min(verifiedIdentityCount, MAX_PAIRING_IDENTITIES) / MAX_PAIRING_IDENTITIES) * PAIRING_BOOST;
  const verificationScore = grantBoost + manualBoost + pairingBoost;

  // Clamp to [0.0, 1.0]
  const raw = interactionScore + recencyScore + verificationScore;
  return Math.max(0.0, Math.min(1.0, raw));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/contacts/confidence-scorer.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/contacts/confidence-scorer.ts tests/unit/contacts/confidence-scorer.test.ts
git commit -m "feat: add pure contact confidence scoring formula"
```

---

## Task 4: Confidence pipeline orchestrator

**Files:**
- Create: `src/contacts/confidence-pipeline.ts`
- Create: `tests/unit/contacts/confidence-pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/contacts/confidence-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { ConfidencePipeline } from '../../../src/contacts/confidence-pipeline.js';
import type { Contact } from '../../../src/contacts/types.js';

describe('ConfidencePipeline', () => {
  let service: ContactService;
  let pipeline: ConfidencePipeline;

  beforeEach(() => {
    service = ContactService.createInMemory();
    pipeline = new ConfidencePipeline(service);
  });

  async function createTestContact(overrides: { source?: string } = {}): Promise<Contact> {
    return service.createContact({
      displayName: 'Test Contact',
      source: overrides.source ?? 'email_participant',
    });
  }

  describe('incrementalUpdate — message_seen', () => {
    it('increments inbound count and updates lastSeenAt', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen' });

      const updated = await service.getContact(contact.id);
      expect(updated!.inboundMessageCount).toBe(1);
      expect(updated!.lastSeenAt).not.toBeNull();
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });

    it('respects count parameter for bulk import', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 15 });

      const updated = await service.getContact(contact.id);
      expect(updated!.inboundMessageCount).toBe(15);
    });
  });

  describe('incrementalUpdate — message_sent', () => {
    it('increments outbound count but does not update lastSeenAt', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_sent' });

      const updated = await service.getContact(contact.id);
      expect(updated!.outboundMessageCount).toBe(1);
      expect(updated!.lastSeenAt).toBeNull();
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });

    it('respects count parameter', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_sent', count: 5 });

      const updated = await service.getContact(contact.id);
      expect(updated!.outboundMessageCount).toBe(5);
    });
  });

  describe('incrementalUpdate — trust_grant', () => {
    it('recomputes confidence with trust level signal', async () => {
      const contact = await createTestContact();
      // Simulate CEO setting trust level (done before pipeline fires)
      await service.setTrustLevel(contact.id, 'high');
      await pipeline.incrementalUpdate(contact.id, { type: 'trust_grant' });

      const updated = await service.getContact(contact.id);
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });
  });

  describe('incrementalUpdate — pairing_confirmed', () => {
    it('recomputes confidence with verified identity signal', async () => {
      const contact = await createTestContact();
      await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'test@example.com',
        source: 'email_participant',
      });
      await pipeline.incrementalUpdate(contact.id, { type: 'pairing_confirmed' });

      const updated = await service.getContact(contact.id);
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });
  });

  describe('fullRecompute', () => {
    it('produces same score as incremental path for identical history', async () => {
      const contact = await createTestContact();

      // Build up via incremental updates
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 5 });
      await pipeline.incrementalUpdate(contact.id, { type: 'message_sent', count: 3 });
      const afterIncremental = await service.getContact(contact.id);

      // Now full recompute
      await pipeline.fullRecompute(contact.id);
      const afterRecompute = await service.getContact(contact.id);

      expect(afterRecompute!.contactConfidence).toBeCloseTo(afterIncremental!.contactConfidence);
    });

    it('is idempotent — running twice gives the same result', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 10 });

      await pipeline.fullRecompute(contact.id);
      const first = await service.getContact(contact.id);

      await pipeline.fullRecompute(contact.id);
      const second = await service.getContact(contact.id);

      expect(second!.contactConfidence).toBe(first!.contactConfidence);
    });

    it('does not modify message counts or lastSeenAt', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 7 });
      const before = await service.getContact(contact.id);

      await pipeline.fullRecompute(contact.id);
      const after = await service.getContact(contact.id);

      expect(after!.inboundMessageCount).toBe(before!.inboundMessageCount);
      expect(after!.outboundMessageCount).toBe(before!.outboundMessageCount);
      expect(after!.lastSeenAt?.getTime()).toBe(before!.lastSeenAt?.getTime());
    });
  });

  describe('fullRecomputeAll', () => {
    it('recomputes all contacts and returns count', async () => {
      await createTestContact();
      await createTestContact();
      const count = await pipeline.fullRecomputeAll();
      expect(count).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('skips CEO contacts (role = ceo)', async () => {
      const ceo = await service.createContact({
        displayName: 'CEO',
        role: 'ceo',
        source: 'ceo_stated',
      });
      // Should not throw and should not modify the contact
      await pipeline.incrementalUpdate(ceo.id, { type: 'message_seen' });
      const after = await service.getContact(ceo.id);
      expect(after!.inboundMessageCount).toBe(0);
    });

    it('ignores unknown contactId', async () => {
      // Should not throw
      await pipeline.incrementalUpdate('nonexistent-id', { type: 'message_seen' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/contacts/confidence-pipeline.test.ts`

Expected: FAIL — module `confidence-pipeline.js` does not exist.

- [ ] **Step 3: Implement the pipeline**

Create `src/contacts/confidence-pipeline.ts`:

```typescript
// src/contacts/confidence-pipeline.ts
//
// Orchestrator for contact confidence scoring. Reads contact state from
// ContactService, calls the pure computeConfidence() formula, and persists
// the result via updateScoringFields().
//
// Two update modes:
// - incrementalUpdate(): applies a delta to stored stats, then recomputes
// - fullRecompute(): reads stored stats and recomputes (idempotent)
//
// Both call the same formula — convergence is guaranteed by construction.

import type { ContactService } from './contact-service.js';
import type { TrustLevel } from './types.js';
import { computeConfidence } from './confidence-scorer.js';

export type ConfidenceSignal =
  | { type: 'message_seen'; count?: number }
  | { type: 'message_sent'; count?: number }
  | { type: 'trust_grant' }
  | { type: 'pairing_confirmed' };

export class ConfidencePipeline {
  constructor(private contactService: ContactService) {}

  /**
   * Apply a scoring signal and recompute contact_confidence.
   *
   * For message signals, increments the relevant counter and (for inbound)
   * updates last_seen_at. For trust_grant and pairing_confirmed, the
   * underlying data has already been updated by the caller — we just
   * recompute the score.
   *
   * Skips CEO contacts (role = 'ceo') — their confidence is hardcoded to 1.0
   * in ContactResolver.
   */
  async incrementalUpdate(contactId: string, signal: ConfidenceSignal): Promise<void> {
    const contact = await this.contactService.getContact(contactId);
    if (!contact) return;

    // Skip CEO contacts — confidence is hardcoded in ContactResolver
    if (contact.role === 'ceo') return;

    const count = ('count' in signal ? signal.count : undefined) ?? 1;
    if (count < 1) return; // Guard against non-positive counts

    // Determine stat deltas based on signal type
    let inboundDelta = 0;
    let outboundDelta = 0;
    let lastSeenAt: Date | undefined;

    switch (signal.type) {
      case 'message_seen':
        inboundDelta = count;
        lastSeenAt = new Date();
        break;
      case 'message_sent':
        outboundDelta = count;
        // Does NOT update lastSeenAt — "last seen" means last inbound
        break;
      case 'trust_grant':
      case 'pairing_confirmed':
        // No stat updates — the caller already modified trust_level or
        // created the verified identity. We just recompute the score.
        break;
    }

    // Fetch identities for verification signals
    const result = await this.contactService.getContactWithIdentities(contactId);
    if (!result) return;
    const { identities } = result;

    // Compute the new confidence from the *post-update* state.
    // For message signals, add the delta to the stored count before computing.
    const newConfidence = computeConfidence({
      inboundMessageCount: contact.inboundMessageCount + inboundDelta,
      outboundMessageCount: contact.outboundMessageCount + outboundDelta,
      lastSeenAt: lastSeenAt ?? contact.lastSeenAt,
      trustLevel: contact.trustLevel,
      verifiedIdentityCount: identities.filter(i => i.verified).length,
      hasCeoStatedIdentity: identities.some(i => i.source === 'ceo_stated'),
      now: new Date(),
    });

    // Persist — uses atomic increments for counts
    await this.contactService.updateScoringFields(contactId, {
      inboundMessageCountDelta: inboundDelta,
      outboundMessageCountDelta: outboundDelta,
      contactConfidence: newConfidence,
      lastSeenAt,
    });
  }

  /**
   * Recompute contact_confidence from stored state. Idempotent.
   * Does not modify message counts or lastSeenAt — only updates contact_confidence.
   */
  async fullRecompute(contactId: string): Promise<number> {
    const result = await this.contactService.getContactWithIdentities(contactId);
    if (!result) return 0;
    const { contact, identities } = result;

    // Skip CEO
    if (contact.role === 'ceo') return 1.0;

    const newConfidence = computeConfidence({
      inboundMessageCount: contact.inboundMessageCount,
      outboundMessageCount: contact.outboundMessageCount,
      lastSeenAt: contact.lastSeenAt,
      trustLevel: contact.trustLevel,
      verifiedIdentityCount: identities.filter(i => i.verified).length,
      hasCeoStatedIdentity: identities.some(i => i.source === 'ceo_stated'),
      now: new Date(),
    });

    // Only update confidence — don't touch counts or lastSeenAt
    await this.contactService.updateScoringFields(contactId, {
      contactConfidence: newConfidence,
    });

    return newConfidence;
  }

  /**
   * Recompute all contacts. Returns the number of contacts processed.
   * Intended for backfill scripts and formula-tuning — not the hot path.
   */
  async fullRecomputeAll(): Promise<number> {
    const contacts = await this.contactService.listContacts();
    let count = 0;
    for (const contact of contacts) {
      await this.fullRecompute(contact.id);
      count++;
    }
    return count;
  }
}
```

- [ ] **Step 4: Expose `updateScoringFields()` on `ContactService`**

Add a public method to `ContactService` that delegates to the backend. Add after `deleteContact()` (~line 684):

```typescript
  /**
   * Update scoring-owned fields. Delegates to the backend's atomic increment path.
   * Called by ConfidencePipeline — not intended for direct use by skills or other callers.
   */
  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    await this.backend.updateScoringFields(contactId, updates);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/contacts/confidence-pipeline.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Run all contact tests to verify no regressions**

Run: `npx vitest run tests/unit/contacts/`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```
git add src/contacts/confidence-pipeline.ts tests/unit/contacts/confidence-pipeline.test.ts src/contacts/contact-service.ts
git commit -m "feat: add confidence pipeline orchestrator with incremental and full-recompute"
```

---

## Task 5: Wire pipeline into Dispatcher

**Files:**
- Modify: `src/dispatch/dispatcher.ts:41-73` (config)
- Modify: `src/dispatch/dispatcher.ts:85-132` (constructor)
- Modify: `src/dispatch/dispatcher.ts:~237-244` (message_seen hook)

- [ ] **Step 1: Add `confidencePipeline` to `DispatcherConfig`**

In `src/dispatch/dispatcher.ts`, add to the `DispatcherConfig` interface:

```typescript
  /** Contact confidence scoring pipeline. When provided, fires message_seen on
   *  every resolved inbound sender. When absent, scoring is disabled. */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
```

- [ ] **Step 2: Store the pipeline in the constructor**

Add a private field to the `Dispatcher` class:

```typescript
private confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
```

And in the constructor, add:

```typescript
this.confidencePipeline = config.confidencePipeline;
```

- [ ] **Step 3: Fire `message_seen` after resolving a known sender**

After the `senderContext.resolved` check and the `senderContext.contactId !== 'primary-user'` guard (~line 243, inside the `if (senderContext.resolved)` block, after the `createContactResolved` publish), add:

```typescript
            // Fire-and-forget: update contact confidence for this interaction.
            // Non-blocking — the trust score for THIS message already used the
            // stored contactConfidence. This update benefits the NEXT inbound.
            if (this.confidencePipeline) {
              this.confidencePipeline.incrementalUpdate(senderContext.contactId, { type: 'message_seen' })
                .catch(err => this.logger.warn({ err, contactId: senderContext.contactId }, 'Confidence pipeline update failed (non-fatal)'));
            }
```

- [ ] **Step 4: Run dispatcher tests**

Run: `npx vitest run tests/unit/dispatch/dispatcher.test.ts`

Expected: all existing tests PASS (the pipeline is optional, so existing tests that don't provide it are unaffected).

- [ ] **Step 5: Commit**

```
git add src/dispatch/dispatcher.ts
git commit -m "feat: wire confidence pipeline into dispatcher for message_seen signals"
```

---

## Task 6: Wire pipeline into OutboundGateway — remove band-aid

**Files:**
- Modify: `src/skills/outbound-gateway.ts:108-194` (config)
- Modify: `src/skills/outbound-gateway.ts:220-259` (constructor)
- Modify: `src/skills/outbound-gateway.ts:~884-935` (remove band-aid, add message_sent)

- [ ] **Step 1: Add `confidencePipeline` to `OutboundGatewayConfig`**

In `src/skills/outbound-gateway.ts`, add to the `OutboundGatewayConfig` interface (after `actionLogRepo`):

```typescript
  /**
   * Contact confidence scoring pipeline. When provided, fires message_sent after
   * every successful outbound send. Replaces the setTrustLevel('high') band-aid.
   */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
```

- [ ] **Step 2: Store in the constructor**

Add a private field:

```typescript
private readonly confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
```

And in the constructor:

```typescript
this.confidencePipeline = config.confidencePipeline;
```

- [ ] **Step 3: Remove the `setTrustLevel('high')` band-aid for new contacts**

In the new-contact path (~line 884-896), remove the entire `setTrustLevel` try/catch block:

```typescript
      // REMOVE THIS BLOCK:
      // Set trustLevel: 'high' so replies from this contact score above the trust floor.
      // contactConfidence starts at 0 for new contacts (enriched later via KG), so without
      // a trustLevel override the dispatcher's trust score formula produces ~0.12 — below the
      // default floor of 0.2 — and the reply gets re-held even though the contact is confirmed.
      // Failure is non-fatal: the contact was created and linked; warn so it's visible.
      try {
        await this.contactService.setTrustLevel(created.id, 'high');
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: created.id },
          'outbound-gateway: setTrustLevel failed after contact creation — replies may still fall below trust floor',
        );
      }
```

Replace with:

```typescript
      // Update confidence score — the message_sent signal gives the contact a
      // non-zero contactConfidence so replies clear the trust floor.
      if (this.confidencePipeline) {
        this.confidencePipeline.incrementalUpdate(created.id, { type: 'message_sent' })
          .catch(err => this.log.warn(
            { err, channel, recipientId: redactId(recipientId), contactId: created.id },
            'outbound-gateway: confidence pipeline update failed after contact creation (non-fatal)',
          ));
      }
```

- [ ] **Step 4: Remove the `setTrustLevel('high')` band-aid for promoted provisionals**

In the promoted-provisional path (~line 926-935), remove the entire `setTrustLevel` try/catch block and replace with the same pattern:

```typescript
      // Update confidence score after promotion
      if (this.confidencePipeline) {
        this.confidencePipeline.incrementalUpdate(contact.contactId, { type: 'message_sent' })
          .catch(err => this.log.warn(
            { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
            'outbound-gateway: confidence pipeline update failed after promotion (non-fatal)',
          ));
      }
```

- [ ] **Step 5: Run outbound-gateway tests**

Run: `npx vitest run tests/unit/skills/outbound-gateway.test.ts`

Expected: tests that asserted `setTrustLevel('high')` will FAIL. Update those tests to instead verify that the confidence pipeline update was called (or that `setTrustLevel('high')` is no longer called). The exact test changes depend on how the existing tests are structured — read the test file and update accordingly.

- [ ] **Step 6: Commit**

```
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat: replace setTrustLevel band-aid with confidence pipeline in outbound-gateway"
```

---

## Task 7: Wire pipeline into contact-set-trust skill

**Files:**
- Modify: `skills/contact-set-trust/handler.ts`
- Modify: `src/skills/types.ts:~127`

- [ ] **Step 1: Add `confidencePipeline` to `SkillContext`**

In `src/skills/types.ts`, add after the `contactService` field:

```typescript
  /** Contact confidence scoring pipeline. Populated when available.
   *  Skills that modify trust-related fields can fire scoring signals through this. */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
```

- [ ] **Step 2: Fire `trust_grant` in the contact-set-trust handler**

In `skills/contact-set-trust/handler.ts`, after the successful `setTrustLevel()` call and before the return statement, add:

```typescript
      // Fire scoring pipeline update — the trust level change affects contact_confidence
      if (ctx.confidencePipeline) {
        try {
          await ctx.confidencePipeline.incrementalUpdate(contact_id, { type: 'trust_grant' });
        } catch (pipelineErr) {
          // Non-fatal — the trust level was already set successfully
          ctx.log.warn({ err: pipelineErr, contact_id }, 'Confidence pipeline update failed after trust grant (non-fatal)');
        }
      }
```

- [ ] **Step 3: Run contact-set-trust tests (if they exist)**

Run: `npx vitest run tests/unit/skills/contact-set-trust.test.ts` (if the file exists; check first)

Expected: PASS (the pipeline is optional).

- [ ] **Step 4: Commit**

```
git add skills/contact-set-trust/handler.ts src/skills/types.ts
git commit -m "feat: fire trust_grant signal from contact-set-trust skill"
```

---

## Task 8: Fire `pairing_confirmed` in `linkIdentity()`

**Files:**
- Modify: `src/contacts/contact-service.ts:~408-448`

- [ ] **Step 1: Add `confidencePipeline` as an optional dependency**

The `ContactService` doesn't currently have a reference to the pipeline. Add it to the `ContactServiceOptions` interface in `src/contacts/types.ts`:

```typescript
export interface ContactServiceOptions {
  dedupService?: import('./dedup-service.js').DedupService;
  onDuplicateDetected?: (
    newContactId: string,
    matchContactId: string,
    confidence: DedupConfidence,
    reason: string,
  ) => void;
  onContactMerged?: (primaryId: string, secondaryId: string, mergedAt: Date) => void;
  /** Called when a verified identity is linked — triggers confidence recompute. */
  onIdentityVerified?: (contactId: string) => void;
}
```

Store it in the `ContactService` constructor (same pattern as `onContactMerged`):

```typescript
private onIdentityVerified?: (contactId: string) => void;
```

And in the constructor:

```typescript
this.onIdentityVerified = options?.onIdentityVerified;
```

- [ ] **Step 2: Fire the callback in `linkIdentity()`**

In `ContactService.linkIdentity()`, after `await this.backend.createIdentity(identity)` (~line 446), add:

```typescript
    // Notify the scoring pipeline when a verified identity is linked
    if (verified && this.onIdentityVerified) {
      try {
        this.onIdentityVerified(options.contactId);
      } catch (err) {
        this.logger?.warn({ err, contactId: options.contactId }, 'onIdentityVerified callback threw (non-fatal)');
      }
    }
```

- [ ] **Step 3: Run contact-service tests**

Run: `npx vitest run tests/unit/contacts/contact-service.test.ts`

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```
git add src/contacts/types.ts src/contacts/contact-service.ts
git commit -m "feat: fire onIdentityVerified callback from linkIdentity for scoring pipeline"
```

---

## Task 9: Wire everything in `src/index.ts`

**Files:**
- Modify: `src/index.ts:~715,~1087`

- [ ] **Step 1: Create the pipeline instance**

After `contactService` is created (search for `ContactService.createWithPostgres` in `index.ts`), create the pipeline:

```typescript
import { ConfidencePipeline } from './contacts/confidence-pipeline.js';

// ... after contactService is created:
const confidencePipeline = contactService ? new ConfidencePipeline(contactService) : undefined;
```

- [ ] **Step 2: Wire `onIdentityVerified` callback**

When creating the `ContactService`, pass the callback via `ContactServiceOptions`:

```typescript
const contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
  // ... existing options ...
  onIdentityVerified: (contactId: string) => {
    if (confidencePipeline) {
      confidencePipeline.incrementalUpdate(contactId, { type: 'pairing_confirmed' })
        .catch(err => logger.warn({ err, contactId }, 'pairing_confirmed pipeline update failed (non-fatal)'));
    }
  },
});
```

Note: there may be a circular dependency issue here since `confidencePipeline` depends on `contactService`. If so, create `contactService` first, then create `confidencePipeline`, then set the callback on `contactService` via a setter method or by restructuring the wiring to use a late-binding pattern (e.g., the callback captures `confidencePipeline` from the outer scope after it's assigned):

```typescript
let confidencePipeline: ConfidencePipeline | undefined;
const contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
  // ... existing options ...
  onIdentityVerified: (contactId: string) => {
    // Late-binding: confidencePipeline is assigned after contactService is created
    confidencePipeline?.incrementalUpdate(contactId, { type: 'pairing_confirmed' })
      .catch(err => logger.warn({ err, contactId }, 'pairing_confirmed pipeline update failed (non-fatal)'));
  },
});
confidencePipeline = contactService ? new ConfidencePipeline(contactService) : undefined;
```

- [ ] **Step 3: Pass pipeline to Dispatcher**

In the `new Dispatcher({...})` call (~line 1087), add:

```typescript
confidencePipeline,
```

- [ ] **Step 4: Pass pipeline to OutboundGateway**

In the `new OutboundGateway({...})` call (~line 715), add:

```typescript
confidencePipeline,
```

- [ ] **Step 5: Pass pipeline to skill context via ExecutionLayer**

In `src/skills/execution.ts`:

1. Add `confidencePipeline` to the constructor options (~line 88):
   ```typescript
   confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
   ```

2. Store it as a private field (~line 67):
   ```typescript
   private confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
   ```

3. Assign in constructor (~line 113):
   ```typescript
   this.confidencePipeline = options?.confidencePipeline;
   ```

4. Inject into skill context (~line 452, after `contactService`):
   ```typescript
   confidencePipeline: this.confidencePipeline,
   ```

Then in `src/index.ts`, add `confidencePipeline` to the `ExecutionLayer` constructor call (~line 853).

- [ ] **Step 6: Verify the app starts**

Run: `npx tsx src/index.ts` (or however the dev server starts) — verify no import errors or startup crashes. Then Ctrl+C.

- [ ] **Step 7: Commit**

```
git add src/index.ts
git commit -m "feat: wire ConfidencePipeline into Dispatcher, OutboundGateway, and skill context"
```

---

## Task 10: Integration test

**Files:**
- Modify: `tests/integration/contacts.test.ts`

- [ ] **Step 1: Add integration test**

Add a new `describe` block to the existing integration test file:

```typescript
describe('contact confidence pipeline', () => {
  it('incremental update flows through to computeTrustScore', async () => {
    // 1. Create a contact
    const contact = await contactService.createContact({
      displayName: 'Integration Test Contact',
      source: 'email_participant',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'integration@test.com',
      source: 'email_participant',
    });

    // 2. Verify initial confidence is 0
    const initial = await contactService.getContact(contact.id);
    expect(initial!.contactConfidence).toBe(0);

    // 3. Send scoring signals
    const pipeline = new ConfidencePipeline(contactService);
    await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 10 });
    await pipeline.incrementalUpdate(contact.id, { type: 'message_sent', count: 5 });

    // 4. Verify confidence is now > 0
    const updated = await contactService.getContact(contact.id);
    expect(updated!.contactConfidence).toBeGreaterThan(0);
    expect(updated!.inboundMessageCount).toBe(10);
    expect(updated!.outboundMessageCount).toBe(5);
    expect(updated!.lastSeenAt).not.toBeNull();

    // 5. Verify it flows through to trust score
    const resolved = await contactService.resolveByChannelIdentity('email', 'integration@test.com');
    expect(resolved!.contactConfidence).toBeGreaterThan(0);

    const trustScore = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: resolved!.contactConfidence,
      injectionRiskScore: 0,
      trustLevel: null,
      weights: DEFAULT_TRUST_WEIGHTS,
    });
    // With ~15 messages and recent activity, confidence should push
    // the trust score above the 0.2 floor
    expect(trustScore).toBeGreaterThan(0.2);

    // 6. fullRecompute converges to same score
    await pipeline.fullRecompute(contact.id);
    const recomputed = await contactService.getContact(contact.id);
    expect(recomputed!.contactConfidence).toBeCloseTo(updated!.contactConfidence);
  });
});
```

Add the necessary imports at the top of the file:

```typescript
import { ConfidencePipeline } from '../../src/contacts/confidence-pipeline.js';
import { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from '../../src/dispatch/trust-scorer.js';
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration/contacts.test.ts`

Expected: PASS. This test requires a real Postgres instance (via Docker).

- [ ] **Step 3: Commit**

```
git add tests/integration/contacts.test.ts
git commit -m "test: add integration test for confidence pipeline end-to-end flow"
```

---

## Task 11: Run full test suite and fix regressions

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`

- [ ] **Step 2: Fix any failures**

Common expected failures:
- Dispatcher tests that didn't provide the pipeline — should still pass (optional dep)
- Outbound-gateway tests that assert `setTrustLevel('high')` was called — update these to verify `setTrustLevel('high')` is NOT called, and that the pipeline update fires instead
- Contact-service tests that construct `Contact` objects without the new fields — add defaults

For each fix, read the failing test, understand what it asserts, and update it to match the new behavior. Do not weaken test assertions — update them to verify the new correct behavior.

- [ ] **Step 3: Commit fixes**

```
git add -A
git commit -m "fix: update existing tests for confidence pipeline integration"
```

---

## Task 12: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entries**

Under `## [Unreleased]`, add:

```markdown
### Added

- **Contact confidence scoring pipeline** — `contact_confidence` is now updated on each qualifying event (inbound/outbound message, CEO trust grant, verified identity pairing). Supports incremental and full-recompute modes with convergence guarantee (spec 06, #460)

### Changed

- **Outbound gateway** — removed `setTrustLevel('high')` band-aid; outbound sends now trigger the confidence scoring pipeline instead, giving contacts a real `contact_confidence` value

### Security

- **Trust scoring** — `messageTrustScore` now uses all three formula components (channel weight, contact confidence, injection risk) instead of treating every contact as zero-confidence
```

- [ ] **Step 2: Commit**

```
git add CHANGELOG.md
git commit -m "docs: add confidence pipeline changelog entries"
```

---

## Out of Scope (follow-up issues)

These spec items are intentionally deferred from this PR:

- **Contact merge scoring**: The spec says the primary contact should get `max(primaryCount, secondaryCount)` and a `fullRecompute()` after merge. This requires modifying `ContactService.mergeContacts()` — a separate change that should be its own commit/PR.
- **Backfill script**: Running `fullRecomputeAll()` on first deployment. This can be a manual one-liner after deploy: `await new ConfidencePipeline(contactService).fullRecomputeAll()`. No script file needed.
