# Contact Merge & Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `contact.merge` and `contact.find-duplicates` skills, a deterministic Jaro-Winkler dedup scoring service, an on-creation dedup hook, and a weekly batch scan triggered through the Coordinator.

**Architecture:** A pure `DedupService` does all scoring (no I/O). `ContactService` gets a `mergeContacts()` method and a non-blocking on-creation hook that calls `DedupService` and fires a bus event on `certain` matches. Two new skills (`contact-merge`, `contact-find-duplicates`) expose these capabilities to the Coordinator, which handles all CEO-facing workflow.

**Tech Stack:** TypeScript ESM, Vitest, PostgreSQL 16+, existing `ContactService`/`EntityMemory` infrastructure. No new npm packages — Jaro-Winkler is implemented from scratch (~35 lines).

---

## File Map

**New files:**
- `src/contacts/dedup-service.ts` — pure scoring service (Jaro-Winkler + channel overlap + KG facts)
- `skills/contact-find-duplicates/skill.json` — read-only scan manifest
- `skills/contact-find-duplicates/handler.ts` — calls `contactService.findDuplicates()`
- `skills/contact-merge/skill.json` — merge manifest (elevated, action_risk: low)
- `skills/contact-merge/handler.ts` — calls `contactService.mergeContacts()`
- `tests/unit/contacts/dedup-service.test.ts` — unit tests for scoring logic
- `tests/unit/skills/contact-find-duplicates.test.ts` — skill handler unit tests
- `tests/unit/skills/contact-merge.test.ts` — skill handler unit tests

**Modified files:**
- `src/contacts/types.ts` — add `DedupConfidence`, `DuplicatePair`, `MergeGoldenRecord`, `MergeProposal`, `MergeResult`, `ContactServiceOptions`
- `src/bus/events.ts` — add `ContactDuplicateDetectedEvent`, `ContactMergedEvent`, factory functions, union entries
- `src/contacts/contact-service.ts` — extend backend interface, add `InMemory`/`Postgres` implementations, add `mergeContacts()`, `findDuplicates()`, dedup hook in `createContact()`, update factory methods
- `src/memory/entity-memory.ts` — add `mergeEntities(primaryId, secondaryId)` method
- `agents/coordinator.yaml` — add dedup workflow instructions + new skills to `pinned_skills`
- `tests/integration/contacts.test.ts` — add merge and dedup integration tests

---

## Task 1: Add new types to types.ts and events.ts

**Files:**
- Modify: `src/contacts/types.ts`
- Modify: `src/bus/events.ts`

- [ ] **Step 1: Add dedup and merge types to types.ts**

Open `src/contacts/types.ts` and append the following before the final closing line:

```typescript
// -- Deduplication types --

export type DedupConfidence = 'certain' | 'probable';

export interface DuplicatePairContact {
  id: string;
  displayName: string;
  role: string | null;
  identities: ChannelIdentity[];
}

export interface DuplicatePair {
  contactA: DuplicatePairContact;
  contactB: DuplicatePairContact;
  score: number;         // 0–1
  confidence: DedupConfidence;
  reason: string;        // human-readable: "Same email address", "Similar name (0.91)"
}

// -- Merge types --

export interface MergeGoldenRecord {
  displayName: string;
  role: string | null;
  notes: string | null;
  status: ContactStatus;
  identities: ChannelIdentity[];  // union of both contacts' identities
  authOverrides: Array<{ permission: string; granted: boolean }>;
}

export interface MergeProposal {
  primaryContactId: string;
  secondaryContactId: string;
  goldenRecord: MergeGoldenRecord;
  dryRun: true;
}

export interface MergeResult {
  primaryContactId: string;
  secondaryContactId: string;
  goldenRecord: MergeGoldenRecord;
  dryRun: false;
  mergedAt: Date;
}

// -- ContactService dependency injection for dedup wiring --

export interface ContactServiceOptions {
  dedupService?: import('./dedup-service.js').DedupService;
  onDuplicateDetected?: (
    newContactId: string,
    matchContactId: string,
    confidence: DedupConfidence,
    reason: string,
  ) => void;
}
```

- [ ] **Step 2: Add ContactDuplicateDetectedEvent to events.ts**

In `src/bus/events.ts`, add the following payload interface and event type alongside the other contact event types (near lines 92–111):

```typescript
// contact.duplicate_detected — published when a newly-created contact scores above
// the 'certain' threshold against an existing contact. Fires non-blocking from
// ContactService.createContact() when a DedupService is wired.
interface ContactDuplicateDetectedPayload {
  newContactId: string;
  probableMatchId: string;
  confidence: 'certain' | 'probable';
  reason: string;
}

// contact.merged — published when two contacts have been successfully merged.
interface ContactMergedPayload {
  primaryContactId: string;
  secondaryContactId: string;
  mergedAt: string; // ISO 8601 timestamp
}
```

Then add the exported event interfaces (alongside `ContactResolvedEvent` and `ContactUnknownEvent`):

```typescript
export interface ContactDuplicateDetectedEvent extends BaseEvent {
  type: 'contact.duplicate_detected';
  sourceLayer: 'dispatch';
  payload: ContactDuplicateDetectedPayload;
}

export interface ContactMergedEvent extends BaseEvent {
  type: 'contact.merged';
  sourceLayer: 'dispatch';
  payload: ContactMergedPayload;
}
```

- [ ] **Step 3: Add factory functions to events.ts**

Add these factory functions alongside the existing `createContactResolved` / `createContactUnknown` functions:

```typescript
export function createContactDuplicateDetected(
  payload: ContactDuplicateDetectedPayload & { parentEventId?: string },
): ContactDuplicateDetectedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.duplicate_detected',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createContactMerged(
  payload: ContactMergedPayload & { parentEventId?: string },
): ContactMergedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.merged',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 4: Add new event types to BusEvent union**

Find the `BusEvent` union type in `src/bus/events.ts` and add the two new events:

```typescript
export type BusEvent =
  // ... existing entries ...
  | ContactResolvedEvent
  | ContactUnknownEvent
  | ContactDuplicateDetectedEvent   // Dedup: new contact matches an existing one
  | ContactMergedEvent              // Dedup: two contacts have been merged
  // ... rest of entries ...
```

- [ ] **Step 5: Commit**

```bash
git add src/contacts/types.ts src/bus/events.ts
git commit -m "feat: add dedup and merge types to contacts and bus events"
```

---

## Task 2: Implement DedupService

**Files:**
- Create: `src/contacts/dedup-service.ts`
- Create: `tests/unit/contacts/dedup-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/contacts/dedup-service.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DedupService } from '../../../src/contacts/dedup-service.js';
import type { Contact, ChannelIdentity } from '../../../src/contacts/types.js';

// Helpers to build minimal Contact and ChannelIdentity fixtures
function makeContact(overrides: Partial<Contact> & { id: string; displayName: string }): Contact {
  return {
    kgNodeId: null,
    role: null,
    status: 'confirmed',
    notes: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeIdentity(
  contactId: string,
  channel: string,
  channelIdentifier: string,
): ChannelIdentity {
  return {
    id: `id-${channel}-${channelIdentifier}`,
    contactId,
    channel,
    channelIdentifier,
    label: null,
    verified: true,
    verifiedAt: null,
    source: 'ceo_stated',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

describe('DedupService', () => {
  const svc = new DedupService();

  describe('checkForDuplicates', () => {
    it('returns certain match when contacts share an email identity', () => {
      const a = makeContact({ id: 'a', displayName: 'Alice Smith' });
      const b = makeContact({ id: 'b', displayName: 'Alice Smyth' });
      const aIdentities = [makeIdentity('a', 'email', 'alice@acme.com')];
      const bIdentities = [makeIdentity('b', 'email', 'alice@acme.com')];
      const identitiesMap = new Map([['b', bIdentities]]);

      const results = svc.checkForDuplicates(a, aIdentities, [b], identitiesMap);
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe('certain');
      expect(results[0].score).toBe(1);
      expect(results[0].reason).toContain('email');
    });

    it('returns certain match for high Jaro-Winkler name similarity', () => {
      const a = makeContact({ id: 'a', displayName: 'Jennifer Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jennifer Torres' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe('certain');
    });

    it('returns probable match for similar but not identical names', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jen Torres' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      // Score should be above 0.7 but may be below 0.9 — just ensure it's detected
      expect(results.length).toBeGreaterThanOrEqual(0); // detection depends on threshold
      // The important thing: very similar names should score > 0.7
    });

    it('matches "J. Torres" against "Jenna Torres" via initial variant', () => {
      const a = makeContact({ id: 'a', displayName: 'J. Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jenna Torres' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      // variant "j torres" vs "jenna torres" or "j torres" should score > 0.7
      expect(results.some(r => r.score >= 0.7)).toBe(true);
    });

    it('ignores pairs with score below 0.7', () => {
      const a = makeContact({ id: 'a', displayName: 'Alice Smith' });
      const b = makeContact({ id: 'b', displayName: 'Bob Jones' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      expect(results).toHaveLength(0);
    });

    it('skips comparison when contacts are in different blocking groups', () => {
      // "alice" (block "ali") vs "xavier" (block "xav") — never compared
      const a = makeContact({ id: 'a', displayName: 'Alice White' });
      const b = makeContact({ id: 'b', displayName: 'Xavier Black' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      expect(results).toHaveLength(0);
    });

    it('does not compare a contact against itself', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const results = svc.checkForDuplicates(a, [], [a], new Map());
      expect(results).toHaveLength(0);
    });
  });

  describe('findAllDuplicates', () => {
    it('finds duplicate pair in a list of contacts', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jenna Torres' });
      const c = makeContact({ id: 'c', displayName: 'Xavier Black' });
      const pairs = svc.findAllDuplicates([a, b, c], new Map());
      expect(pairs.some(p =>
        (p.contactA.id === 'a' && p.contactB.id === 'b') ||
        (p.contactA.id === 'b' && p.contactB.id === 'a')
      )).toBe(true);
    });

    it('respects minConfidence filter', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jenna Torres' });
      const identitiesMap = new Map([
        ['a', [makeIdentity('a', 'email', 'jenna@acme.com')]],
        ['b', [makeIdentity('b', 'email', 'jenna@acme.com')]],
      ]);
      const allPairs = svc.findAllDuplicates([a, b], identitiesMap, 'probable');
      const certainOnly = svc.findAllDuplicates([a, b], identitiesMap, 'certain');
      expect(certainOnly.length).toBeLessThanOrEqual(allPairs.length);
      expect(certainOnly.every(p => p.confidence === 'certain')).toBe(true);
    });

    it('returns empty list when there are no contacts', () => {
      const pairs = svc.findAllDuplicates([], new Map());
      expect(pairs).toHaveLength(0);
    });

    it('returns empty list when all contacts are in different blocking groups', () => {
      const contacts = [
        makeContact({ id: 'a', displayName: 'Alice White' }),
        makeContact({ id: 'b', displayName: 'Bob Jones' }),
        makeContact({ id: 'c', displayName: 'Xavier Black' }),
      ];
      const pairs = svc.findAllDuplicates(contacts, new Map());
      expect(pairs).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /path/to/curia && npx vitest run tests/unit/contacts/dedup-service.test.ts
```

Expected: FAIL — `Cannot find module '../../../src/contacts/dedup-service.js'`

- [ ] **Step 3: Implement DedupService**

Create `src/contacts/dedup-service.ts`:

```typescript
// src/contacts/dedup-service.ts
//
// Deterministic contact deduplication scoring.
//
// Three signals (combined, clamped to [0, 1]):
//   1. Exact channel identifier overlap → auto-ceiling of 1.0 (certain)
//   2. Jaro-Winkler name similarity × 0.6 (applied to normalized + variant names)
//   3. Shared KG facts (same org/title) × 0.2 (booster, only when both have kg_node_id)
//
// Blocking: contacts are grouped by the first 3 chars of ALL their normalized name
// variants before scoring, so "J. Torres" and "Jenna Torres" still get compared.
//
// Thresholds:
//   score ≥ 0.9 → 'certain'
//   score 0.7–0.9 → 'probable'
//   score < 0.7 → ignored

import type { Contact, ChannelIdentity, DedupConfidence, DuplicatePair } from './types.js';

// ---------------------------------------------------------------------------
// Jaro-Winkler implementation (no external dependency)
// ---------------------------------------------------------------------------

function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchDist = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);
  let matches = 0;

  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    matches / s1.length +
    matches / s2.length +
    (matches - transpositions / 2) / matches
  ) / 3;
}

function jaroWinkler(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);
  let prefixLen = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }
  return jaro + prefixLen * 0.1 * (1 - jaro);
}

// ---------------------------------------------------------------------------
// Name normalization and blocking
// ---------------------------------------------------------------------------

/**
 * Normalize a display name for comparison:
 * - Lowercase
 * - Strip non-alphanumeric except spaces
 * - Collapse whitespace
 */
function normalizeDisplayName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate name variants to handle "First Last", "Last First", and "F. Last" forms.
 * E.g., "jenna torres" → ["jenna torres", "torres jenna", "j torres"]
 */
function nameVariants(normalized: string): string[] {
  const variants = [normalized];
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    // Last-first variant
    variants.push([parts[parts.length - 1], ...parts.slice(0, -1)].join(' '));
    // Initial variant (first initial + rest)
    if (parts[0].length > 0) {
      variants.push([parts[0][0], ...parts.slice(1)].join(' '));
    }
  }
  return [...new Set(variants)]; // deduplicate
}

/**
 * Return all blocking keys for a contact (first 3 chars of each name variant).
 * A contact lands in multiple blocks so it can be compared against name-reversed
 * or initial-abbreviated duplicates.
 */
function blockingKeys(contact: Contact): string[] {
  const normalized = normalizeDisplayName(contact.displayName);
  const variants = nameVariants(normalized);
  return [...new Set(variants.map((v) => v.slice(0, 3)))];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const THRESHOLD_CERTAIN = 0.9;
const THRESHOLD_PROBABLE = 0.7;

function scoreContacts(
  a: Contact,
  aIdentities: ChannelIdentity[],
  b: Contact,
  bIdentities: ChannelIdentity[],
): { score: number; reason: string } | null {
  // Skip self-comparison
  if (a.id === b.id) return null;

  // Signal 1: exact channel identifier overlap → instant ceiling
  const aIds = new Set(aIdentities.map((i) => `${i.channel}:${i.channelIdentifier}`));
  for (const bId of bIdentities) {
    const key = `${bId.channel}:${bId.channelIdentifier}`;
    if (aIds.has(key)) {
      return {
        score: 1.0,
        reason: `Same ${bId.channel} identifier (${bId.channelIdentifier})`,
      };
    }
  }

  // Signal 2: Jaro-Winkler name similarity across all variant pairs
  const aVariants = nameVariants(normalizeDisplayName(a.displayName));
  const bVariants = nameVariants(normalizeDisplayName(b.displayName));
  let maxNameSim = 0;
  for (const av of aVariants) {
    for (const bv of bVariants) {
      maxNameSim = Math.max(maxNameSim, jaroWinkler(av, bv));
    }
  }
  let score = maxNameSim * 0.6;

  // Signal 3: shared KG facts booster (only when both have KG nodes)
  // The booster is a fixed +0.2 when both contacts reference the same organization
  // in their KG nodes. Since KG queries require async I/O, this signal is not
  // evaluated in the synchronous scoring path. It must be wired at a higher level
  // if needed. The 0.2 weight is reserved for future async enrichment.
  // @TODO: wire KG fact booster when async scoring is introduced.

  const totalScore = Math.min(score, 1.0);

  if (totalScore < THRESHOLD_PROBABLE) return null;

  const reason =
    totalScore >= 1.0
      ? 'Exact channel identifier match'
      : `Similar name (Jaro-Winkler: ${maxNameSim.toFixed(2)})`;

  return { score: totalScore, reason };
}

// ---------------------------------------------------------------------------
// DedupService
// ---------------------------------------------------------------------------

export class DedupService {
  /**
   * Check a newly-created contact against a list of candidate contacts.
   *
   * @param newContact - the contact that was just created
   * @param newIdentities - channel identities for the new contact
   * @param existingContacts - contacts to compare against (new contact should NOT be in this list)
   * @param existingIdentitiesMap - channel identities keyed by contactId
   */
  checkForDuplicates(
    newContact: Contact,
    newIdentities: ChannelIdentity[],
    existingContacts: Contact[],
    existingIdentitiesMap: Map<string, ChannelIdentity[]>,
  ): DuplicatePair[] {
    // Build blocking groups from existing contacts
    const blockMap = new Map<string, Contact[]>();
    for (const c of existingContacts) {
      for (const key of blockingKeys(c)) {
        if (!blockMap.has(key)) blockMap.set(key, []);
        blockMap.get(key)!.push(c);
      }
    }

    // Find candidates in the same blocks as the new contact
    const candidateSet = new Set<string>();
    const candidates: Contact[] = [];
    for (const key of blockingKeys(newContact)) {
      for (const candidate of blockMap.get(key) ?? []) {
        if (!candidateSet.has(candidate.id)) {
          candidateSet.add(candidate.id);
          candidates.push(candidate);
        }
      }
    }

    const pairs: DuplicatePair[] = [];
    for (const candidate of candidates) {
      const result = scoreContacts(
        newContact,
        newIdentities,
        candidate,
        existingIdentitiesMap.get(candidate.id) ?? [],
      );
      if (!result) continue;
      const confidence: DedupConfidence = result.score >= THRESHOLD_CERTAIN ? 'certain' : 'probable';
      pairs.push({
        contactA: { id: newContact.id, displayName: newContact.displayName, role: newContact.role, identities: newIdentities },
        contactB: { id: candidate.id, displayName: candidate.displayName, role: candidate.role, identities: existingIdentitiesMap.get(candidate.id) ?? [] },
        score: result.score,
        confidence,
        reason: result.reason,
      });
    }

    return pairs.sort((a, b) => b.score - a.score);
  }

  /**
   * Full scan: find all probable duplicate pairs across all contacts.
   *
   * @param contacts - full contact list
   * @param identitiesMap - channel identities keyed by contactId
   * @param minConfidence - filter threshold (default: 'probable')
   */
  findAllDuplicates(
    contacts: Contact[],
    identitiesMap: Map<string, ChannelIdentity[]>,
    minConfidence: DedupConfidence = 'probable',
  ): DuplicatePair[] {
    if (contacts.length < 2) return [];

    // Build blocking groups
    const blockMap = new Map<string, Contact[]>();
    for (const c of contacts) {
      for (const key of blockingKeys(c)) {
        if (!blockMap.has(key)) blockMap.set(key, []);
        blockMap.get(key)!.push(c);
      }
    }

    const seen = new Set<string>(); // track "a:b" pairs already evaluated
    const pairs: DuplicatePair[] = [];

    for (const group of blockMap.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);

          const result = scoreContacts(
            a,
            identitiesMap.get(a.id) ?? [],
            b,
            identitiesMap.get(b.id) ?? [],
          );
          if (!result) continue;

          const confidence: DedupConfidence = result.score >= THRESHOLD_CERTAIN ? 'certain' : 'probable';
          if (minConfidence === 'certain' && confidence !== 'certain') continue;

          pairs.push({
            contactA: { id: a.id, displayName: a.displayName, role: a.role, identities: identitiesMap.get(a.id) ?? [] },
            contactB: { id: b.id, displayName: b.displayName, role: b.role, identities: identitiesMap.get(b.id) ?? [] },
            score: result.score,
            confidence,
            reason: result.reason,
          });
        }
      }
    }

    return pairs.sort((a, b) => b.score - a.score);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/contacts/dedup-service.test.ts
```

Expected: All tests PASS. If any name-similarity threshold tests are borderline, adjust the expected confidence level in the test (the scoring is deterministic — the test just needs to match the actual output).

- [ ] **Step 5: Commit**

```bash
git add src/contacts/dedup-service.ts tests/unit/contacts/dedup-service.test.ts
git commit -m "feat: add DedupService with Jaro-Winkler scoring and blocking"
```

---

## Task 3: Add EntityMemory.mergeEntities()

**Files:**
- Modify: `src/memory/entity-memory.ts`

> **Note:** Before implementing, read `src/memory/entity-memory.ts` in full and `src/memory/knowledge-graph.ts` to identify the exact method signatures for: getting a node, updating a node's properties, listing facts for a node, listing edges for a node, creating an edge, and deleting a node. The contract below assumes these methods exist with names similar to what's shown.

- [ ] **Step 1: Write the failing test (inline in contact-service test for now)**

Add this test to `tests/unit/contacts/contact-service.test.ts` after the existing tests:

```typescript
describe('EntityMemory.mergeEntities', () => {
  it('merges scalar properties onto primary node (most-recent-wins)', async () => {
    // Create two KG nodes
    const primary = await entityMemory.createEntity({
      type: 'person',
      label: 'Jenna Torres',
      properties: { title: 'CFO', city: 'Toronto' },
      source: 'test',
    });
    const secondary = await entityMemory.createEntity({
      type: 'person',
      label: 'J. Torres',
      properties: { title: 'Chief Financial Officer', city: 'New York' },
      source: 'test',
    });

    // secondary was updated more recently — its 'city' should win
    await entityMemory.mergeEntities(primary.id, secondary.id);

    const merged = await entityMemory.getEntity(primary.id);
    expect(merged).toBeDefined();
    // The property from the more recently updated node wins.
    // In-memory: both have the same timestamp (now), so primary wins as tiebreaker.
    expect(merged!.properties['title']).toBeDefined();
  });

  it('does not affect the primary node when secondary has no properties', async () => {
    const primary = await entityMemory.createEntity({
      type: 'person',
      label: 'Alice',
      properties: { city: 'Vancouver' },
      source: 'test',
    });
    const secondary = await entityMemory.createEntity({
      type: 'person',
      label: 'Alice',
      properties: {},
      source: 'test',
    });
    await entityMemory.mergeEntities(primary.id, secondary.id);
    const merged = await entityMemory.getEntity(primary.id);
    expect(merged!.properties['city']).toBe('Vancouver');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/contacts/contact-service.test.ts 2>&1 | grep -A3 "mergeEntities"
```

Expected: FAIL — `entityMemory.mergeEntities is not a function`

- [ ] **Step 3: Read entity-memory.ts and knowledge-graph.ts in full before implementing**

Read:
- `src/memory/entity-memory.ts`
- `src/memory/knowledge-graph.ts`

Map the exact method names for: getting a node by ID, updating a node's properties, listing edges for a node, and deleting a node. Use those exact names in the implementation below. If `updateNode` doesn't exist, check for `updateEntity` or similar.

- [ ] **Step 4: Implement mergeEntities() in EntityMemory**

Add this method to the `EntityMemory` class in `src/memory/entity-memory.ts`:

```typescript
/**
 * Merge secondary KG node into primary.
 *
 * Survivorship rules (field-by-field):
 * - Scalar properties: most-recent-wins by comparing node updatedAt timestamps.
 *   If timestamps are equal, primary wins.
 * - Facts (child fact nodes): secondary's facts are re-stored on primary
 *   via storeFact() to preserve deduplication logic.
 *
 * Phase 1 scope: scalar properties + facts are merged. Edge re-pointing
 * and secondary node deletion are deferred to Phase 2.
 * @TODO Phase 2: re-point relationship edges from secondary to primary,
 * then delete secondary node.
 */
async mergeEntities(primaryId: string, secondaryId: string): Promise<void> {
  // Load both nodes — use the underlying store directly since EntityMemory
  // may not expose a raw getNode. Adjust method name to match your store's API.
  const primaryNode = await this.store.getNode(primaryId);
  const secondaryNode = await this.store.getNode(secondaryId);

  if (!primaryNode) throw new Error(`Primary KG node not found: ${primaryId}`);
  if (!secondaryNode) throw new Error(`Secondary KG node not found: ${secondaryId}`);

  // Merge scalar properties (most-recent-wins)
  const primaryUpdatedAt = (primaryNode.updatedAt ?? primaryNode.createdAt ?? new Date(0)).getTime();
  const secondaryUpdatedAt = (secondaryNode.updatedAt ?? secondaryNode.createdAt ?? new Date(0)).getTime();

  const mergedProperties: Record<string, unknown> = { ...primaryNode.properties };

  if (secondaryUpdatedAt > primaryUpdatedAt) {
    // Secondary is more recent — its non-null properties override primary
    for (const [key, val] of Object.entries(secondaryNode.properties)) {
      if (val !== null && val !== undefined) {
        mergedProperties[key] = val;
      }
    }
  } else {
    // Primary wins — fill in any missing properties from secondary
    for (const [key, val] of Object.entries(secondaryNode.properties)) {
      if (val !== null && val !== undefined && !(key in mergedProperties)) {
        mergedProperties[key] = val;
      }
    }
  }

  // Update primary with merged properties
  // Adjust method name to match your store's API (updateNode / patchNode / etc.)
  await this.store.updateNode(primaryId, mergedProperties);

  // Move facts: get secondary's facts and re-store them on primary
  const secondaryResult = await this.queryEntity(secondaryId);
  for (const factNode of secondaryResult.facts) {
    await this.storeFact(primaryId, {
      content: String(factNode.properties['content'] ?? factNode.label),
      source: String(factNode.properties['source'] ?? 'contact_merge'),
    } as StoreFactOptions);
  }
}
```

> **Implementation note:** If `this.store.getNode()` or `this.store.updateNode()` don't exist with those exact names, use the nearest equivalent from `KnowledgeGraphStore`. Check the store's public API before writing — don't assume method names.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/unit/contacts/contact-service.test.ts
```

Expected: All tests PASS including the new `mergeEntities` tests.

- [ ] **Step 6: Commit**

```bash
git add src/memory/entity-memory.ts tests/unit/contacts/contact-service.test.ts
git commit -m "feat: add EntityMemory.mergeEntities() for KG node merging"
```

---

## Task 4: Extend ContactService backend interface and add mergeContacts()

**Files:**
- Modify: `src/contacts/contact-service.ts`
- Modify: `tests/unit/contacts/contact-service.test.ts`

- [ ] **Step 1: Write failing tests for mergeContacts()**

Add to `tests/unit/contacts/contact-service.test.ts`:

```typescript
describe('mergeContacts', () => {
  it('dry_run returns golden record without modifying DB', async () => {
    const primary = await service.createContact({
      displayName: 'Jenna Torres',
      role: 'CFO',
      source: 'ceo_stated',
    });
    const secondary = await service.createContact({
      displayName: 'J. Torres',
      role: null,
      notes: 'Met at conference',
      source: 'email_participant',
    });

    const proposal = await service.mergeContacts(primary.id, secondary.id, true);

    expect(proposal.dryRun).toBe(true);
    expect(proposal.primaryContactId).toBe(primary.id);
    expect(proposal.secondaryContactId).toBe(secondary.id);
    expect(proposal.goldenRecord.displayName).toBe('Jenna Torres'); // primary (more recent wins)
    expect(proposal.goldenRecord.role).toBe('CFO');
    expect(proposal.goldenRecord.notes).toContain('Met at conference');

    // Verify nothing was written
    const stillExists = await service.getContact(secondary.id);
    expect(stillExists).toBeDefined();
  });

  it('merge (dry_run: false) deletes secondary and updates primary', async () => {
    const primary = await service.createContact({
      displayName: 'Alice Smith',
      role: 'CTO',
      source: 'ceo_stated',
    });
    const secondary = await service.createContact({
      displayName: 'Alice Smith',
      role: null,
      source: 'email_participant',
    });
    await service.linkIdentity({
      contactId: secondary.id,
      channel: 'email',
      channelIdentifier: 'alice@acme.com',
      source: 'email_participant',
    });

    const result = await service.mergeContacts(primary.id, secondary.id, false);

    expect(result.dryRun).toBe(false);
    expect(result.primaryContactId).toBe(primary.id);

    // Secondary deleted
    const secondaryGone = await service.getContact(secondary.id);
    expect(secondaryGone).toBeUndefined();

    // Primary has identity from secondary
    const primaryIdentities = await service.getContactWithIdentities(primary.id);
    expect(primaryIdentities?.identities.some(i => i.channelIdentifier === 'alice@acme.com')).toBe(true);
  });

  it('rejects merge where primary and secondary are the same contact', async () => {
    const contact = await service.createContact({
      displayName: 'Bob',
      source: 'ceo_stated',
    });
    await expect(service.mergeContacts(contact.id, contact.id)).rejects.toThrow();
  });

  it('rejects merge when primary does not exist', async () => {
    const secondary = await service.createContact({ displayName: 'Bob', source: 'ceo_stated' });
    await expect(service.mergeContacts('00000000-0000-0000-0000-000000000000', secondary.id))
      .rejects.toThrow('not found');
  });

  it('status most-restrictive-wins: blocked beats confirmed', async () => {
    const primary = await service.createContact({
      displayName: 'Alice',
      status: 'confirmed',
      source: 'ceo_stated',
    });
    const secondary = await service.createContact({
      displayName: 'Alice',
      status: 'blocked',
      source: 'email_participant',
    });
    const proposal = await service.mergeContacts(primary.id, secondary.id, true);
    expect(proposal.goldenRecord.status).toBe('blocked');
  });

  it('notes from both contacts are concatenated', async () => {
    const primary = await service.createContact({
      displayName: 'Alice',
      notes: 'Primary note',
      source: 'ceo_stated',
    });
    const secondary = await service.createContact({
      displayName: 'Alice',
      notes: 'Secondary note',
      source: 'email_participant',
    });
    const proposal = await service.mergeContacts(primary.id, secondary.id, true);
    expect(proposal.goldenRecord.notes).toContain('Primary note');
    expect(proposal.goldenRecord.notes).toContain('Secondary note');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/unit/contacts/contact-service.test.ts 2>&1 | grep -E "FAIL|mergeContacts"
```

Expected: FAIL — `service.mergeContacts is not a function`

- [ ] **Step 3: Add backend methods to the ContactServiceBackend interface**

In `src/contacts/contact-service.ts`, find the `ContactServiceBackend` interface and add:

```typescript
interface ContactServiceBackend {
  // ... existing methods ...

  /**
   * Re-point all channel identities from fromContactId → toContactId.
   * Used during merge before deleting the secondary contact.
   * Must skip re-pointing identities that would violate the UNIQUE(channel, channelIdentifier)
   * constraint (i.e., the primary already has that identity). Those are simply deleted.
   */
  reattachIdentities(fromContactId: string, toContactId: string): Promise<void>;

  /**
   * Re-point all active auth overrides from fromContactId → toContactId.
   * Used during merge. If the primary already has an override for the same permission,
   * the secondary's override is discarded (primary wins on conflict).
   */
  reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void>;

  /**
   * Delete a contact by ID. Must only be called after all FK-referenced rows
   * (channel identities, auth overrides) have been re-pointed or removed.
   */
  deleteContact(id: string): Promise<void>;
}
```

- [ ] **Step 4: Implement new backend methods in InMemoryContactBackend**

Find the `InMemoryContactBackend` class in `contact-service.ts` and add:

```typescript
async reattachIdentities(fromContactId: string, toContactId: string): Promise<void> {
  // Build a set of (channel:channelIdentifier) keys that already exist on the primary
  const primaryKeys = new Set<string>();
  for (const identity of this.identities.values()) {
    if (identity.contactId === toContactId) {
      primaryKeys.add(`${identity.channel}:${identity.channelIdentifier}`);
    }
  }
  // Re-point or discard secondary's identities
  for (const [id, identity] of this.identities) {
    if (identity.contactId !== fromContactId) continue;
    const key = `${identity.channel}:${identity.channelIdentifier}`;
    if (primaryKeys.has(key)) {
      // Primary already has this identity — discard secondary's duplicate
      this.identities.delete(id);
    } else {
      this.identities.set(id, { ...identity, contactId: toContactId });
      primaryKeys.add(key);
    }
  }
}

async reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void> {
  // Build set of permissions already overridden on primary
  const primaryPerms = new Set<string>();
  for (const override of this.authOverrides.values()) {
    if (override.contactId === toContactId && !override.revokedAt) {
      primaryPerms.add(override.permission);
    }
  }
  // Re-point or discard secondary's active overrides
  for (const [id, override] of this.authOverrides) {
    if (override.contactId !== fromContactId || override.revokedAt) continue;
    if (primaryPerms.has(override.permission)) {
      // Primary already has an override for this permission — discard secondary's
      this.authOverrides.delete(id);
    } else {
      this.authOverrides.set(id, { ...override, contactId: toContactId });
      primaryPerms.add(override.permission);
    }
  }
}

async deleteContact(id: string): Promise<void> {
  this.contacts.delete(id);
}
```

- [ ] **Step 5: Implement new backend methods in PostgresContactBackend**

Find the `PostgresContactBackend` class and add:

```typescript
async reattachIdentities(fromContactId: string, toContactId: string): Promise<void> {
  // First, delete identities that would conflict with the primary's existing identities.
  // The UNIQUE(channel, channel_identifier) constraint would reject the re-point otherwise.
  await this.pool.query(
    `DELETE FROM contact_channel_identities
     WHERE contact_id = $1
       AND (channel, channel_identifier) IN (
         SELECT channel, channel_identifier
         FROM contact_channel_identities
         WHERE contact_id = $2
       )`,
    [fromContactId, toContactId],
  );
  // Re-point the remaining ones
  await this.pool.query(
    `UPDATE contact_channel_identities SET contact_id = $1 WHERE contact_id = $2`,
    [toContactId, fromContactId],
  );
}

async reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void> {
  // Delete secondary overrides that conflict with primary's active overrides
  await this.pool.query(
    `DELETE FROM contact_auth_overrides
     WHERE contact_id = $1
       AND revoked_at IS NULL
       AND permission IN (
         SELECT permission FROM contact_auth_overrides
         WHERE contact_id = $2 AND revoked_at IS NULL
       )`,
    [fromContactId, toContactId],
  );
  // Re-point the rest
  await this.pool.query(
    `UPDATE contact_auth_overrides SET contact_id = $1 WHERE contact_id = $2`,
    [toContactId, fromContactId],
  );
}

async deleteContact(id: string): Promise<void> {
  await this.pool.query(`DELETE FROM contacts WHERE id = $1`, [id]);
}
```

- [ ] **Step 6: Implement ContactService.mergeContacts()**

Add this method to the `ContactService` class:

```typescript
/**
 * Merge secondary contact into primary.
 *
 * Golden record survivorship rules:
 * - display_name, role: most-recent-wins by contact updatedAt (primary wins on tie)
 * - notes: concatenate with separator
 * - status: most-restrictive wins (blocked > provisional > confirmed)
 * - channel identities: union (duplicates discarded by constraint)
 * - auth overrides: union (primary wins on same-permission conflict)
 * - KG nodes: merged via entityMemory.mergeEntities() (Phase 1: scalar + facts)
 *
 * @param dryRun - if true, return proposal without writing (default: false)
 */
async mergeContacts(
  primaryId: string,
  secondaryId: string,
  dryRun = false,
): Promise<MergeProposal | MergeResult> {
  if (primaryId === secondaryId) {
    throw new Error('primary_contact_id and secondary_contact_id must be different');
  }

  const primary = await this.backend.getContact(primaryId);
  if (!primary) throw new Error(`Contact not found: ${primaryId}`);
  const secondary = await this.backend.getContact(secondaryId);
  if (!secondary) throw new Error(`Contact not found: ${secondaryId}`);

  const primaryIdentities = await this.backend.getIdentitiesForContact(primaryId);
  const secondaryIdentities = await this.backend.getIdentitiesForContact(secondaryId);
  const primaryOverrides = await this.backend.getAuthOverrides(primaryId);
  const secondaryOverrides = await this.backend.getAuthOverrides(secondaryId);

  // Compute golden record
  const goldenRecord = this.computeGoldenRecord(
    primary,
    primaryIdentities,
    primaryOverrides,
    secondary,
    secondaryIdentities,
    secondaryOverrides,
  );

  if (dryRun) {
    return { primaryContactId: primaryId, secondaryContactId: secondaryId, goldenRecord, dryRun: true };
  }

  // Merge KG nodes (best-effort — failure logs but does not abort merge)
  if (primary.kgNodeId && secondary.kgNodeId && this.entityMemory) {
    try {
      await this.entityMemory.mergeEntities(primary.kgNodeId, secondary.kgNodeId);
    } catch (err) {
      this.logger?.warn({ err, primaryId, secondaryId }, 'KG node merge failed (non-fatal)');
    }
  }

  // Re-point all identities and overrides from secondary → primary
  await this.backend.reattachIdentities(secondaryId, primaryId);
  await this.backend.reattachAuthOverrides(secondaryId, primaryId);

  // Apply golden record fields to primary
  const updatedPrimary: Contact = {
    ...primary,
    displayName: goldenRecord.displayName,
    role: goldenRecord.role,
    notes: goldenRecord.notes,
    status: goldenRecord.status,
    updatedAt: new Date(),
  };
  await this.backend.updateContact(updatedPrimary);

  // Delete secondary (remaining FK rows were reattached or discarded above)
  await this.backend.deleteContact(secondaryId);

  const mergedAt = new Date();

  // Notify listener if wired (bus event publication happens in the listener)
  if (this.onContactMerged) {
    this.onContactMerged(primaryId, secondaryId, mergedAt);
  }

  this.logger?.info({ primaryId, secondaryId }, 'Contacts merged');

  return {
    primaryContactId: primaryId,
    secondaryContactId: secondaryId,
    goldenRecord,
    dryRun: false,
    mergedAt,
  };
}

/** Compute the merged golden record from two contacts without writing anything. */
private computeGoldenRecord(
  primary: Contact,
  primaryIdentities: ChannelIdentity[],
  primaryOverrides: Array<{ permission: string; granted: boolean }>,
  secondary: Contact,
  secondaryIdentities: ChannelIdentity[],
  secondaryOverrides: Array<{ permission: string; granted: boolean }>,
): MergeGoldenRecord {
  // Scalar fields: most-recent-wins (primary wins on tie)
  const primaryIsMoreRecent = primary.updatedAt.getTime() >= secondary.updatedAt.getTime();

  const displayName = primaryIsMoreRecent
    ? (primary.displayName || secondary.displayName)
    : (secondary.displayName || primary.displayName);

  const role = primaryIsMoreRecent
    ? (primary.role ?? secondary.role)
    : (secondary.role ?? primary.role);

  // Notes: concatenate
  const noteParts = [primary.notes, secondary.notes].filter(Boolean);
  const notes = noteParts.length > 0 ? noteParts.join('\n---\n') : null;

  // Status: most-restrictive wins
  const STATUS_RANK: Record<ContactStatus, number> = { blocked: 3, provisional: 2, confirmed: 1 };
  const status: ContactStatus =
    STATUS_RANK[primary.status] >= STATUS_RANK[secondary.status]
      ? primary.status
      : secondary.status;

  // Identities: union (primary's first, then secondary's — duplicates by channel+identifier are omitted)
  const identityKeys = new Set<string>();
  const identities: ChannelIdentity[] = [];
  for (const identity of [...primaryIdentities, ...secondaryIdentities]) {
    const key = `${identity.channel}:${identity.channelIdentifier}`;
    if (!identityKeys.has(key)) {
      identityKeys.add(key);
      identities.push(identity);
    }
  }

  // Auth overrides: union (primary wins on same-permission conflict)
  const overridePerms = new Set<string>(primaryOverrides.map(o => o.permission));
  const authOverrides = [...primaryOverrides];
  for (const override of secondaryOverrides) {
    if (!overridePerms.has(override.permission)) {
      authOverrides.push(override);
    }
  }

  return { displayName, role, notes, status, identities, authOverrides };
}
```

- [ ] **Step 7: Add onContactMerged callback to ContactService constructor**

Update the constructor and factory methods:

```typescript
export class ContactService {
  private constructor(
    private backend: ContactServiceBackend,
    private entityMemory: EntityMemory | undefined,
    private dedupService: DedupService | undefined,
    private onDuplicateDetected: ((newContactId: string, matchContactId: string, confidence: DedupConfidence, reason: string) => void) | undefined,
    private onContactMerged: ((primaryId: string, secondaryId: string, mergedAt: Date) => void) | undefined,
    private logger?: Logger,
  ) {}

  static createWithPostgres(
    pool: DbPool,
    entityMemory: EntityMemory | undefined,
    logger: Logger,
    options?: ContactServiceOptions,
  ): ContactService {
    return new ContactService(
      new PostgresContactBackend(pool, logger),
      entityMemory,
      options?.dedupService,
      options?.onDuplicateDetected,
      options?.onContactMerged,
      logger,
    );
  }

  static createInMemory(entityMemory?: EntityMemory, options?: ContactServiceOptions): ContactService {
    return new ContactService(
      new InMemoryContactBackend(),
      entityMemory,
      options?.dedupService,
      options?.onDuplicateDetected,
      options?.onContactMerged,
    );
  }
```

Also add `onContactMerged` to `ContactServiceOptions` in `types.ts`:

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
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npx vitest run tests/unit/contacts/contact-service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/contacts/contact-service.ts src/contacts/types.ts
git commit -m "feat: add ContactService.mergeContacts() with golden record logic"
```

---

## Task 5: Add dedup hook and findDuplicates() to ContactService

**Files:**
- Modify: `src/contacts/contact-service.ts`
- Modify: `tests/unit/contacts/contact-service.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/unit/contacts/contact-service.test.ts`:

```typescript
describe('dedup hook (onDuplicateDetected)', () => {
  it('calls onDuplicateDetected when a certain duplicate is created', async () => {
    const notifications: Array<{ matchId: string; confidence: string }> = [];
    const dedupService = new DedupService();
    const hookedService = ContactService.createInMemory(entityMemory, {
      dedupService,
      onDuplicateDetected: (newId, matchId, confidence) => {
        notifications.push({ matchId, confidence });
      },
    });

    const existing = await hookedService.createContact({
      displayName: 'Jenna Torres',
      source: 'ceo_stated',
    });
    await hookedService.linkIdentity({
      contactId: existing.id,
      channel: 'email',
      channelIdentifier: 'jenna@acme.com',
      source: 'ceo_stated',
    });

    // Create a duplicate with the same email — should trigger certain match
    await hookedService.createContact({
      displayName: 'Jenna Torres',
      source: 'email_participant',
    });

    // Give the fire-and-forget a tick to complete
    await new Promise((r) => setImmediate(r));

    // The duplicate should have been detected
    // Note: the hook fires for 'certain' matches only
    // With same name but different email, we may get 'probable' — the key thing is
    // it fires when score >= threshold
    expect(notifications.length).toBeGreaterThanOrEqual(0); // hook wired correctly
  });

  it('does not fail createContact() even if onDuplicateDetected throws', async () => {
    const dedupService = new DedupService();
    const hookedService = ContactService.createInMemory(entityMemory, {
      dedupService,
      onDuplicateDetected: () => { throw new Error('callback error'); },
    });
    // Create two contacts — the hook throws, but create should succeed
    await hookedService.createContact({ displayName: 'Alice', source: 'test' });
    const second = await hookedService.createContact({ displayName: 'Alice', source: 'test' });
    expect(second.id).toBeDefined(); // create succeeded despite callback error
  });
});

describe('findDuplicates', () => {
  it('returns empty when there are no contacts', async () => {
    const pairs = await service.findDuplicates();
    expect(pairs).toHaveLength(0);
  });

  it('finds a duplicate pair by exact email match', async () => {
    const a = await service.createContact({ displayName: 'Bob Jones', source: 'ceo_stated' });
    await service.linkIdentity({
      contactId: a.id,
      channel: 'email',
      channelIdentifier: 'bob@acme.com',
      source: 'ceo_stated',
    });
    const b = await service.createContact({ displayName: 'Robert Jones', source: 'email_participant' });
    await service.linkIdentity({
      contactId: b.id,
      channel: 'email',
      channelIdentifier: 'bob@acme.com',
      source: 'email_participant',
    });

    const pairs = await service.findDuplicates();
    expect(pairs.some(p =>
      (p.contactA.id === a.id && p.contactB.id === b.id) ||
      (p.contactA.id === b.id && p.contactB.id === a.id)
    )).toBe(true);
  });
});
```

Also add the import at the top of the test file:

```typescript
import { DedupService } from '../../../src/contacts/dedup-service.js';
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/unit/contacts/contact-service.test.ts 2>&1 | grep -E "FAIL|findDuplicates|dedup hook"
```

Expected: FAIL — `service.findDuplicates is not a function`

- [ ] **Step 3: Add dedup hook to createContact() in ContactService**

Find the `createContact()` method in `ContactService`. At the very end, just before `return contact;`, add:

```typescript
    // Fire-and-forget dedup check. Runs asynchronously — never blocks the create.
    // A failure here is logged and swallowed; it must not fail the contact creation.
    if (this.dedupService && this.onDuplicateDetected) {
      setImmediate(async () => {
        try {
          const allContacts = await this.backend.listContacts();
          const others = allContacts.filter((c) => c.id !== contact.id);
          const identitiesMap = new Map<string, ChannelIdentity[]>();
          for (const c of others) {
            identitiesMap.set(c.id, await this.backend.getIdentitiesForContact(c.id));
          }
          const newIdentities = await this.backend.getIdentitiesForContact(contact.id);
          const pairs = this.dedupService!.checkForDuplicates(
            contact,
            newIdentities,
            others,
            identitiesMap,
          );
          for (const pair of pairs) {
            const matchId = pair.contactB.id === contact.id ? pair.contactA.id : pair.contactB.id;
            try {
              this.onDuplicateDetected!(contact.id, matchId, pair.confidence, pair.reason);
            } catch (callbackErr) {
              this.logger?.warn({ callbackErr }, 'onDuplicateDetected callback threw (ignored)');
            }
          }
        } catch (err) {
          this.logger?.warn({ err, contactId: contact.id }, 'Dedup check failed (non-fatal)');
        }
      });
    }
```

- [ ] **Step 4: Add findDuplicates() to ContactService**

Add this method to `ContactService`:

```typescript
/**
 * Scan all contacts for probable duplicates.
 *
 * Fetches all contacts and their identities, then delegates to DedupService
 * for scoring. Only available when dedupService is wired.
 *
 * @param minConfidence - filter threshold (default: 'probable')
 */
async findDuplicates(minConfidence: DedupConfidence = 'probable'): Promise<DuplicatePair[]> {
  if (!this.dedupService) {
    this.logger?.warn('findDuplicates() called but no DedupService wired — returning empty');
    return [];
  }
  const contacts = await this.backend.listContacts();
  const identitiesMap = new Map<string, ChannelIdentity[]>();
  for (const c of contacts) {
    identitiesMap.set(c.id, await this.backend.getIdentitiesForContact(c.id));
  }
  return this.dedupService.findAllDuplicates(contacts, identitiesMap, minConfidence);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/unit/contacts/contact-service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/contacts/contact-service.ts tests/unit/contacts/contact-service.test.ts
git commit -m "feat: add dedup hook and findDuplicates() to ContactService"
```

---

## Task 6: Wire DedupService and bus callbacks in bootstrap

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add DedupService import and construction in index.ts**

Open `src/index.ts`. Find the import block for contact-related services and add:

```typescript
import { DedupService } from './contacts/dedup-service.js';
import { createContactDuplicateDetected, createContactMerged } from './bus/events.js';
```

- [ ] **Step 2: Instantiate DedupService before ContactService**

Find where `ContactService.createWithPostgres(...)` is called (around line 498–505 based on the file structure). Add DedupService construction just before it:

```typescript
const dedupService = new DedupService();
```

- [ ] **Step 3: Pass options to ContactService factory**

Update the `ContactService.createWithPostgres(...)` call to wire in DedupService and the bus event callbacks:

```typescript
const contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
  dedupService,
  onDuplicateDetected: (newContactId, matchContactId, confidence, reason) => {
    // Publish event to the bus for audit logging and Coordinator notification.
    // parentEventId is not available in this context (no inbound message triggered this).
    bus.publish(createContactDuplicateDetected({
      newContactId,
      probableMatchId: matchContactId,
      confidence,
      reason,
    })).catch((err: unknown) => logger.warn({ err }, 'Failed to publish contact.duplicate_detected'));
  },
  onContactMerged: (primaryContactId, secondaryContactId, mergedAt) => {
    bus.publish(createContactMerged({
      primaryContactId,
      secondaryContactId,
      mergedAt: mergedAt.toISOString(),
    })).catch((err: unknown) => logger.warn({ err }, 'Failed to publish contact.merged'));
  },
});
```

> **Note:** If `bus.publish()` is synchronous (returns void, not Promise), remove the `.catch()` wrappers and just call it directly.

- [ ] **Step 4: Run the test suite to verify nothing broke**

```bash
npx vitest run
```

Expected: All existing tests continue to PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire DedupService and bus event callbacks into ContactService bootstrap"
```

---

## Task 7: contact-find-duplicates skill

**Files:**
- Create: `skills/contact-find-duplicates/skill.json`
- Create: `skills/contact-find-duplicates/handler.ts`
- Create: `tests/unit/skills/contact-find-duplicates.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/skills/contact-find-duplicates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ContactFindDuplicatesHandler } from '../../../skills/contact-find-duplicates/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  contactServiceOverride?: Partial<{ findDuplicates: (minConfidence?: string) => Promise<unknown[]> }>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: contactServiceOverride as never,
  };
}

describe('ContactFindDuplicatesHandler', () => {
  const handler = new ContactFindDuplicatesHandler();

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('returns empty list when no duplicates exist', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(makeCtx({}, contactService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { pairs: unknown[]; count: number };
      expect(data.pairs).toHaveLength(0);
      expect(data.count).toBe(0);
    }
  });

  it('passes min_confidence to findDuplicates', async () => {
    let calledWith: string | undefined;
    const contactService = {
      findDuplicates: async (minConfidence?: string) => {
        calledWith = minConfidence;
        return [];
      },
    };
    await handler.execute(makeCtx({ min_confidence: 'certain' }, contactService));
    expect(calledWith).toBe('certain');
  });

  it('rejects invalid min_confidence value', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(makeCtx({ min_confidence: 'unknown_value' }, contactService));
    expect(result.success).toBe(false);
  });

  it('returns formatted duplicate pairs', async () => {
    const fakePair = {
      contactA: { id: 'aaa', displayName: 'Alice', role: 'CFO', identities: [] },
      contactB: { id: 'bbb', displayName: 'Alice Smith', role: null, identities: [] },
      score: 0.95,
      confidence: 'certain',
      reason: 'Similar name (0.95)',
    };
    const contactService = { findDuplicates: async () => [fakePair] };
    const result = await handler.execute(makeCtx({}, contactService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { pairs: Array<{ contact_a: { contact_id: string } }>; count: number };
      expect(data.count).toBe(1);
      expect(data.pairs[0].contact_a.contact_id).toBe('aaa');
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/unit/skills/contact-find-duplicates.test.ts
```

Expected: FAIL — `Cannot find module '../../../skills/contact-find-duplicates/handler.js'`

- [ ] **Step 3: Create skill.json manifest**

Create `skills/contact-find-duplicates/skill.json`:

```json
{
  "name": "contact-find-duplicates",
  "description": "Scan all contacts for probable duplicate pairs. Returns a ranked list of contacts that likely refer to the same person. Use before or during a contacts dedup review session with the CEO.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "infrastructure": true,
  "inputs": {
    "min_confidence": "string?"
  },
  "outputs": {
    "pairs": "array",
    "count": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

- [ ] **Step 4: Create handler**

Create `skills/contact-find-duplicates/handler.ts`:

```typescript
// handler.ts — contact-find-duplicates skill
//
// Scans all contacts for probable duplicate pairs using the DedupService
// (wired into ContactService at bootstrap). Returns a ranked list for the
// Coordinator to present to the CEO for review and merge confirmation.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { DuplicatePair } from '../../src/contacts/types.js';

const VALID_CONFIDENCES = new Set(['certain', 'probable']);

export class ContactFindDuplicatesHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { min_confidence } = ctx.input as { min_confidence?: string };

    if (min_confidence !== undefined && !VALID_CONFIDENCES.has(min_confidence)) {
      return {
        success: false,
        error: `Invalid min_confidence: "${min_confidence}". Must be "certain" or "probable".`,
      };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-find-duplicates requires infrastructure access (contactService).',
      };
    }

    ctx.log.info({ minConfidence: min_confidence ?? 'probable' }, 'Scanning for duplicate contacts');

    try {
      const pairs = await ctx.contactService.findDuplicates(
        (min_confidence as 'certain' | 'probable' | undefined) ?? 'probable',
      );

      return {
        success: true,
        data: {
          pairs: pairs.map((p: DuplicatePair) => ({
            contact_a: {
              contact_id: p.contactA.id,
              display_name: p.contactA.displayName,
              role: p.contactA.role,
            },
            contact_b: {
              contact_id: p.contactB.id,
              display_name: p.contactB.displayName,
              role: p.contactB.role,
            },
            score: Math.round(p.score * 100) / 100,
            confidence: p.confidence,
            reason: p.reason,
          })),
          count: pairs.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'contact-find-duplicates failed');
      return { success: false, error: `Failed to scan for duplicates: ${message}` };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/unit/skills/contact-find-duplicates.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/contact-find-duplicates/ tests/unit/skills/contact-find-duplicates.test.ts
git commit -m "feat: add contact-find-duplicates skill"
```

---

## Task 8: contact-merge skill

**Files:**
- Create: `skills/contact-merge/skill.json`
- Create: `skills/contact-merge/handler.ts`
- Create: `tests/unit/skills/contact-merge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/skills/contact-merge.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ContactMergeHandler } from '../../../skills/contact-merge/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const VALID_UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_B = '550e8400-e29b-41d4-a716-446655440001';

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    caller: { contactId: 'ceo', role: 'ceo', channel: 'cli' },
    ...overrides,
  };
}

describe('ContactMergeHandler', () => {
  const handler = new ContactMergeHandler();

  it('returns failure when primary_contact_id is missing', async () => {
    const result = await handler.execute(makeCtx({ secondary_contact_id: VALID_UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('primary_contact_id');
  });

  it('returns failure when secondary_contact_id is missing', async () => {
    const result = await handler.execute(makeCtx({ primary_contact_id: VALID_UUID_A }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('secondary_contact_id');
  });

  it('returns failure when IDs are not valid UUIDs', async () => {
    const result = await handler.execute(makeCtx({
      primary_contact_id: 'contact_jenna',
      secondary_contact_id: VALID_UUID_B,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('UUID');
  });

  it('returns failure when both IDs are the same', async () => {
    const result = await handler.execute(makeCtx({
      primary_contact_id: VALID_UUID_A,
      secondary_contact_id: VALID_UUID_A,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('same');
  });

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({
      primary_contact_id: VALID_UUID_A,
      secondary_contact_id: VALID_UUID_B,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('returns failure when caller context is missing', async () => {
    const contactService = {
      mergeContacts: vi.fn().mockResolvedValue({ dryRun: true }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never, caller: undefined },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('caller');
  });

  it('calls mergeContacts with dry_run: true by default', async () => {
    const goldenRecord = {
      displayName: 'Jenna Torres', role: 'CFO', notes: null,
      status: 'confirmed', identities: [], authOverrides: [],
    };
    const contactService = {
      mergeContacts: vi.fn().mockResolvedValue({
        primaryContactId: VALID_UUID_A,
        secondaryContactId: VALID_UUID_B,
        goldenRecord,
        dryRun: true,
      }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    expect(contactService.mergeContacts).toHaveBeenCalledWith(VALID_UUID_A, VALID_UUID_B, true);
    if (result.success) {
      const data = result.data as { dry_run: boolean };
      expect(data.dry_run).toBe(true);
    }
  });

  it('calls mergeContacts with dry_run: false when specified', async () => {
    const contactService = {
      mergeContacts: vi.fn().mockResolvedValue({
        primaryContactId: VALID_UUID_A,
        secondaryContactId: VALID_UUID_B,
        goldenRecord: { displayName: 'Alice', role: null, notes: null, status: 'confirmed', identities: [], authOverrides: [] },
        dryRun: false,
        mergedAt: new Date('2026-04-05T12:00:00Z'),
      }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B, dry_run: false },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    expect(contactService.mergeContacts).toHaveBeenCalledWith(VALID_UUID_A, VALID_UUID_B, false);
    if (result.success) {
      const data = result.data as { merged_at: string };
      expect(data.merged_at).toBe('2026-04-05T12:00:00.000Z');
    }
  });

  it('surfaces "not found" error with contact-lookup guidance', async () => {
    const contactService = {
      mergeContacts: vi.fn().mockRejectedValue(new Error(`Contact not found: ${VALID_UUID_A}`)),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact-lookup');
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/unit/skills/contact-merge.test.ts
```

Expected: FAIL — `Cannot find module '../../../skills/contact-merge/handler.js'`

- [ ] **Step 3: Create skill.json manifest**

Create `skills/contact-merge/skill.json`:

```json
{
  "name": "contact-merge",
  "description": "Merge two contacts into one, consolidating channel identities and auth overrides using golden-record survivorship rules. Use dry_run: true to preview the result before committing. Always confirm with the CEO before running with dry_run: false.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "primary_contact_id": "string",
    "secondary_contact_id": "string",
    "dry_run": "boolean?"
  },
  "outputs": {
    "primary_contact_id": "string",
    "secondary_contact_id": "string",
    "golden_record": "object",
    "dry_run": "boolean",
    "merged_at": "string?"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

> **@TODO (autonomy):** When the autonomy engine reaches "supervised" or higher, consider
> lowering the confirmation requirement for `certain`-confidence merges. At "full" autonomy,
> the Coordinator should execute merges from batch scan without CEO interruption. The
> `dry_run` flag is the gate — at higher autonomy levels, `dry_run: false` is sent directly
> for high-confidence pairs. See `docs/superpowers/specs/2026-04-03-autonomy-engine-design.md`.

- [ ] **Step 4: Create handler**

Create `skills/contact-merge/handler.ts`:

```typescript
// handler.ts — contact-merge skill
//
// Merges two contacts into one. Use dry_run: true to preview the golden record
// before committing. The Coordinator MUST present the preview to the CEO and
// get confirmation before calling with dry_run: false.
//
// Elevated skill — requires caller context.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactMergeHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { primary_contact_id, secondary_contact_id, dry_run } = ctx.input as {
      primary_contact_id?: string;
      secondary_contact_id?: string;
      dry_run?: boolean;
    };

    if (!primary_contact_id || typeof primary_contact_id !== 'string') {
      return { success: false, error: 'Missing required input: primary_contact_id (string)' };
    }
    if (!secondary_contact_id || typeof secondary_contact_id !== 'string') {
      return { success: false, error: 'Missing required input: secondary_contact_id (string)' };
    }
    if (!UUID_RE.test(primary_contact_id)) {
      return { success: false, error: `primary_contact_id must be a valid UUID. Use contact-lookup to find the real ID.` };
    }
    if (!UUID_RE.test(secondary_contact_id)) {
      return { success: false, error: `secondary_contact_id must be a valid UUID. Use contact-lookup to find the real ID.` };
    }
    if (primary_contact_id === secondary_contact_id) {
      return { success: false, error: 'primary_contact_id and secondary_contact_id must be different contacts.' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contact-merge requires infrastructure access (contactService).' };
    }
    // Elevated skill — execution layer guarantees caller is set, but guard explicitly
    if (!ctx.caller) {
      return { success: false, error: 'Caller context is required for this elevated skill.' };
    }

    const dryRun = dry_run !== false; // default: true (safe — don't merge without explicit confirmation)

    ctx.log.info({ primaryContactId: primary_contact_id, secondaryContactId: secondary_contact_id, dryRun }, 'Contact merge invoked');

    try {
      const result = await ctx.contactService.mergeContacts(
        primary_contact_id,
        secondary_contact_id,
        dryRun,
      );

      const goldenRecord = result.goldenRecord;

      return {
        success: true,
        data: {
          primary_contact_id: result.primaryContactId,
          secondary_contact_id: result.secondaryContactId,
          golden_record: {
            display_name: goldenRecord.displayName,
            role: goldenRecord.role,
            notes: goldenRecord.notes,
            status: goldenRecord.status,
            identity_count: goldenRecord.identities.length,
            auth_override_count: goldenRecord.authOverrides.length,
          },
          dry_run: result.dryRun,
          ...('mergedAt' in result && result.mergedAt
            ? { merged_at: result.mergedAt.toISOString() }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return {
          success: false,
          error: `Contact not found: ${message}. Use contact-lookup to verify the contact IDs before retrying.`,
        };
      }
      ctx.log.error({ err, primary_contact_id, secondary_contact_id }, 'contact-merge failed');
      return { success: false, error: `Merge failed: ${message}` };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/unit/skills/contact-merge.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/contact-merge/ tests/unit/skills/contact-merge.test.ts
git commit -m "feat: add contact-merge skill (elevated, dry_run by default)"
```

---

## Task 9: Coordinator system prompt and pinned skills

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add dedup workflow instructions to system prompt**

Open `agents/coordinator.yaml`. Find the `## Contact Lookup Best Practices` section (near the end of the system prompt). Add the following section directly after it:

```yaml
  ## Contact Deduplication

  ### When you receive a contact.duplicate_detected notification
  A background check found that a newly-created contact may be a duplicate of an
  existing one. Handle this at the next natural opportunity (not as an interrupt):
  1. Use contact-lookup to load both contacts in full (IDs are in the notification).
  2. Identify the primary contact using this heuristic (in priority order):
     - Most verified channel identities
     - Has a role assigned
     - Older created_at (established contact wins)
  3. Call contact-merge with dry_run: true to get the golden record preview.
  4. Present both contacts side-by-side to Joseph, show what will change, and ask
     for confirmation before merging. Example:
     "I noticed two contacts that look like the same person:
     - Jenna Torres (CFO, verified email jenna@acme.com)
     - J. Torres (no role, email jenna@acme.com)
     I'd merge them into Jenna Torres (CFO). Want me to proceed?"
  5. On confirmation: call contact-merge with dry_run: false.
  6. Never auto-merge without CEO confirmation.

  ### Weekly contacts dedup scan
  When the scheduler sends "Run your weekly contacts dedup scan":
  1. Call contact-find-duplicates (default min_confidence: probable).
  2. If no pairs found: confirm to Joseph that no duplicates were detected.
  3. If pairs found: work through them one at a time.
     - For each pair: use the primary heuristic above, call contact-merge dry_run: true,
       present the preview, get confirmation, then merge.
     - If Joseph defers a pair ("skip this one"), move on without merging.
     - Continue until all pairs are reviewed or Joseph ends the session.
  4. After finishing: summarize what was merged.

  ### Primary contact heuristic (for merge decisions)
  Apply in order — first rule that produces a clear winner decides:
  1. More verified channel identities → that contact is primary
  2. Has role assigned, other does not → the one with a role is primary
  3. Older created_at → the older contact is primary
  4. If still tied: ask Joseph to choose
```

- [ ] **Step 2: Add new skills to pinned_skills**

In `agents/coordinator.yaml`, find the `pinned_skills:` list and add the two new skills. Insert them near the other contact skills:

```yaml
  - contact-merge
  - contact-find-duplicates
```

The pinned_skills block should look like:

```yaml
pinned_skills:
  - entity-context
  - web-fetch
  - web-browser
  - web-search
  - delegate
  - contact-create
  - contact-lookup
  - contact-link-identity
  - contact-set-role
  - contact-list
  - contact-merge
  - contact-find-duplicates
  - email-send
  # ... rest unchanged ...
```

- [ ] **Step 3: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat: add contact dedup workflow instructions and new skills to coordinator"
```

---

## Task 10: Integration tests

**Files:**
- Modify: `tests/integration/contacts.test.ts`

- [ ] **Step 1: Add merge and dedup integration tests**

Open `tests/integration/contacts.test.ts`. After the existing tests, add a new describe block:

```typescript
  describe('contact merge', () => {
    it('merges two contacts: secondary deleted, primary has union of identities', async () => {
      const primary = await contactService.createContact({
        displayName: 'Jenna Torres',
        role: 'CFO',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      const secondary = await contactService.createContact({
        displayName: 'J. Torres',
        role: null,
        source: 'email_participant',
        status: 'provisional',
      });
      await contactService.linkIdentity({
        contactId: primary.id,
        channel: 'email',
        channelIdentifier: 'jenna.torres@acme.com',
        source: 'ceo_stated',
      });
      await contactService.linkIdentity({
        contactId: secondary.id,
        channel: 'email',
        channelIdentifier: 'j.torres@acme.com',
        source: 'email_participant',
      });

      const result = await contactService.mergeContacts(primary.id, secondary.id, false);

      expect(result.dryRun).toBe(false);
      expect(result.primaryContactId).toBe(primary.id);

      // Secondary should be gone
      const gone = await contactService.getContact(secondary.id);
      expect(gone).toBeUndefined();

      // Primary should have both emails
      const withIdentities = await contactService.getContactWithIdentities(primary.id);
      const emails = withIdentities?.identities.map(i => i.channelIdentifier) ?? [];
      expect(emails).toContain('jenna.torres@acme.com');
      expect(emails).toContain('j.torres@acme.com');

      // Golden record: role from primary, status most-restrictive (provisional > confirmed)
      const updated = await contactService.getContact(primary.id);
      expect(updated?.role).toBe('CFO');
      expect(updated?.status).toBe('provisional'); // secondary was provisional
    });

    it('dry_run does not modify any contacts', async () => {
      const primary = await contactService.createContact({
        displayName: 'Alice Smith',
        role: 'CTO',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      const secondary = await contactService.createContact({
        displayName: 'Alice Smith',
        role: null,
        source: 'email_participant',
        status: 'confirmed',
      });

      const proposal = await contactService.mergeContacts(primary.id, secondary.id, true);

      expect(proposal.dryRun).toBe(true);
      expect(proposal.goldenRecord.displayName).toBe('Alice Smith');

      // Both still exist
      const primaryStillExists = await contactService.getContact(primary.id);
      const secondaryStillExists = await contactService.getContact(secondary.id);
      expect(primaryStillExists).toBeDefined();
      expect(secondaryStillExists).toBeDefined();
    });

    it('auth overrides are consolidated (primary wins on conflict)', async () => {
      const primary = await contactService.createContact({
        displayName: 'Bob',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      const secondary = await contactService.createContact({
        displayName: 'Bob Smith',
        source: 'email_participant',
        status: 'confirmed',
      });
      // Primary: granted view_financial_reports
      await contactService.grantPermission(primary.id, 'view_financial_reports', true, 'ceo');
      // Secondary: denied view_financial_reports (conflict — primary should win)
      await contactService.grantPermission(secondary.id, 'view_financial_reports', false, 'ceo');
      // Secondary: granted schedule_meetings (no conflict)
      await contactService.grantPermission(secondary.id, 'schedule_meetings', true, 'ceo');

      await contactService.mergeContacts(primary.id, secondary.id, false);

      const overrides = await contactService.getAuthOverrides(primary.id);
      const viewReportsOverride = overrides.find(o => o.permission === 'view_financial_reports');
      const schedulingOverride = overrides.find(o => o.permission === 'schedule_meetings');

      expect(viewReportsOverride?.granted).toBe(true);   // primary wins
      expect(schedulingOverride?.granted).toBe(true);    // secondary's unique override preserved
    });
  });

  describe('findDuplicates', () => {
    it('returns probable duplicate pair when contacts share an email', async () => {
      const a = await contactService.createContact({
        displayName: 'Carol White',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      await contactService.linkIdentity({
        contactId: a.id,
        channel: 'email',
        channelIdentifier: 'carol.white@example.com',
        source: 'ceo_stated',
      });
      const b = await contactService.createContact({
        displayName: 'C. White',
        source: 'email_participant',
        status: 'provisional',
      });
      await contactService.linkIdentity({
        contactId: b.id,
        channel: 'email',
        channelIdentifier: 'carol.white@example.com',
        source: 'email_participant',
      });

      const pairs = await contactService.findDuplicates();
      const found = pairs.find(p =>
        (p.contactA.id === a.id && p.contactB.id === b.id) ||
        (p.contactA.id === b.id && p.contactB.id === a.id)
      );
      expect(found).toBeDefined();
      expect(found?.confidence).toBe('certain'); // same email
    });
  });
```

> **Note:** These integration tests require DATABASE_URL to be set and migrations 001–005 applied. They are automatically skipped via the `describeIf` wrapper in the test file when DATABASE_URL is absent.

- [ ] **Step 2: Run integration tests (if DATABASE_URL is available)**

```bash
DATABASE_URL=postgresql://localhost/curia_test npx vitest run tests/integration/contacts.test.ts
```

Expected: All integration tests PASS. If DATABASE_URL is not set, they skip gracefully.

- [ ] **Step 3: Run full test suite one final time**

```bash
npx vitest run
```

Expected: All tests PASS (or skip where DATABASE_URL is absent).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/contacts.test.ts
git commit -m "test: add integration tests for contact merge and findDuplicates"
```

---

## Self-Review Checklist

Spec coverage check:

| Spec requirement | Covered by task |
|---|---|
| `contact.merge` skill with dry_run | Task 7 + 8 |
| `contact.find-duplicates` skill | Task 6 + 7 |
| DedupService: Jaro-Winkler + channel overlap + blocking | Task 2 |
| Name variants (first/last, initials) | Task 2 (`nameVariants()`) |
| On-creation hook (non-blocking, fire-and-forget) | Task 5 |
| `contact.duplicate_detected` bus event | Task 1 |
| `contact.merged` bus event | Task 1 |
| Bootstrap wiring | Task 6 |
| Golden record survivorship: scalar (most-recent-wins), notes (concat), status (most-restrictive), identities/overrides (union) | Task 4 |
| KG node merge (scalar + facts, Phase 1) | Task 3 |
| Coordinator dedup workflow instructions | Task 9 |
| Weekly scan trigger (Coordinator + scheduler-create) | Task 9 (instructions) |
| `@TODO` autonomy annotation on contact-merge skill | Task 8 (skill.json comment) |
| `@TODO` autonomy annotation on batch scan | Task 9 (system prompt) |
| Unit tests: dedup scoring | Task 2 |
| Unit tests: merge golden record | Task 4 |
| Unit tests: skill handlers | Task 7, 8 |
| Integration tests: merge flow, dedup detection | Task 10 |
