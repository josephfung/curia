# Judgment-Driven Auto-Elevation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically promote contacts from `tier='unknown'` to `tier='known'` via three signal paths — correspondence (outbound email sent to contact), domain-validated (first inbound from org-kind contact), and judgment (confidence score crosses 0.20 threshold) — with no manual confirmation required.

**Architecture:** New `JUDGMENT_ELEVATION_THRESHOLD` constant in `confidence-scorer.ts`. `ConfidencePipeline.incrementalUpdate()` return type changes from `Promise<void>` to `Promise<number>` so callers chain judgment elevation without a second DB read. New `ContactService.elevateTierToKnown()` uses atomic SQL (`WHERE tier='unknown' AND kind NOT IN ('automated','agent')`) — same pattern as `promoteToConfirmed()`. `DispatcherConfig` gains optional `contactService` field; `handleInboundMessage()` hooks Paths 2 and 3; `handleSkillResult()` hooks Path 1. New `contact.elevated` bus event (audit trail), published via `onContactElevated` callback wired in `index.ts`.

**Tech Stack:** TypeScript/ESM, Vitest, PostgreSQL 16 (no new migration — writes to existing `tier` column from migration 055)

## Global Constraints

- Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951`
- Run tests with: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test <file>`
- Run typecheck with: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck`
- All elevation calls are fire-and-forget — failures must never block inbound message handling or outbound sends
- `kind='automated'` and `kind='agent'` contacts are never elevated (enforced at DB level)
- `JUDGMENT_ELEVATION_THRESHOLD = 0.20` — about one recent inbound message worth of confidence
- No DB migration needed — `elevateTierToKnown()` writes only to the existing `tier` column
- No comments on obvious code; add comments only where the WHY is non-obvious

---

## File Structure

**Modified source files:**
- `src/contacts/confidence-scorer.ts` — add `JUDGMENT_ELEVATION_THRESHOLD` export
- `src/contacts/confidence-pipeline.ts` — `incrementalUpdate()` return type `Promise<void>` → `Promise<number>`
- `src/bus/events.ts` — add `contact.elevated` payload, event interface, union member, and factory function
- `src/contacts/types.ts` — add `onContactElevated?` to `ContactServiceOptions`
- `src/contacts/contact-service.ts` — add `elevateTierToKnown()` to backend interface, PostgresContactBackend, InMemoryContactBackend, and ContactService
- `src/dispatch/dispatcher.ts` — add `contactService?` to config and class; add Path 1 in `handleSkillResult()`; add Paths 2 and 3 in `handleInboundMessage()`
- `src/index.ts` — wire `contactService` into dispatcher config, add `onContactElevated` callback to ContactService options
- `CHANGELOG.md` — add entry under `## [Unreleased]`

**Modified test files:**
- `tests/unit/contacts/confidence-pipeline.test.ts` — test that `incrementalUpdate()` returns the new confidence value
- `tests/unit/contacts/contact-service.test.ts` — test `elevateTierToKnown()` across all tier/kind combinations
- `tests/unit/dispatch/dispatcher.test.ts` — test Paths 1, 2, and 3

---

## Task 1: Scoring Threshold Constant + Pipeline Return Type

**Files:**
- Modify: `src/contacts/confidence-scorer.ts` (after line 32 — after `PAIRING_BOOST`)
- Modify: `src/contacts/confidence-pipeline.ts` (line 40 signature; line 103 add return)
- Modify: `tests/unit/contacts/confidence-pipeline.test.ts` (add return-value test)

**Interfaces:**
- Produces: `JUDGMENT_ELEVATION_THRESHOLD` exported from `confidence-scorer.ts` — used by Task 4 (dispatcher import)
- Produces: `ConfidencePipeline.incrementalUpdate(id, signal): Promise<number>` — used by Task 4 (chain `.then(newConfidence =>`)

- [ ] **Step 1: Write the failing test for the return value**

Add a new `it` block inside the existing `describe('incrementalUpdate — message_seen')` in `tests/unit/contacts/confidence-pipeline.test.ts`:

```typescript
it('returns the updated confidence value', async () => {
  const contact = await createTestContact();
  const result = await pipeline.incrementalUpdate(contact.id, { type: 'message_seen' });
  // message_seen with recency contribution should be > 0
  expect(typeof result).toBe('number');
  expect(result).toBeGreaterThan(0);
  // Must match the stored contactConfidence
  const updated = await service.getContact(contact.id);
  expect(result).toBeCloseTo(updated!.contactConfidence);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/contacts/confidence-pipeline.test.ts
```

Expected: TypeScript compile error ("Property 'then' does not exist on type 'void'") or the test fails because `result` is `undefined`.

- [ ] **Step 3: Add `JUDGMENT_ELEVATION_THRESHOLD` to `confidence-scorer.ts`**

After line 32 (`export const PAIRING_BOOST = 0.10;`), add:

```typescript
/** Minimum contact_confidence to trigger automatic tier elevation from 'unknown' to 'known'. */
export const JUDGMENT_ELEVATION_THRESHOLD = 0.20;
```

- [ ] **Step 4: Change `incrementalUpdate()` return type and add return statement**

In `src/contacts/confidence-pipeline.ts`, change line 40:

```typescript
// Before:
async incrementalUpdate(contactId: string, signal: ConfidenceSignal): Promise<void> {

// After:
async incrementalUpdate(contactId: string, signal: ConfidenceSignal): Promise<number> {
```

Then add `return newConfidence;` after the `updateScoringFields` call (after the closing `});` on line 103, before the method's closing `}`):

```typescript
    await this.contactService.updateScoringFields(contactId, {
      inboundMessageCountDelta: inboundDelta,
      outboundMessageCountDelta: outboundDelta,
      contactConfidence: newConfidence,
      lastSeenAt,
    });
    return newConfidence;  // ← add this line
  }
```

Also update the three early-return paths (non-principal skip and validation fail) to return `0` instead of `undefined`:

```typescript
  async incrementalUpdate(contactId: string, signal: ConfidenceSignal): Promise<number> {
    const contact = await this.contactService.getContact(contactId);
    if (!contact) {
      this.logger?.debug({ contactId }, 'confidence-pipeline: contact not found — skipping');
      return 0;  // ← was: return;
    }

    if (contact.systemRole === 'principal') return 1.0;  // ← was: return;

    const count = ('count' in signal ? signal.count : undefined) ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      this.logger?.warn({ contactId, count }, 'confidence-pipeline: non-positive or non-integer count — skipping (likely a caller bug)');
      return 0;  // ← was: return;
    }
    // ... rest of method unchanged, ends with: return newConfidence;
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/contacts/confidence-pipeline.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 add src/contacts/confidence-scorer.ts src/contacts/confidence-pipeline.ts tests/unit/contacts/confidence-pipeline.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 commit -m "feat: export JUDGMENT_ELEVATION_THRESHOLD; incrementalUpdate returns new confidence"
```

---

## Task 2: `contact.elevated` Bus Event

**Files:**
- Modify: `src/bus/events.ts` — 4 additions (payload interface, event interface, union member, factory function)

**Interfaces:**
- Produces: `ContactElevatedEvent`, `createContactElevated()` — used by Task 6 (index.ts wiring)

No unit tests needed here — the TypeScript compiler catches structural errors, and the event is exercised by the end-to-end wiring in Task 6.

- [ ] **Step 1: Add `ContactElevatedPayload` interface after `ContactMergedPayload` (around line 288)**

```typescript
// contact.elevated — published when a contact is automatically promoted from 'unknown' to 'known'.
// Fired by ContactService.elevateTierToKnown() on success via the onContactElevated callback.
interface ContactElevatedPayload {
  contactId: string;
  reason: 'correspondence' | 'domain-validated' | 'judgment';
}
```

- [ ] **Step 2: Add `ContactElevatedEvent` interface after `ContactMergedEvent` (around line 692)**

```typescript
export interface ContactElevatedEvent extends BaseEvent {
  type: 'contact.elevated';
  sourceLayer: 'dispatch';
  payload: ContactElevatedPayload;
}
```

- [ ] **Step 3: Add `ContactElevatedEvent` to the `BusEvent` union**

In the `BusEvent` union (around line 961), add after the `ContactMergedEvent` entry:

```typescript
  | ContactMergedEvent              // Dedup: two contacts have been merged
  | ContactElevatedEvent            // #951: automatic tier elevation from unknown → known
```

- [ ] **Step 4: Add `createContactElevated()` factory after `createContactMerged()` (around line 1296)**

```typescript
export function createContactElevated(
  payload: ContactElevatedPayload & { parentEventId?: string },
): ContactElevatedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.elevated',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 commit -m "feat: add contact.elevated bus event (#951)"
```

---

## Task 3: `ContactService.elevateTierToKnown()`

**Files:**
- Modify: `src/contacts/types.ts:462` — add `onContactElevated?` to `ContactServiceOptions`
- Modify: `src/contacts/contact-service.ts` — 6 changes across backend interface, Postgres, InMemory, and service class
- Modify: `tests/unit/contacts/contact-service.test.ts` — add test block

**Interfaces:**
- Consumes: `ContactElevatedPayload.reason` type (`'correspondence' | 'domain-validated' | 'judgment'`) from Task 2
- Produces: `ContactService.elevateTierToKnown(contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment'): Promise<boolean>` — used by Tasks 4 and 5

- [ ] **Step 1: Write the failing tests**

Add a new `describe('elevateTierToKnown')` block in `tests/unit/contacts/contact-service.test.ts` (after the existing describe blocks, before the final closing `}`):

```typescript
describe('elevateTierToKnown', () => {
  it('promotes an unknown contact to known and returns true', async () => {
    const contact = await service.createContact({
      displayName: 'Jane Doe',
      source: 'email_participant',
      status: 'provisional',
    });
    // provisional → tier='unknown' by default
    expect(contact.tier).toBe('unknown');

    const result = await service.elevateTierToKnown(contact.id, 'judgment');
    expect(result).toBe(true);

    const updated = await service.getContact(contact.id);
    expect(updated!.tier).toBe('known');
  });

  it('returns false and does not modify a contact already at tier="known"', async () => {
    const contact = await service.createContact({
      displayName: 'Jane Doe',
      source: 'email_participant',
      status: 'confirmed',
    });
    expect(contact.tier).toBe('known');

    const result = await service.elevateTierToKnown(contact.id, 'judgment');
    expect(result).toBe(false);

    const updated = await service.getContact(contact.id);
    expect(updated!.tier).toBe('known'); // unchanged
  });

  it('returns false and does not modify a contact at tier="trusted"', async () => {
    const contact = await service.createContact({
      displayName: 'Jane Doe',
      source: 'email_participant',
      status: 'confirmed',
    });
    await service.setTrustLevel(contact.id, 'high'); // drives tier to 'trusted'
    const before = await service.getContact(contact.id);
    expect(before!.tier).toBe('trusted');

    const result = await service.elevateTierToKnown(contact.id, 'judgment');
    expect(result).toBe(false);

    const updated = await service.getContact(contact.id);
    expect(updated!.tier).toBe('trusted'); // unchanged
  });

  it('returns false and does not modify a blocked contact', async () => {
    const contact = await service.createContact({
      displayName: 'Jane Doe',
      source: 'email_participant',
      status: 'blocked',
    });
    expect(contact.tier).toBe('blocked');

    const result = await service.elevateTierToKnown(contact.id, 'correspondence');
    expect(result).toBe(false);

    const updated = await service.getContact(contact.id);
    expect(updated!.tier).toBe('blocked'); // unchanged
  });

  it('returns false for kind="automated" contacts even when tier="unknown"', async () => {
    const contact = await service.createContact({
      displayName: 'noreply@example.com',
      source: 'email_participant',
      status: 'provisional',
      kind: 'automated',
    });
    expect(contact.tier).toBe('unknown');
    expect(contact.kind).toBe('automated');

    const result = await service.elevateTierToKnown(contact.id, 'judgment');
    expect(result).toBe(false);

    const updated = await service.getContact(contact.id);
    expect(updated!.tier).toBe('unknown'); // unchanged
  });

  it('returns false for kind="agent" contacts even when tier="unknown"', async () => {
    const contact = await service.createContact({
      displayName: 'Specialist Agent',
      source: 'email_participant',
      status: 'provisional',
      kind: 'agent',
    });
    const result = await service.elevateTierToKnown(contact.id, 'domain-validated');
    expect(result).toBe(false);
  });

  it('fires the onContactElevated callback with contactId and reason', async () => {
    const onContactElevated = vi.fn();
    const svc = ContactService.createInMemory(entityMemory, { onContactElevated });

    const contact = await svc.createContact({
      displayName: 'Callback Test',
      source: 'email_participant',
      status: 'provisional',
    });

    await svc.elevateTierToKnown(contact.id, 'correspondence');

    expect(onContactElevated).toHaveBeenCalledOnce();
    expect(onContactElevated).toHaveBeenCalledWith(contact.id, 'correspondence');
  });

  it('does not fire onContactElevated when elevation is a no-op', async () => {
    const onContactElevated = vi.fn();
    const svc = ContactService.createInMemory(entityMemory, { onContactElevated });

    const contact = await svc.createContact({
      displayName: 'Already Known',
      source: 'email_participant',
      status: 'confirmed', // already known
    });

    await svc.elevateTierToKnown(contact.id, 'judgment');

    expect(onContactElevated).not.toHaveBeenCalled();
  });
});
```

You also need to add `vi` to the import at the top of the test file:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/contacts/contact-service.test.ts
```

Expected: compile error — `elevateTierToKnown` does not exist on `ContactService`.

- [ ] **Step 3: Add `onContactElevated?` to `ContactServiceOptions` in `src/contacts/types.ts`**

After the `onIdentityVerified?` entry (around line 462):

```typescript
export interface ContactServiceOptions {
  dedupService?: import('./dedup-service.js').DedupService;
  onDuplicateDetected?: (
    newContactId: string,
    matchContactId: string,
    confidence: DedupConfidence,
    reason: string,
  ) => void;
  /** Called after a successful non-dry-run merge to notify subscribers (e.g., for audit logging). */
  onContactMerged?: (primaryId: string, secondaryId: string, mergedAt: Date) => void;
  /** Called when a verified identity is linked — triggers confidence recompute.
   *  May return a Promise; rejections are caught by ContactService (non-fatal). */
  onIdentityVerified?: (contactId: string) => void | Promise<void>;
  /** Called after a contact's tier is automatically elevated to 'known'.
   *  Fired with the reason for observability/audit trail. Non-throwing. */
  onContactElevated?: (contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment') => void;
}
```

- [ ] **Step 4: Add `elevateTierToKnown()` to the `ContactServiceBackend` interface**

In `src/contacts/contact-service.ts`, add after `promoteToConfirmed()` in the `ContactServiceBackend` interface (around line 211):

```typescript
  /**
   * Atomically elevate a contact's tier from 'unknown' to 'known'.
   * Guards against automated/agent kinds at DB level.
   * Returns true if the row was updated, false otherwise (already elevated, wrong tier, or excluded kind).
   */
  elevateTierToKnown(contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment'): Promise<boolean>;
```

- [ ] **Step 5: Add `onContactElevated` private field and wire it in the `ContactService` constructor**

In the `ContactService` class body (around line 281), add after `private onContactMerged?`:

```typescript
  private onContactElevated?: (contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment') => void;
```

In the constructor body (around line 297), add after `this.onContactMerged`:

```typescript
    this.onContactElevated = options?.onContactElevated;
```

- [ ] **Step 6: Add `elevateTierToKnown()` service method**

In `ContactService`, add after `promoteToConfirmed()` (around line 1012):

```typescript
  /**
   * Atomically elevate a contact from tier='unknown' to tier='known'.
   * No-op for automated/agent kinds (enforced by backend SQL) and contacts already
   * at known/trusted/principal/blocked. Non-throwing — returns false on error.
   */
  async elevateTierToKnown(
    contactId: string,
    reason: 'correspondence' | 'domain-validated' | 'judgment',
  ): Promise<boolean> {
    try {
      const elevated = await this.backend.elevateTierToKnown(contactId, reason);
      if (elevated) {
        this.logger?.info({ contactId, reason }, 'contacts: tier elevated to known');
        if (this.onContactElevated) {
          try {
            this.onContactElevated(contactId, reason);
          } catch (callbackErr) {
            this.logger?.warn({ err: callbackErr }, 'onContactElevated callback threw (non-fatal)');
          }
        }
      }
      return elevated;
    } catch (err) {
      this.logger?.warn({ err, contactId, reason }, 'contacts: elevateTierToKnown failed (non-fatal)');
      return false;
    }
  }
```

- [ ] **Step 7: Add `elevateTierToKnown()` to `PostgresContactBackend`**

After `promoteToConfirmed()` in `PostgresContactBackend` (around line 1691):

```typescript
  async elevateTierToKnown(contactId: string, _reason: string): Promise<boolean> {
    // Atomic conditional: only upgrades tier when it is STILL 'unknown' at write time
    // AND the contact's kind is not automated or agent.
    const result = await this.pool.query(
      `UPDATE contacts
       SET tier = 'known', updated_at = now()
       WHERE id = $1
         AND tier = 'unknown'
         AND kind NOT IN ('automated', 'agent')`,
      [contactId],
    );
    return (result.rowCount ?? 0) > 0;
  }
```

- [ ] **Step 8: Add `elevateTierToKnown()` to `InMemoryContactBackend`**

After `promoteToConfirmed()` in `InMemoryContactBackend` (around line 2173):

```typescript
  async elevateTierToKnown(contactId: string, _reason: string): Promise<boolean> {
    const contact = this.contacts.get(contactId);
    if (!contact || contact.tier !== 'unknown') return false;
    if (contact.kind === 'automated' || contact.kind === 'agent') return false;
    this.contacts.set(contactId, { ...contact, tier: 'known', updatedAt: new Date() });
    return true;
  }
```

- [ ] **Step 9: Run tests to confirm they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/contacts/contact-service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 10: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 add src/contacts/types.ts src/contacts/contact-service.ts tests/unit/contacts/contact-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 commit -m "feat: add ContactService.elevateTierToKnown() for auto-elevation (#951)"
```

---

## Task 4: Dispatcher Inbound Paths (Path 2 Domain-Validated + Path 3 Judgment)

**Files:**
- Modify: `src/dispatch/dispatcher.ts` — 5 changes: import, config field, class field, constructor, `handleInboundMessage()` block
- Modify: `tests/unit/dispatch/dispatcher.test.ts` — add two describe blocks

**Interfaces:**
- Consumes: `JUDGMENT_ELEVATION_THRESHOLD` from `confidence-scorer.ts` (Task 1)
- Consumes: `ConfidencePipeline.incrementalUpdate()` returning `Promise<number>` (Task 1)
- Consumes: `ContactService.elevateTierToKnown()` (Task 3)
- Produces: Dispatcher fires Path 2 and Path 3 elevation on inbound messages

- [ ] **Step 1: Write the failing tests**

Add two `describe` blocks near the end of `tests/unit/dispatch/dispatcher.test.ts`. First, add these imports at the top of the file alongside existing imports:

```typescript
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { ConfidencePipeline } from '../../../src/contacts/confidence-pipeline.js';
import { createLogger } from '../../../src/logger.js';
import { EventBus } from '../../../src/bus/bus.js';
```

(Note: `ContactResolver`, `ContactTier`, `ContactKind` are likely already imported — check and add only what's missing. `createLogger` and `EventBus` are already there.)

Then add the two describe blocks:

```typescript
describe('Dispatcher auto-elevation — Path 2 domain-validated (#951)', () => {
  function buildHarness(opts: {
    tier?: import('../../../src/contacts/types.js').ContactTier;
    kind?: import('../../../src/contacts/types.js').ContactKind;
    withContactService?: boolean;
    confidence?: number;
  } = {}) {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    const elevateFn = vi.fn().mockResolvedValue(true);
    const contactService = opts.withContactService === false
      ? undefined
      : { elevateTierToKnown: elevateFn } as unknown as ContactService;

    const confidencePipeline = {
      incrementalUpdate: vi.fn().mockResolvedValue(opts.confidence ?? 0.05),
    } as unknown as ConfidencePipeline;

    const contactResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: true,
        contactId: 'test-contact-id',
        displayName: 'Corp Inc',
        role: null,
        systemRole: null,
        status: 'provisional',
        tier: opts.tier ?? 'unknown',
        kind: opts.kind ?? 'organization',
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 0.0,
        trustLevel: null,
      }),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver,
      contactService,
      confidencePipeline,
    });
    dispatcher.register();

    return { bus, elevateFn };
  }

  it('elevates an unknown org-kind sender on inbound', async () => {
    const { bus, elevateFn } = buildHarness({ tier: 'unknown', kind: 'organization' });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'billing@corp.com',
      content: 'Invoice attached.',
    }));

    await vi.waitFor(() => expect(elevateFn).toHaveBeenCalledWith('test-contact-id', 'domain-validated'), { timeout: 200 });
  });

  it('does not elevate when kind is "person"', async () => {
    const { bus, elevateFn } = buildHarness({ tier: 'unknown', kind: 'person' });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello',
    }));

    // Give microtasks time to settle, then assert nothing was called
    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalledWith(expect.anything(), 'domain-validated');
  });

  it('does not elevate when org contact is already tier="known"', async () => {
    const { bus, elevateFn } = buildHarness({ tier: 'known', kind: 'organization' });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'billing@corp.com',
      content: 'Invoice',
    }));

    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalledWith(expect.anything(), 'domain-validated');
  });

  it('silently skips when no contactService configured', async () => {
    const { bus, elevateFn } = buildHarness({ withContactService: false });

    await expect(bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'billing@corp.com',
      content: 'Invoice',
    }))).resolves.not.toThrow();

    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalled();
  });
});

describe('Dispatcher auto-elevation — Path 3 judgment (#951)', () => {
  function buildHarness(opts: {
    tier?: import('../../../src/contacts/types.js').ContactTier;
    kind?: import('../../../src/contacts/types.js').ContactKind;
    confidence: number;
    withContactService?: boolean;
  }) {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    const elevateFn = vi.fn().mockResolvedValue(true);
    const contactService = opts.withContactService === false
      ? undefined
      : { elevateTierToKnown: elevateFn } as unknown as ContactService;

    const confidencePipeline = {
      incrementalUpdate: vi.fn().mockResolvedValue(opts.confidence),
    } as unknown as ConfidencePipeline;

    const contactResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: true,
        contactId: 'test-contact-id',
        displayName: 'Alice',
        role: null,
        systemRole: null,
        status: 'provisional',
        tier: opts.tier ?? 'unknown',
        kind: opts.kind ?? 'person',
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 0.0,
        trustLevel: null,
      }),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver,
      contactService,
      confidencePipeline,
    });
    dispatcher.register();

    return { bus, elevateFn };
  }

  it('elevates when confidence crosses 0.20 threshold', async () => {
    const { bus, elevateFn } = buildHarness({ confidence: 0.22 });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello again',
    }));

    await vi.waitFor(() => expect(elevateFn).toHaveBeenCalledWith('test-contact-id', 'judgment'), { timeout: 200 });
  });

  it('does not elevate when confidence is below threshold', async () => {
    const { bus, elevateFn } = buildHarness({ confidence: 0.18 });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello',
    }));

    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalledWith(expect.anything(), 'judgment');
  });

  it('does not elevate automated contacts even when confidence >= threshold', async () => {
    const { bus, elevateFn } = buildHarness({ confidence: 0.30, kind: 'automated' });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'noreply@example.com',
      content: 'Your receipt',
    }));

    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalledWith(expect.anything(), 'judgment');
  });

  it('does not elevate when tier is already "known"', async () => {
    const { bus, elevateFn } = buildHarness({ confidence: 0.50, tier: 'known' });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello',
    }));

    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalledWith(expect.anything(), 'judgment');
  });

  it('silently skips when no contactService configured', async () => {
    const { bus, elevateFn } = buildHarness({ confidence: 0.50, withContactService: false });

    await expect(bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello',
    }))).resolves.not.toThrow();

    await new Promise<void>(r => setTimeout(r, 10));
    expect(elevateFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/dispatch/dispatcher.test.ts
```

Expected: compile error — `contactService` is not a property of `DispatcherConfig`.

- [ ] **Step 3: Add import + `contactService` to `DispatcherConfig` in `dispatcher.ts`**

At the top of `src/dispatch/dispatcher.ts`, add after the existing imports:

```typescript
import { JUDGMENT_ELEVATION_THRESHOLD } from '../contacts/confidence-scorer.js';
```

In `DispatcherConfig` (around line 71), add after `outboundContextService?`:

```typescript
  /** Contact service for automatic tier elevation (issue #951).
   *  When absent, all three elevation paths are silently skipped. */
  contactService?: import('../contacts/contact-service.js').ContactService;
```

- [ ] **Step 4: Add `private contactService?` class field and wire in constructor**

In the `Dispatcher` class body (around line 120), add after `_outboundContextService`:

```typescript
  private contactService?: import('../contacts/contact-service.js').ContactService;
```

In the constructor (around line 135), add after `this._outboundContextService`:

```typescript
    this.contactService = config.contactService;
```

- [ ] **Step 5: Add Paths 2 and 3 in `handleInboundMessage()`**

Replace the existing confidence pipeline fire-and-forget block (around lines 283–287):

```typescript
// Before (4 lines):
if (this.confidencePipeline && senderContext.tier !== 'blocked') {
  const resolvedContactId = senderContext.contactId;
  this.confidencePipeline.incrementalUpdate(resolvedContactId, { type: 'message_seen' })
    .catch(err => this.logger.warn({ err, contactId: resolvedContactId }, 'Confidence pipeline update failed (non-fatal)'));
}
```

With:

```typescript
if (this.confidencePipeline && senderContext.tier !== 'blocked') {
  const resolvedContactId = senderContext.contactId;

  // Path 2: domain-validated org elevation — fires immediately for org-kind unknown contacts.
  if (this.contactService && senderContext.kind === 'organization' && senderContext.tier === 'unknown') {
    const cs = this.contactService;
    cs.elevateTierToKnown(resolvedContactId, 'domain-validated')
      .catch(err => this.logger.warn({ err, contactId: resolvedContactId }, 'domain-validated elevation failed (non-fatal)'));
  }

  // Path 3: judgment elevation — chains after the confidence update to get the new score.
  // Capture tier and kind snapshots so the async callback sees pre-message values.
  const contactService = this.contactService;
  const snapshotTier = senderContext.tier;
  const snapshotKind = senderContext.kind;
  this.confidencePipeline.incrementalUpdate(resolvedContactId, { type: 'message_seen' })
    .then(newConfidence => {
      if (
        contactService &&
        snapshotTier === 'unknown' &&
        !isAutomatedKind(snapshotKind) &&
        newConfidence >= JUDGMENT_ELEVATION_THRESHOLD
      ) {
        return contactService.elevateTierToKnown(resolvedContactId, 'judgment');
      }
    })
    .catch(err => this.logger.warn({ err, contactId: resolvedContactId }, 'Confidence pipeline or judgment elevation failed (non-fatal)'));
}
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/dispatch/dispatcher.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 commit -m "feat: dispatcher auto-elevation Paths 2 (domain-validated) and 3 (judgment) (#951)"
```

---

## Task 5: Dispatcher Outbound Path (Path 1 — Correspondence)

**Files:**
- Modify: `src/dispatch/dispatcher.ts` — add Path 1 in `handleSkillResult()` (after the existing reply-lock loop)
- Modify: `tests/unit/dispatch/dispatcher.test.ts` — add describe block for Path 1

**Interfaces:**
- Consumes: `ContactResolver.resolve()` (already on Dispatcher as private field)
- Consumes: `ContactService.elevateTierToKnown()` (from Task 3)
- Consumes: `createSkillResult` from `bus/events.ts` (for test harness)

- [ ] **Step 1: Write the failing tests**

Add these imports to the test file if not already present:
```typescript
import { createSkillResult, createAgentResponse, type BusEvent } from '../../../src/bus/events.js';
import type { Logger } from '../../../src/logger.js';
```

Add a new describe block in `tests/unit/dispatch/dispatcher.test.ts`:

```typescript
describe('Dispatcher auto-elevation — Path 1 correspondence (#951)', () => {
  type StubBus = {
    subscribe: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
  };

  function buildHarness(opts: {
    resolvedContactId?: string | null;
    withContactService?: boolean;
  } = {}) {
    const subscribeHandlers = new Map<string, (event: BusEvent) => void | Promise<void>>();
    const publishedEvents: BusEvent[] = [];

    const bus = {
      subscribe: vi.fn((eventType: string, _layer: string, handler: (e: BusEvent) => void | Promise<void>) => {
        subscribeHandlers.set(eventType, handler);
      }),
      publish: vi.fn(async (_layer: string, event: BusEvent) => { publishedEvents.push(event); }),
    } as unknown as EventBus;

    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    } as unknown as Logger;

    const elevateFn = vi.fn().mockResolvedValue(true);
    const contactService = opts.withContactService === false
      ? undefined
      : { elevateTierToKnown: elevateFn } as unknown as ContactService;

    const resolvedContactId = opts.resolvedContactId !== undefined ? opts.resolvedContactId : 'contact-abc';
    const resolveFn = vi.fn().mockResolvedValue(
      resolvedContactId
        ? {
            resolved: true,
            contactId: resolvedContactId,
            displayName: 'Test Recipient',
            role: null, systemRole: null, status: 'provisional',
            tier: 'unknown', kind: 'person', verified: true,
            kgNodeId: null, knowledgeSummary: '', authorization: null,
            contactConfidence: 0.1, trustLevel: null,
          }
        : { resolved: false, channel: 'email', senderId: 'unknown@example.com' },
    );
    const contactResolver = { resolve: resolveFn } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({ bus, logger, contactResolver, contactService });
    dispatcher.register();

    return { subscribeHandlers, elevateFn, resolveFn };
  }

  async function fireSkillResult(
    subscribeHandlers: Map<string, (event: BusEvent) => void | Promise<void>>,
    opts: { skillName: string; to: string },
  ) {
    const event = createSkillResult({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      skillName: opts.skillName,
      result: { success: true, data: { message_id: 'msg-1', to: opts.to } },
      durationMs: 50,
      parentEventId: 'invoke-1',
    });
    const handler = subscribeHandlers.get('skill.result');
    if (!handler) throw new Error('No skill.result handler registered');
    await handler(event);
    // Flush microtasks so fire-and-forget promise chains settle.
    await new Promise<void>(r => setImmediate(r));
  }

  it('calls elevateTierToKnown("correspondence") after email-reply to a resolved contact', async () => {
    const { subscribeHandlers, elevateFn } = buildHarness();
    await fireSkillResult(subscribeHandlers, { skillName: 'email-reply', to: 'recipient@example.com' });
    expect(elevateFn).toHaveBeenCalledWith('contact-abc', 'correspondence');
  });

  it('calls elevateTierToKnown("correspondence") after email-send to a resolved contact', async () => {
    const { subscribeHandlers, elevateFn } = buildHarness();
    await fireSkillResult(subscribeHandlers, { skillName: 'email-send', to: 'someone@example.com' });
    expect(elevateFn).toHaveBeenCalledWith('contact-abc', 'correspondence');
  });

  it('calls elevate for each recipient in a comma-separated to field', async () => {
    const { subscribeHandlers, elevateFn } = buildHarness();
    await fireSkillResult(subscribeHandlers, { skillName: 'email-send', to: 'a@example.com, b@example.com' });
    // resolve is called for each address
    expect(elevateFn).toHaveBeenCalledTimes(2);
  });

  it('does not call elevate when resolver returns no contact', async () => {
    const { subscribeHandlers, elevateFn } = buildHarness({ resolvedContactId: null });
    await fireSkillResult(subscribeHandlers, { skillName: 'email-reply', to: 'new@example.com' });
    expect(elevateFn).not.toHaveBeenCalled();
  });

  it('silently skips when no contactService configured', async () => {
    const { subscribeHandlers, elevateFn } = buildHarness({ withContactService: false });
    await fireSkillResult(subscribeHandlers, { skillName: 'email-reply', to: 'someone@example.com' });
    expect(elevateFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/dispatch/dispatcher.test.ts
```

Expected: new tests fail — `elevateFn` is never called.

- [ ] **Step 3: Add Path 1 to `handleSkillResult()`**

In `src/dispatch/dispatcher.ts`, at the end of `handleSkillResult()` after the `if (!matched)` debug block (after line ~755):

```typescript
    if (!matched) {
      this.logger.debug(
        { skillName, conversationId, routingMapSize: this.taskRouting.size },
        'Dispatcher reply-lock: no routing entry matched skill result — no lock set',
      );
    }

    // Path 1: Correspondence elevation — attempt to elevate each outbound recipient
    // from unknown → known. Fires for all recipients regardless of reply-lock match.
    // elevateTierToKnown() is a no-op when the contact is already elevated.
    if (this.contactResolver && this.contactService) {
      const cr = this.contactResolver;
      const cs = this.contactService;
      for (const address of recipients) {
        cr.resolve('email', address)
          .then(ctx => {
            if (ctx.resolved) {
              return cs.elevateTierToKnown(ctx.contactId, 'correspondence');
            }
          })
          .catch(err => this.logger.warn({ err, address }, 'Correspondence elevation failed (non-fatal)'));
      }
    }
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test tests/unit/dispatch/dispatcher.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 commit -m "feat: dispatcher auto-elevation Path 1 (correspondence via email-reply/email-send) (#951)"
```

---

## Task 6: Wire index.ts + CHANGELOG

**Files:**
- Modify: `src/index.ts` — add `createContactElevated` import, `onContactElevated` callback in ContactService options, `contactService` in Dispatcher config
- Modify: `CHANGELOG.md` — add entry under `## [Unreleased]`

**Interfaces:**
- Consumes: `createContactElevated()` from `bus/events.ts` (Task 2)
- Consumes: `contactService` in `DispatcherConfig` (Task 4)
- Consumes: `onContactElevated` in `ContactServiceOptions` (Task 3)

- [ ] **Step 1: Add `createContactElevated` to the import from `bus/events.ts` in `index.ts`**

Find the import line that pulls from `'./bus/events.js'` (it already imports `createContactDuplicateDetected`, `createContactMerged`, etc.) and add `createContactElevated`:

```typescript
// Before (excerpt):
import { ..., createContactDuplicateDetected, createContactMerged, ... } from './bus/events.js';

// After: add createContactElevated to the list
import { ..., createContactDuplicateDetected, createContactMerged, createContactElevated, ... } from './bus/events.js';
```

- [ ] **Step 2: Add `onContactElevated` callback in the `ContactService.createWithPostgres()` options block**

In `src/index.ts`, inside the `ContactService.createWithPostgres()` call (around line 549), add after `onContactMerged`:

```typescript
    onContactElevated: (contactId, reason) => {
      const event = createContactElevated({ contactId, reason });
      bus.publish('dispatch', event).catch((err: unknown) =>
        logger.error({ err }, 'Failed to publish contact.elevated — audit trail may be incomplete'),
      );
    },
```

- [ ] **Step 3: Add `contactService` to the `Dispatcher` config block**

In `src/index.ts`, inside the `new Dispatcher({...})` call (around line 1890), add `contactService` alongside `confidencePipeline`:

```typescript
    confidencePipeline,
    selfEmail: resolvedEmailAccounts[0]?.selfEmail,
    outboundContextService,
    contactService,       // ← add this line
```

- [ ] **Step 4: Run the full test suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run test
```

Expected: all tests PASS (no regressions).

- [ ] **Step 5: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 run typecheck
```

Expected: no errors.

- [ ] **Step 6: Add CHANGELOG entry**

In `CHANGELOG.md`, add to the first `### Added` section under `## [Unreleased]`:

```markdown
- **Auto-elevation** — contacts are automatically promoted from `tier='unknown'` to `tier='known'` via three signal paths: correspondence (outbound email sent to the contact), domain-validated (first inbound from an org-kind contact), and judgment (confidence score crosses the 0.20 threshold). New `contact.elevated` bus event for the audit trail. Automated and agent contacts are excluded at the database layer. (#951)
```

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 add src/index.ts CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-auto-elevation-951 commit -m "feat: wire contact auto-elevation in bootstrap; add CHANGELOG entry (#951)"
```

---

## Self-Review Checklist

After completing all tasks, verify coverage against the design spec:

- [ ] **Path 1** (`handleSkillResult` — correspondence): tests and implementation present ✓
- [ ] **Path 2** (`handleInboundMessage` — domain-validated org): tests and implementation present ✓
- [ ] **Path 3** (`handleInboundMessage` — judgment threshold): tests and implementation present ✓
- [ ] **`JUDGMENT_ELEVATION_THRESHOLD`** exported constant: present ✓
- [ ] **`incrementalUpdate()` returns `Promise<number>`**: change + test present ✓
- [ ] **`contact.elevated` bus event**: payload, event, union, factory present ✓
- [ ] **`elevateTierToKnown()`**: backend interface, Postgres backend, InMemory backend, service, callback present ✓
- [ ] **Wiring in `index.ts`**: `onContactElevated` + `contactService` in dispatcher ✓
- [ ] **No DB migration**: confirmed — writes only to existing `tier` column ✓
- [ ] **Automated/agent exclusion**: enforced at DB level in Postgres backend (`AND kind NOT IN ('automated','agent')`) and in-memory backend (explicit guard) ✓
- [ ] **TOCTOU safety**: `WHERE tier='unknown'` in SQL prevents double-elevation races ✓
- [ ] **Fire-and-forget safety**: all elevation calls have `.catch()` — failures log at warn level and never throw ✓
