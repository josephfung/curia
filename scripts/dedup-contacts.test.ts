// scripts/dedup-contacts.test.ts
//
// Tests for the contact deduplication maintenance script.
//
// Unit tests run without a database (mock pool). Integration tests are
// guarded by `describeIf(DATABASE_URL)` and require a real Postgres connection.
//
// Behaviors under test:
//   1. Structural pair → auto-merges (ContactService.mergeContacts called)
//   2. Fuzzy pair → task created (no merge)
//   3. Principal-involving pair → task created (no merge), even if structural
//   4. Excluded pair → skipped (no merge, no task)
//   5. Dry-run mode → no writes of any kind (no merges, no tasks)
//   6. writeExclusion helper → writes the correct KG fact
//   7. hasExclusion helper → correctly reads exclusion facts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Contact, ChannelIdentity } from '../src/contacts/types.js';
import {
  runDedup,
  writeExclusion,
  hasExclusion,
  type DedupRunOptions,
} from './dedup-contacts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContact(
  overrides: Partial<Contact> & { id: string; displayName: string },
): Contact {
  return {
    kgNodeId: null,
    role: null,
    systemRole: null,
    status: 'confirmed',
    contactConfidence: 0.8,
    trustLevel: null,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    notes: null,
    preferredName: null,
    title: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    timezone: null,
    locale: null,
    location: null,
    pronouns: null,
    linkedinUrl: null,
    bio: null,
    birthday: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeIdentity(
  contactId: string,
  channel: string,
  channelIdentifier: string,
): ChannelIdentity {
  return {
    id: `${contactId}-${channel}`,
    contactId,
    channel,
    channelIdentifier,
    label: null,
    verified: true,
    verifiedAt: new Date('2026-01-01'),
    status: 'active',
    source: 'email_participant',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Unit tests (mock dependencies, no DB)
// ---------------------------------------------------------------------------

describe('runDedup — unit', () => {
  let mergeMock: ReturnType<typeof vi.fn>;
  let createTaskMock: ReturnType<typeof vi.fn>;
  let getFactsMock: ReturnType<typeof vi.fn>;
  let opts: DedupRunOptions;

  beforeEach(() => {
    mergeMock = vi.fn().mockResolvedValue({
      primaryContactId: 'c1',
      secondaryContactId: 'c2',
      goldenRecord: {},
      dryRun: false,
      mergedAt: new Date(),
    });
    createTaskMock = vi.fn().mockResolvedValue({ id: 'task-1', title: 'test' });
    getFactsMock = vi.fn().mockResolvedValue([]);

    opts = {
      dryRun: false,
      mergeContacts: mergeMock,
      createTask: createTaskMock,
      // storeFact is not part of DedupRunOptions (F6)
      getFacts: getFactsMock,
    };
  });

  // -------------------------------------------------------------------------
  // Test 1: structural pair → auto-merge
  // -------------------------------------------------------------------------

  it('auto-merges structural pairs (shared channel identity)', async () => {
    // Two contacts sharing the same email — structural proof
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Alice Smith' }),
      makeContact({ id: 'c2', displayName: 'A. Smith' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>([
      ['c1', [makeIdentity('c1', 'email', 'alice@example.com')]],
      ['c2', [makeIdentity('c2', 'email', 'alice@example.com')]],
    ]);

    const result = await runDedup(contacts, identityMap, opts);

    expect(mergeMock).toHaveBeenCalledOnce();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(result.mergedCount).toBe(1);
    expect(result.taskCount).toBe(0);
  });

  it('auto-merges structural pairs (same kg_node_id)', async () => {
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Bob Jones', kgNodeId: 'kg-xyz' }),
      makeContact({ id: 'c2', displayName: 'Bobby Jones', kgNodeId: 'kg-xyz' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    expect(mergeMock).toHaveBeenCalledOnce();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(result.mergedCount).toBe(1);
  });

  it('auto-merges structural pairs (exact normalized name match)', async () => {
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Carol White' }),
      makeContact({ id: 'c2', displayName: 'carol white' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    expect(mergeMock).toHaveBeenCalledOnce();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(result.mergedCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: fuzzy pair → task (no merge)
  // -------------------------------------------------------------------------

  it('creates a task for fuzzy pairs and does NOT merge them', async () => {
    // Similar but not identical names, no shared identities.
    // Must be names that share no exact normalized variant — otherwise classifyPair
    // returns 'structural' (exact initial variant match).
    //
    // "Mikael Sorensen" variants: ["mikael sorensen", "sorensen mikael", "m sorensen"]
    // "Michael Sorenson" variants: ["michael sorenson", "sorenson michael", "m sorenson"]
    // No shared exact variant ("m sorensen" ≠ "m sorenson", etc.).
    // JW("mikael sorensen", "michael sorenson") is high (~0.88) → above 0.7 threshold.
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Mikael Sorensen' }),
      makeContact({ id: 'c2', displayName: 'Michael Sorenson' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    // Should create a task, not merge
    expect(mergeMock).not.toHaveBeenCalled();
    expect(createTaskMock).toHaveBeenCalledOnce();
    expect(result.mergedCount).toBe(0);
    expect(result.taskCount).toBe(1);

    // Task description must include both contact IDs for the contacts agent to act on
    const taskArgs = createTaskMock.mock.calls[0]![0] as Record<string, unknown>;
    const description = taskArgs.description as string;
    expect(description).toContain('c1');
    expect(description).toContain('c2');
  });

  // -------------------------------------------------------------------------
  // Test 3: principal-involving pair → task (no merge), even if structural
  // -------------------------------------------------------------------------

  it('creates a task for a structural pair involving the principal (no auto-merge)', async () => {
    // Principal contact with a structural match — must never auto-merge
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Diana Prince', systemRole: 'principal' }),
      makeContact({ id: 'c2', displayName: 'Diana Prince' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>([
      ['c1', [makeIdentity('c1', 'email', 'diana@example.com')]],
      ['c2', [makeIdentity('c2', 'email', 'diana@example.com')]],
    ]);

    const result = await runDedup(contacts, identityMap, opts);

    // Must NOT auto-merge even though it's structural proof
    expect(mergeMock).not.toHaveBeenCalled();
    expect(createTaskMock).toHaveBeenCalledOnce();
    expect(result.mergedCount).toBe(0);
    expect(result.taskCount).toBe(1);
    expect(result.principalSkippedCount).toBe(1);
  });

  it('creates a task when the principal is contactB (the secondary)', async () => {
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Eve Principal' }),
      makeContact({ id: 'c2', displayName: 'Eve Principal', systemRole: 'principal' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    // Exact name match is structural, but principal is involved → task
    expect(mergeMock).not.toHaveBeenCalled();
    expect(result.principalSkippedCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: excluded pair → skipped
  // -------------------------------------------------------------------------

  it('skips pairs that have a dedup_exclusion fact', async () => {
    // getFactsMock returns an exclusion fact for c1's KG node naming c2
    getFactsMock.mockImplementation(async (kgNodeId: string) => {
      if (kgNodeId === 'kg-c1') {
        return [{
          id: 'fn-excl',
          type: 'fact',
          label: 'dedup_exclusion: c2',
          properties: { attribute: 'dedup_exclusion', value: 'c2' },
          aliases: [],
          embedding: null,
          confidence: 1.0,
          sensitivity: 'internal',
          decayClass: 'permanent',
          source: 'contacts-dedup',
          temporal: { createdAt: new Date(), lastConfirmedAt: new Date() },
        }];
      }
      return [];
    });

    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Frank Lee', kgNodeId: 'kg-c1' }),
      makeContact({ id: 'c2', displayName: 'frank lee' }), // exact normalized match
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    expect(mergeMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(result.skippedExcludedCount).toBe(1);
  });

  it('skips pairs where exclusion is recorded on contactB side', async () => {
    getFactsMock.mockImplementation(async (kgNodeId: string) => {
      if (kgNodeId === 'kg-c2') {
        return [{
          id: 'fn-excl',
          type: 'fact',
          label: 'dedup_exclusion: c1',
          properties: { attribute: 'dedup_exclusion', value: 'c1' },
          aliases: [],
          embedding: null,
          confidence: 1.0,
          sensitivity: 'internal',
          decayClass: 'permanent',
          source: 'contacts-dedup',
          temporal: { createdAt: new Date(), lastConfirmedAt: new Date() },
        }];
      }
      return [];
    });

    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Grace Park' }),
      makeContact({ id: 'c2', displayName: 'grace park', kgNodeId: 'kg-c2' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    expect(mergeMock).not.toHaveBeenCalled();
    expect(result.skippedExcludedCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 5: dry-run mode → no writes
  // -------------------------------------------------------------------------

  it('in dry-run mode, makes no merges and no task creation writes', async () => {
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Harry Scott' }),
      makeContact({ id: 'c2', displayName: 'harry scott' }), // structural exact match
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const dryRunOpts: DedupRunOptions = { ...opts, dryRun: true };
    const result = await runDedup(contacts, identityMap, dryRunOpts);

    // No writes (storeFact is no longer part of DedupRunOptions — F6)
    expect(mergeMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();

    // But report counts are accurate (reflecting what WOULD have been done)
    expect(result.wouldMergeCount).toBeGreaterThan(0);
    expect(result.dryRun).toBe(true);
  });

  it('in dry-run mode, result includes errorCount so the caller can surface it in the summary log', async () => {
    // F5: The DedupRunResult always has errorCount; the CLI summary must include it.
    // We verify here that errorCount is present on the result (the CLI log inclusion
    // is verified by reading the dedup-contacts.ts source — it's a documentation check
    // rather than a runtime assertion).
    //
    // Trigger an error by making getFacts throw on the only structural pair.
    getFactsMock.mockRejectedValue(new Error('DB error'));

    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Dry Run Test', kgNodeId: 'kg-c1' }),
      makeContact({ id: 'c2', displayName: 'dry run test', kgNodeId: 'kg-c2' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const dryRunOpts: DedupRunOptions = { ...opts, dryRun: true };
    const result = await runDedup(contacts, identityMap, dryRunOpts);

    // The error must be recorded even in dry-run mode
    expect(result.errorCount).toBe(1);
    // No merge or task creation (it was an error, not a successful classification)
    expect(result.wouldMergeCount).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it('in dry-run mode, fuzzy pairs are reported but not acted on', async () => {
    // "Mikael Sorensen" / "Michael Sorenson" — fuzzy pair (no shared exact variants, high JW).
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Mikael Sorensen' }),
      makeContact({ id: 'c2', displayName: 'Michael Sorenson' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const dryRunOpts: DedupRunOptions = { ...opts, dryRun: true };
    const result = await runDedup(contacts, identityMap, dryRunOpts);

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional: transient merge failure does not abort the whole run
  // -------------------------------------------------------------------------

  it('continues after a merge failure and reports the error count', async () => {
    mergeMock.mockRejectedValue(new Error('DB error'));

    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Jake Park' }),
      makeContact({ id: 'c2', displayName: 'jake park' }), // structural
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    expect(result.errorCount).toBe(1);
    expect(result.mergedCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // F2: merged-away contacts must be skipped in subsequent pairs
  // -------------------------------------------------------------------------

  it('merges transitively after a prior merge and skips the merged-away contact (M4 + F2)', async () => {
    // c1≡c2 (shared email A) and c2≡c3 (shared email B); c2 bridges all three as one entity.
    // Loop: (c1,c2) merges → c2 is merged away AND c1 absorbs c2's identities, incl. email B (M4).
    // Then (c1,c3) now shares email B → transitive structural merge.
    // (c2,c3) is skipped because c2 is merged away (F2).
    // Net: all three collapse into c1 via two merges — (c1,c2) then (c1,c3).
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Lena Kovacs Alpha' }),
      makeContact({ id: 'c2', displayName: 'Lena Kovacs' }),
      makeContact({ id: 'c3', displayName: 'Lena Kovacs Beta' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>([
      // c1 and c2 share an email → structural pair
      ['c1', [makeIdentity('c1', 'email', 'lena@example.com')]],
      ['c2', [
        makeIdentity('c2', 'email', 'lena@example.com'), // shared with c1
        makeIdentity('c2', 'email', 'lena@other.com'),   // shared with c3
      ]],
      // c2 and c3 share a second email → structural pair
      ['c3', [makeIdentity('c3', 'email', 'lena@other.com')]],
    ]);

    const result = await runDedup(contacts, identityMap, opts);

    // Two merges: (c1,c2) then the transitive (c1,c3). (c2,c3) is skipped because c2 is
    // merged away, so c2 is never used as a merge argument again.
    expect(mergeMock).toHaveBeenCalledTimes(2);
    expect(mergeMock).toHaveBeenNthCalledWith(1, 'c1', 'c2');
    expect(mergeMock).toHaveBeenNthCalledWith(2, 'c1', 'c3');
    expect(result.errorCount).toBe(0);
    expect(result.mergedCount).toBe(2);
  });

  it('dry-run marks would-be-merged contacts away so counts are not inflated (M3)', async () => {
    // c1≡c2 (shared email A), c2≡c3 (shared email B); names are dissimilar so the only
    // matches are the structural identity ones. In dry-run nothing is written and
    // identities are not reattached, so (c1,c3) is not transitive here — but (c2,c3)
    // must still be skipped because c2 is marked merged-away. Without M3 it would be
    // double-counted as a second would-merge.
    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Alpha One' }),
      makeContact({ id: 'c2', displayName: 'Beta Two' }),
      makeContact({ id: 'c3', displayName: 'Gamma Three' }),
    ];
    const identityMap = new Map<string, ChannelIdentity[]>([
      ['c1', [makeIdentity('c1', 'email', 'one@example.com')]],
      ['c2', [
        makeIdentity('c2', 'email', 'one@example.com'),
        makeIdentity('c2', 'email', 'two@example.com'),
      ]],
      ['c3', [makeIdentity('c3', 'email', 'two@example.com')]],
    ]);

    const result = await runDedup(contacts, identityMap, { ...opts, dryRun: true });

    // Only (c1,c2) counted; (c2,c3) skipped because c2 is marked merged-away. No real merges.
    expect(result.wouldMergeCount).toBe(1);
    expect(mergeMock).not.toHaveBeenCalled();
    expect(result.mergedCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // F4: errors during exclusion check / classify must fail closed
  // -------------------------------------------------------------------------

  it('skips pair and increments errorCount when getFacts throws, and continues to the next pair', async () => {
    // c1 and c2 share an exact name — would normally be structural.
    // But getFacts throws a DB error when checking exclusions for c1/c2.
    // F4: must fail closed (no merge, no task), increment errorCount, and continue.
    // c3 and c4 also share an exact name — should still be processed (no error on that pair).
    getFactsMock.mockImplementation(async (kgNodeId: string) => {
      // c1 has a kg_node_id; trigger the error only on that node
      if (kgNodeId === 'kg-c1') {
        throw new Error('DB connection error');
      }
      return [];
    });

    const contacts: Contact[] = [
      makeContact({ id: 'c1', displayName: 'Marco Polo', kgNodeId: 'kg-c1' }),
      makeContact({ id: 'c2', displayName: 'marco polo' }), // structural — exact name; getFacts throws
      makeContact({ id: 'c3', displayName: 'Anna Pavlova' }),
      makeContact({ id: 'c4', displayName: 'anna pavlova' }), // structural — exact name; no error
    ];
    const identityMap = new Map<string, ChannelIdentity[]>();

    const result = await runDedup(contacts, identityMap, opts);

    // The c1/c2 pair errored — must not have merged and must have incremented errorCount
    // The c3/c4 pair had no error — must have merged
    expect(result.errorCount).toBe(1);
    // At least the c3/c4 pair merged (the sweep continued after c1/c2 error)
    expect(result.mergedCount).toBeGreaterThanOrEqual(1);

    // Verify the c1/c2 pair specifically: mergeContacts must never have been called
    // with c1 or c2 as arguments (fail closed — no merge on the errored pair)
    const mergeCallArgs = mergeMock.mock.calls.map((call) => [call[0] as string, call[1] as string]);
    const c1c2WasMerged = mergeCallArgs.some(
      ([primary, secondary]) =>
        (primary === 'c1' || primary === 'c2') &&
        (secondary === 'c1' || secondary === 'c2'),
    );
    expect(c1c2WasMerged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeExclusion helper tests
// ---------------------------------------------------------------------------

describe('writeExclusion', () => {
  it('calls storeFact with the correct attribute and value for a dedup_exclusion', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      // contactAId removed from WriteExclusionOptions (F9) — kgNodeId is already A's node
      contactBId: 'c2',
      kgNodeId: 'kg-c1',
      storeFact: storeFactMock,
    });

    expect(storeFactMock).toHaveBeenCalledOnce();
    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.entityNodeId).toBe('kg-c1');
    expect((args.properties as Record<string, unknown>).attribute).toBe('dedup_exclusion');
    expect((args.properties as Record<string, unknown>).value).toBe('c2');
    // Exclusion facts must be permanent so they survive decay
    expect(args.decayClass).toBe('permanent');
  });

  it('writes the exclusion label in the expected format', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      contactBId: 'c2',
      kgNodeId: 'kg-c1',
      storeFact: storeFactMock,
    });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    // Label must follow the "field: value" format used by all KG facts
    expect(args.label).toBe('dedup_exclusion: c2');
  });
});

// ---------------------------------------------------------------------------
// hasExclusion helper tests
// ---------------------------------------------------------------------------

describe('hasExclusion', () => {
  it('returns true when the KG node has a dedup_exclusion fact for the other contact', async () => {
    const exclusionFact = {
      id: 'fn-1',
      type: 'fact' as const,
      label: 'dedup_exclusion: c2',
      properties: { attribute: 'dedup_exclusion', value: 'c2' },
      aliases: [],
      embedding: null,
      confidence: 1.0,
      sensitivity: 'internal' as const,
      decayClass: 'permanent' as const,
      source: 'contacts-dedup',
      temporal: { createdAt: new Date(), lastConfirmedAt: new Date() },
    };

    const getFactsMock = vi.fn().mockResolvedValue([exclusionFact]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(true);
  });

  it('returns false when no dedup_exclusion fact exists', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(false);
  });

  it('returns false when neither contact has a kg_node_id', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: null,
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    // No KG nodes → no exclusion facts possible
    expect(result).toBe(false);
    // Should not even call getFacts since there's nothing to query
    expect(getFactsMock).not.toHaveBeenCalled();
  });

  it('checks both sides when both contacts have kg_node_ids', async () => {
    // Exclusion is on contactB's KG node naming contactA
    const getFactsMock = vi.fn().mockImplementation(async (kgNodeId: string) => {
      if (kgNodeId === 'kg-c2') {
        return [{
          id: 'fn-1',
          type: 'fact',
          label: 'dedup_exclusion: c1',
          properties: { attribute: 'dedup_exclusion', value: 'c1' },
          aliases: [],
          embedding: null,
          confidence: 1.0,
          sensitivity: 'internal',
          decayClass: 'permanent',
          source: 'contacts-dedup',
          temporal: { createdAt: new Date(), lastConfirmedAt: new Date() },
        }];
      }
      return [];
    });

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: 'kg-c2',
      getFacts: getFactsMock,
    });

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — guarded by DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('runDedup — integration', () => {
  // Integration tests exercising the full script against a real DB.
  // Uses explicit DELETE cleanup in afterAll per project convention.
  //
  // NOTE: These are intentionally minimal — they verify the script can
  // load and run against real tables. The full behavioral coverage is in the
  // unit tests above. See src/contacts/dedup-classifier.test.ts for classifier
  // coverage and tests/integration/contacts.test.ts for ContactService coverage.

  // TODO: Add integration tests that create real contacts, run the sweep,
  //       and verify DB state (merge applied, task created, exclusion respected).
});
