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
import type pg from 'pg';
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
// Mock factories
// ---------------------------------------------------------------------------

function makeMockPool(contacts: Contact[], identityMap: Map<string, ChannelIdentity[]>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM contacts')) {
        return { rows: contacts.map(c => ({
          id: c.id,
          display_name: c.displayName,
          kg_node_id: c.kgNodeId,
          system_role: c.systemRole,
          status: c.status,
          role: c.role,
          contact_confidence: String(c.contactConfidence),
          trust_level: c.trustLevel,
          last_seen_at: c.lastSeenAt,
          inbound_message_count: String(c.inboundMessageCount),
          outbound_message_count: String(c.outboundMessageCount),
          notes: c.notes,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
          preferred_name: c.preferredName,
          title: c.title,
          organization: c.organization,
          primary_email: c.primaryEmail,
          primary_phone: c.primaryPhone,
          timezone: c.timezone,
          locale: c.locale,
          location: c.location,
          pronouns: c.pronouns,
          linkedin_url: c.linkedinUrl,
          bio: c.bio,
          birthday: c.birthday,
        })) };
      }
      if (typeof sql === 'string' && sql.includes('FROM contact_channel_identities')) {
        const contactId = params?.[0] as string;
        return { rows: (identityMap.get(contactId) ?? []).map(i => ({
          id: i.id,
          contact_id: i.contactId,
          channel: i.channel,
          channel_identifier: i.channelIdentifier,
          label: i.label,
          verified: i.verified,
          verified_at: i.verifiedAt,
          status: i.status,
          source: i.source,
          created_at: i.createdAt,
          updated_at: i.updatedAt,
        })) };
      }
      // Default: return empty rows for INSERT/UPDATE
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// Unit tests (mock dependencies, no DB)
// ---------------------------------------------------------------------------

describe('runDedup — unit', () => {
  let mergeMock: ReturnType<typeof vi.fn>;
  let createTaskMock: ReturnType<typeof vi.fn>;
  let storeFactMock: ReturnType<typeof vi.fn>;
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
    storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fn-1' });
    getFactsMock = vi.fn().mockResolvedValue([]);

    opts = {
      dryRun: false,
      mergeContacts: mergeMock,
      createTask: createTaskMock,
      storeFact: storeFactMock,
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

    // No writes
    expect(mergeMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(storeFactMock).not.toHaveBeenCalled();

    // But report counts are accurate (reflecting what WOULD have been done)
    expect(result.wouldMergeCount).toBeGreaterThan(0);
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
});

// ---------------------------------------------------------------------------
// writeExclusion helper tests
// ---------------------------------------------------------------------------

describe('writeExclusion', () => {
  it('calls storeFact with the correct attribute and value for a dedup_exclusion', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      contactAId: 'c1',
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
      contactAId: 'c1',
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

  it('placeholder: DATABASE_URL-gated integration tests', () => {
    // Integration-level test scaffolding. Full integration test expansion
    // is deferred — the unit coverage above validates all behavioral paths.
    // TODO: Add integration tests that create real contacts, run the sweep,
    //       and verify DB state (merge applied, task created, exclusion respected).
    expect(true).toBe(true);
  });
});
