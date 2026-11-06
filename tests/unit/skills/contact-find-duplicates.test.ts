import { describe, it, expect, vi } from 'vitest';
import { ContactFindDuplicatesHandler } from '../../../skills/contacts/tools/contact-find-duplicates/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import type { ChannelIdentity, Contact, DuplicatePair } from '../../../src/contacts/types.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
import { canonicalPairKey, dedupPairTag } from '../../../src/contacts/dedup-pair-key.js';
import { DEFERRAL_COOLDOWN_DAYS } from '../../../skills/contacts/tools/contact-find-duplicates/handler.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// UUID-shaped IDs for description-parsing tests
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';

function makePair(
  aId: string, aName: string, aKgNodeId: string | null,
  bId: string, bName: string, bKgNodeId: string | null,
  score: number,
): DuplicatePair {
  return {
    contactA: { id: aId, kgNodeId: aKgNodeId, displayName: aName, role: null, identities: [] },
    contactB: { id: bId, kgNodeId: bKgNodeId, displayName: bName, role: null, identities: [] },
    score,
    confidence: score >= 0.9 ? 'certain' : 'probable',
    reason: `Similar name (${score.toFixed(2)})`,
  };
}

function makeContact(id: string, displayName: string, over: Partial<Contact> = {}): Contact {
  return {
    id, kgNodeId: null, displayName, role: null, notes: null, systemRole: null,
    tier: 'unknown', kind: 'person',
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as Contact;
}

function makeTaskRow(aId: string, bId: string, aName = 'A', bName = 'B'): Partial<TaskRow> {
  return {
    id: `task-${aId}-${bId}`,
    description: [
      `Possible duplicate contacts detected by the dedup skill scan.`,
      ``,
      `Contact A ID: ${aId}  (${aName})`,
      `Contact B ID: ${bId}  (${bName})`,
    ].join('\n'),
    tags: ['dedup', 'contacts'],
  };
}

interface TaskRepoStub {
  listTasks: (filters?: { statuses?: string[] }) => Promise<Partial<TaskRow>[]>;
  createTask: (p: unknown) => Promise<Partial<TaskRow>>;
  updateTask?: (...args: unknown[]) => Promise<unknown>;
  completeTask?: (...args: unknown[]) => Promise<unknown>;
  getTask?: (id: string) => Promise<Partial<TaskRow> | null>;
}

/** Contacts implied by the pairs: person/unknown unless a test passes its own list. */
function contactsFromPairs(pairs: DuplicatePair[]): Contact[] {
  const byId = new Map<string, Contact>();
  for (const p of pairs) {
    for (const side of [p.contactA, p.contactB]) {
      if (byId.has(side.id)) continue;
      byId.set(side.id, makeContact(side.id, side.displayName));
    }
  }
  return [...byId.values()];
}

function makeContext(
  input: Record<string, unknown>,
  overrides: {
    contactService?: {
      findDuplicates: () => Promise<DuplicatePair[]>;
      // Optional in the stub so the many tests that don't care about exclusions can
      // keep passing a bare { findDuplicates } literal; defaulted to empty below.
      listDedupExclusionPairKeys?: () => Promise<Set<string>>;
      listContacts?: () => Promise<Contact[]>;
      mergeContacts?: (...args: unknown[]) => Promise<unknown>;
    };
    taskRepo?: TaskRepoStub;
    /** Review tasks that closed within the cooldown (the scan's second listTasks call). */
    closedTasks?: Partial<TaskRow>[];
    /** Live autonomy score; omitted means no autonomy service (auto-merge off). */
    autonomyScore?: number;
  } = {},
): ToolContext {
  const cs = overrides.contactService;
  const contactService = cs
    ? {
        listDedupExclusionPairKeys: async () => new Set<string>(),
        listContacts: async () => contactsFromPairs(await cs.findDuplicates()),
        mergeContacts: async () => ({}),
        ...cs,
      }
    : undefined;
  const withDefaults = (t: Partial<TaskRow>): Partial<TaskRow> => ({
    createdAt: '2026-01-01T00:00:00.000Z', status: 'open', owner: 'curia', tags: [],
    blockedByTaskId: null, ...t,
  });
  const tr = overrides.taskRepo;
  const taskRepo = tr
    ? {
        updateTask: async () => ({}),
        completeTask: async () => ({}),
        getTask: async () => null,
        ...tr,
        listTasks: async (filters?: { statuses?: string[] }) =>
          filters?.statuses?.includes('done')
            ? (overrides.closedTasks ?? []).map(withDefaults)
            : (await tr.listTasks(filters)).map(withDefaults),
      }
    : undefined;
  return {
    toolName: 'contact-find-duplicates',
    toolVersion: '2.2.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: contactService as never,
    taskRepo: taskRepo as never,
    autonomyService: overrides.autonomyScore === undefined
      ? undefined
      : ({ getConfig: async () => ({ score: overrides.autonomyScore }) } as never),
  };
}

// Default stubs used in most tests
const emptyTaskRepo = {
  listTasks: async () => [],
  createTask: async () => ({ id: 'task-1' }),
};

describe('ContactFindDuplicatesHandler', () => {
  const handler = new ContactFindDuplicatesHandler();

  // ---------------------------------------------------------------------------
  // Service availability guards
  // ---------------------------------------------------------------------------

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeContext({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('returns failure when taskRepo is not available', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(makeContext({}, { contactService }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('taskRepo');
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  it('rejects min_score outside [0, 1]', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(
      makeContext({ min_score: 1.5 }, { contactService, taskRepo: emptyTaskRepo as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('min_score');
  });

  it('rejects non-integer max_tasks', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(
      makeContext({ max_tasks: 1.5 }, { contactService, taskRepo: emptyTaskRepo as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('max_tasks');
  });

  // ---------------------------------------------------------------------------
  // Numeric threshold filtering
  // ---------------------------------------------------------------------------

  it('filters out pairs below min_score using the default (0.93)', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Alice Smith', null, 0.92),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; total_scanned: number };
      expect(data.total_scanned).toBe(0);  // 0.92 < 0.93 default
      expect(data.filed).toBe(0);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('files a task for a pair at or above min_score', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Alice Smith', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; total_scanned: number };
      expect(data.total_scanned).toBe(1);
      expect(data.filed).toBe(1);
      expect(createTask).toHaveBeenCalledOnce();
    }
  });

  it('respects a custom min_score of 0.7', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Alice Smith', null, 0.75),
      makePair(UUID_A, 'Alice', null, UUID_C, 'Alicia', null, 0.65),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({ min_score: 0.7 }, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; total_scanned: number };
      // 0.75 passes, 0.65 is filtered by DedupService before we even see it
      // (but here our mock returns both — we filter to ≥ 0.7, so 0.75 passes, 0.65 doesn't)
      expect(data.total_scanned).toBe(1);  // 0.75 >= 0.7
      expect(data.filed).toBe(1);
    }
  });

  // ---------------------------------------------------------------------------
  // max_tasks cap
  // ---------------------------------------------------------------------------

  it('caps task filing at max_tasks and counts capped pairs', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Alice B', null, 0.95),
      makePair(UUID_A, 'Alice', null, UUID_C, 'Alice C', null, 0.94),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({ max_tasks: 1 }, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; capped: number };
      expect(data.filed).toBe(1);
      expect(data.capped).toBe(1);
      expect(createTask).toHaveBeenCalledOnce();
    }
  });

  it('files nothing and counts all as capped when max_tasks is 0', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({ max_tasks: 0 }, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; capped: number };
      expect(data.filed).toBe(0);
      expect(data.capped).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency: existing open task
  // ---------------------------------------------------------------------------

  it('skips pairs that already have an open dedup task', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = {
      listTasks: async () => [makeTaskRow(UUID_A, UUID_B)],
      createTask,
    };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_existing: number };
      expect(data.filed).toBe(0);
      expect(data.skipped_existing).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('handles existing task with reversed pair order (B, A) the same as (A, B)', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    // Existing task has B as Contact A and A as Contact B
    const taskRepo = {
      listTasks: async () => [makeTaskRow(UUID_B, UUID_A)],
      createTask,
    };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_existing: number };
      expect(data.skipped_existing).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('skips pairs when an open dedup task has a structured dedup-pair tag', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = {
      listTasks: async () => [{ id: 'task-tagged', tags: ['dedup', dedupPairTag(UUID_A, UUID_B)] }],
      createTask,
    };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_existing: number };
      expect(data.skipped_existing).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('does not file a second task for the same pair within one run', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.94),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; total_scanned: number };
      expect(data.total_scanned).toBe(2);
      expect(data.filed).toBe(1);
      expect(createTask).toHaveBeenCalledOnce();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency: recorded dedup exclusions (contact_dedup_exclusions, #1625)
  // ---------------------------------------------------------------------------

  it('skips pairs with a recorded exclusion, in either stored order', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', 'kg-node-b', 0.95),
    ];
    const contactService = {
      findDuplicates: async () => pairs,
      // The service returns canonical (ordered, lowercase) keys; the pair here is
      // presented A-then-B, so this also covers order independence.
      listDedupExclusionPairKeys: async () => new Set([`${UUID_A}:${UUID_B}`]),
    };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_excluded: number };
      expect(data.skipped_excluded).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('skips an excluded pair even when both contacts have no kgNodeId', async () => {
    // The null-node population is exactly what the KG-fact implementation could not
    // serve (#1623) — the table has no node prerequisite.
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = {
      findDuplicates: async () => pairs,
      listDedupExclusionPairKeys: async () => new Set([`${UUID_A}:${UUID_B}`]),
    };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_excluded: number };
      expect(data.skipped_excluded).toBe(1);
      expect(data.filed).toBe(0);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('files the pair when no exclusion is recorded', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const listDedupExclusionPairKeys = vi.fn().mockResolvedValue(new Set<string>());
    const contactService = { findDuplicates: async () => pairs, listDedupExclusionPairKeys };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    // Loaded once for the whole run, not once per pair.
    expect(listDedupExclusionPairKeys).toHaveBeenCalledOnce();
    if (result.success) {
      const data = result.data as { filed: number };
      expect(data.filed).toBe(1);
    }
  });

  it('aborts the scan when the exclusion load fails, rather than filing excluded pairs', async () => {
    // Fail closed: treating a load error as "nothing is excluded" would re-file
    // review tasks for every pair the CEO already ruled apart.
    const pairs = [makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95)];
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const contactService = {
      findDuplicates: async () => pairs,
      listDedupExclusionPairKeys: async () => { throw new Error('exclusion table unavailable'); },
    };
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('exclusion table unavailable');
    expect(createTask).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Summary counts
  // ---------------------------------------------------------------------------

  it('returns correct summary with mixed outcomes', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.96),   // filed
      makePair(UUID_A, 'Alice', null, UUID_C, 'Carol', null, 0.95), // skipped (existing task)
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = {
      listTasks: async () => [makeTaskRow(UUID_A, UUID_C)],
      createTask,
    };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        filed: number;
        skipped_existing: number;
        skipped_excluded: number;
        capped: number;
        failed: number;
        total_scanned: number;
      };
      expect(data.filed).toBe(1);
      expect(data.skipped_existing).toBe(1);
      expect(data.skipped_excluded).toBe(0);
      expect(data.capped).toBe(0);
      expect(data.failed).toBe(0);
      expect(data.total_scanned).toBe(2);
    }
  });

  it('returns zero counts when no pairs exist above threshold', async () => {
    const contactService = { findDuplicates: async () => [] };
    const createTask = vi.fn();
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; total_scanned: number };
      expect(data.filed).toBe(0);
      expect(data.total_scanned).toBe(0);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency: malformed existing task description (graceful degradation)
  // ---------------------------------------------------------------------------

  it('does not crash when a dedup-tagged task has no parseable contact IDs, and still files for unmatched pairs', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    // Existing task with a non-UUID-format description — should be silently ignored
    const malformedTask = { id: 'manual-task', description: 'Manually filed dedup task — no IDs', tags: ['dedup'] };
    const taskRepo = { listTasks: async () => [malformedTask], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    // Should not crash, and should still file the task since the malformed entry
    // is not recognized as an existing task for this pair
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_existing: number };
      expect(data.filed).toBe(1);
      expect(data.skipped_existing).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Per-pair error isolation
  // ---------------------------------------------------------------------------

  it('continues scan and increments failed count when createTask throws for one pair', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.96),   // createTask fails
      makePair(UUID_A, 'Alice', null, UUID_C, 'Carol', null, 0.95), // succeeds
    ];
    const contactService = { findDuplicates: async () => pairs };
    let callCount = 0;
    const createTask = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('DB pool exhausted');
      return { id: 'task-1' };
    });
    const taskRepo = { listTasks: async () => [], createTask };

    const result = await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    // Scan reports success (partial), not failure
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; failed: number };
      expect(data.filed).toBe(1);  // second pair succeeded
      expect(data.failed).toBe(1); // first pair failed
    }
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Task description format (for idempotency key parsing on subsequent runs)
  // ---------------------------------------------------------------------------

  it('writes task description with parseable Contact A/B ID lines', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };

    await handler.execute(makeContext({}, { contactService, taskRepo: taskRepo as never }));

    expect(createTask).toHaveBeenCalledOnce();
    const callArg = createTask.mock.calls[0]![0] as { description: string; tags: string[] };
    expect(callArg.description).toContain(`Contact A ID: ${UUID_A}`);
    expect(callArg.description).toContain(`Contact B ID: ${UUID_B}`);
    expect(callArg.description).toContain('Score:');
    expect(callArg.tags).toContain(dedupPairTag(UUID_A, UUID_B));
  });

  // ---------------------------------------------------------------------------
  // #2493: auto-merge, routing, cooldown, queue housekeeping
  // ---------------------------------------------------------------------------

  function email(contactId: string, address: string, verified = true): ChannelIdentity {
    return {
      id: `id-${contactId}-${address}`, contactId, channel: 'email', channelIdentifier: address,
      label: null, verified, verifiedAt: verified ? new Date() : null, status: 'active', source: 'ceo_stated',
    } as ChannelIdentity;
  }

  /** A pair as findDuplicates returns it, with real names and identities. */
  function pairOf(a: Contact, aIds: ChannelIdentity[], b: Contact, bIds: ChannelIdentity[], score = 0.95): DuplicatePair {
    return {
      contactA: { id: a.id, kgNodeId: a.kgNodeId, displayName: a.displayName, role: a.role, identities: aIds },
      contactB: { id: b.id, kgNodeId: b.kgNodeId, displayName: b.displayName, role: b.role, identities: bIds },
      score, confidence: 'certain', reason: 'test pair',
    };
  }

  function scan(
    pairs: DuplicatePair[],
    contacts: Contact[],
    opts: {
      autonomyScore?: number;
      openTasks?: Partial<TaskRow>[];
      closedTasks?: Partial<TaskRow>[];
      excluded?: string[];
      input?: Record<string, unknown>;
    } = {},
  ) {
    const mergeContacts = vi.fn().mockResolvedValue({});
    const createTask = vi.fn().mockResolvedValue({ id: 'new-task' });
    const updateTask = vi.fn().mockResolvedValue({});
    const completeTask = vi.fn().mockResolvedValue({});
    const ctx = makeContext(opts.input ?? {}, {
      contactService: {
        findDuplicates: async () => pairs,
        listContacts: async () => contacts,
        listDedupExclusionPairKeys: async () => new Set(opts.excluded ?? []),
        mergeContacts,
      },
      taskRepo: { listTasks: async () => opts.openTasks ?? [], createTask, updateTask, completeTask },
      closedTasks: opts.closedTasks,
      autonomyScore: opts.autonomyScore,
    });
    return { run: () => handler.execute(ctx), mergeContacts, createTask, updateTask, completeTask };
  }

  // Older contact with a verified address vs a newer one sharing it.
  const alice = makeContact(UUID_A, 'Alice Smith', { createdAt: new Date('2025-01-01T00:00:00Z') });
  const alice2 = makeContact(UUID_B, 'A. Smith', { createdAt: new Date('2026-01-01T00:00:00Z') });
  const sharedAddress = () => pairOf(
    alice, [email(UUID_A, 'alice@example.com')], alice2, [email(UUID_B, 'Alice@Example.com')], 1,
  );

  it('auto-merges a shared-verified-identity pair without filing a task, and audits the reason', async () => {
    const t = scan([sharedAddress()], [alice, alice2], { autonomyScore: 75 });
    const result = await t.run();
    expect(result.success).toBe(true);
    expect(t.mergeContacts).toHaveBeenCalledOnce();
    // The older record survives (identity counts tie, neither has a role).
    expect(t.mergeContacts).toHaveBeenCalledWith(UUID_A, UUID_B, false, {
      reason: expect.stringContaining('Same email identifier'),
      mergedBy: 'dedup-scan',
    });
    expect(t.createTask).not.toHaveBeenCalled();
    if (result.success) {
      expect(result.data).toMatchObject({ auto_merged: 1, auto_merge_enabled: true, filed: 0 });
    }
  });

  it('files the structural pair for review instead when the autonomy score is below 70', async () => {
    const t = scan([sharedAddress()], [alice, alice2], { autonomyScore: 65 });
    const result = await t.run();
    expect(t.mergeContacts).not.toHaveBeenCalled();
    expect(t.createTask).toHaveBeenCalledOnce();
    if (result.success) {
      expect(result.data).toMatchObject({ auto_merged: 0, auto_merge_enabled: false, filed: 1 });
      expect((result.data as { auto_merge_disabled_reason: string }).auto_merge_disabled_reason).toContain('below 70');
    }
  });

  it('does not auto-merge with no autonomy service (fails closed)', async () => {
    const t = scan([sharedAddress()], [alice, alice2]);
    await t.run();
    expect(t.mergeContacts).not.toHaveBeenCalled();
    expect(t.createTask).toHaveBeenCalledOnce();
  });

  it.each(['principal', 'agent'] as const)('never auto-merges a %s contact, even on a shared verified identity', async (kind) => {
    const structural = makeContact(UUID_A, 'Alice Smith', { kind, tier: kind === 'principal' ? 'principal' : 'unknown' });
    const t = scan(
      [pairOf(structural, [email(UUID_A, 'alice@example.com')], alice2, [email(UUID_B, 'alice@example.com')], 1)],
      [structural, alice2],
      { autonomyScore: 95 },
    );
    await t.run();
    expect(t.mergeContacts).not.toHaveBeenCalled();
    expect(t.createTask).toHaveBeenCalledOnce();
  });

  it('does not auto-merge an exact-name pair when one side is known (a display name can be forged)', async () => {
    const known = makeContact(UUID_A, 'Jane Doe', { tier: 'known' });
    const stranger = makeContact(UUID_B, 'Jane Doe');
    const t = scan([pairOf(known, [], stranger, [], 1)], [known, stranger], { autonomyScore: 95 });
    await t.run();
    expect(t.mergeContacts).not.toHaveBeenCalled();
    const task = t.createTask.mock.calls[0]![0] as { tags: string[]; description: string };
    expect(task.tags).toContain('dedup-route:principal');
    expect(task.description).toContain('Match type: structural');
  });

  // #2493 security review: a stranger's role address named after the principal's trusted
  // company is linked to that company's KG node, and must not be merged into it.
  it('does not auto-merge a trusted org with a stranger sharing its KG node, and routes it to the principal', async () => {
    const acme = makeContact(UUID_A, 'Acme Corp', { kind: 'organization', tier: 'trusted', kgNodeId: 'node-acme' });
    const impostor = makeContact(UUID_B, 'Acme Corp', { kind: 'organization', kgNodeId: 'node-acme' });
    const t = scan([pairOf(acme, [], impostor, [], 1)], [acme, impostor], { autonomyScore: 95 });
    await t.run();
    expect(t.mergeContacts).not.toHaveBeenCalled();
    const task = t.createTask.mock.calls[0]![0] as { tags: string[]; description: string };
    expect(task.tags).toContain('dedup-route:principal');
    expect(task.description).not.toContain('do not ask the principal');
  });

  it('auto-merges an exact-name pair when neither side has been vouched for', async () => {
    const a = makeContact(UUID_A, 'Acme Billing', { kind: 'automated' });
    const b = makeContact(UUID_B, 'ACME billing', { kind: 'organization' });
    const t = scan([pairOf(a, [], b, [], 1)], [a, b], { autonomyScore: 70 });
    await t.run();
    expect(t.mergeContacts).toHaveBeenCalledOnce();
  });

  it('does not auto-merge a structural pair that has a recorded exclusion', async () => {
    const t = scan([sharedAddress()], [alice, alice2], { autonomyScore: 95, excluded: [canonicalPairKey(UUID_A, UUID_B)] });
    const result = await t.run();
    expect(t.mergeContacts).not.toHaveBeenCalled();
    expect(t.createTask).not.toHaveBeenCalled();
    if (result.success) expect(result.data).toMatchObject({ skipped_excluded: 1 });
  });

  it('skips a later pair touching a contact merged earlier in the same run', async () => {
    const carol = makeContact(UUID_C, 'Alice Smyth');
    const t = scan(
      [sharedAddress(), pairOf(alice, [email(UUID_A, 'alice@example.com')], carol, [], 0.96)],
      [alice, alice2, carol],
      { autonomyScore: 95 },
    );
    const result = await t.run();
    expect(t.mergeContacts).toHaveBeenCalledOnce();
    expect(t.createTask).not.toHaveBeenCalled();
    if (result.success) expect(result.data).toMatchObject({ skipped_merged_this_run: 1 });
  });

  it('closes an open review task for a pair it auto-merges', async () => {
    const t = scan([sharedAddress()], [alice, alice2], {
      autonomyScore: 95,
      openTasks: [{ ...makeTaskRow(UUID_A, UUID_B), id: 'old-task', owner: 'ceo', tags: ['dedup', 'dedup-route:principal'] }],
    });
    await t.run();
    expect(t.mergeContacts).toHaveBeenCalledOnce();
    expect(t.completeTask).toHaveBeenCalledWith('old-task', expect.stringContaining('merged'), 'contacts');
  });

  it.each([
    ['organization', 'person', 'known', 'principal'],
    ['person', 'automated', 'trusted', 'principal'],
    ['organization', 'organization', 'unknown', 'curia'],
    ['person', 'person', 'unknown', 'curia'],
    ['person', 'person', 'known', 'principal'],
    ['person', 'person', 'trusted', 'principal'],
  ] as const)('routes a fuzzy %s/%s pair with a %s side to %s', async (kindA, kindB, tierA, route) => {
    const a = makeContact(UUID_A, 'Robert Jones', { kind: kindA, tier: tierA });
    const b = makeContact(UUID_B, 'Rob Jones', { kind: kindB });
    const t = scan([pairOf(a, [], b, [], 0.95)], [a, b]);
    const result = await t.run();
    const task = t.createTask.mock.calls[0]![0] as { tags: string[]; description: string; owner: string };
    expect(task.owner).toBe('curia');
    expect(task.tags).toContain(`dedup-route:${route}`);
    expect(task.description).toContain('Decision:');
    if (route === 'curia') expect(task.description).toContain('do not ask the principal');
    if (result.success) expect(result.data).toMatchObject({ filed_for_principal: route === 'principal' ? 1 : 0 });
  });

  describe('re-filing cooldown', () => {
    const a = makeContact(UUID_A, 'Robert Jones');
    const b = makeContact(UUID_B, 'Rob Jones');
    const pair = () => pairOf(a, [], b, [], 0.95);

    async function fingerprintTagFiled(): Promise<string> {
      const t = scan([pair()], [a, b]);
      await t.run();
      const tags = (t.createTask.mock.calls[0]![0] as { tags: string[] }).tags;
      return tags.find(tag => tag.startsWith('dedup-fp:'))!;
    }

    it('skips a pair whose review closed recently with the contacts unchanged', async () => {
      const fp = await fingerprintTagFiled();
      const t = scan([pair()], [a, b], {
        closedTasks: [{ ...makeTaskRow(UUID_A, UUID_B), status: 'done', tags: ['dedup', fp] }],
      });
      const result = await t.run();
      expect(t.createTask).not.toHaveBeenCalled();
      if (result.success) expect(result.data).toMatchObject({ skipped_recently_decided: 1, filed: 0 });
    });

    it('re-files inside the cooldown when either contact changed since', async () => {
      const fp = await fingerprintTagFiled();
      const renamed = makeContact(UUID_B, 'Robbie Jones');
      const t = scan(
        [pairOf(a, [], renamed, [email(UUID_B, 'rob@example.com', false)], 0.95)],
        [a, renamed],
        { closedTasks: [{ ...makeTaskRow(UUID_A, UUID_B), status: 'done', tags: ['dedup', fp] }] },
      );
      await t.run();
      expect(t.createTask).toHaveBeenCalledOnce();
    });

    it('holds a pair for the full cooldown when the closed task predates fingerprints', async () => {
      const t = scan([pair()], [a, b], {
        closedTasks: [{ ...makeTaskRow(UUID_A, UUID_B), status: 'done', tags: ['dedup', 'contacts'] }],
      });
      await t.run();
      expect(t.createTask).not.toHaveBeenCalled();
    });

    it('asks only for reviews closed within the cooldown window', async () => {
      const listTasks = vi.fn().mockResolvedValue([]);
      const ctx = makeContext({}, {
        contactService: { findDuplicates: async () => [] },
        taskRepo: { listTasks, createTask: vi.fn() },
      });
      // makeContext routes 'done' queries to closedTasks, so spy on the raw stub instead.
      const raw = ctx.taskRepo as unknown as { listTasks: (f: unknown) => Promise<unknown> };
      const spy = vi.fn(raw.listTasks);
      raw.listTasks = spy;
      await handler.execute(ctx);
      const closedCall = spy.mock.calls.find(c => (c[0] as { statuses: string[] }).statuses.includes('done'));
      const updatedAfter = (closedCall![0] as { updatedAfter: Date }).updatedAfter;
      const days = (Date.now() - updatedAfter.getTime()) / 86_400_000;
      expect(days).toBeCloseTo(DEFERRAL_COOLDOWN_DAYS, 0);
    });
  });

  describe('open-queue housekeeping', () => {
    const org = makeContact(UUID_A, 'Acme Inc', { kind: 'organization' });
    const orgDup = makeContact(UUID_B, 'Acme Incorporated', { kind: 'organization' });

    it('hands an owner-ceo task back to Curia when the pair is not the principal\'s to decide', async () => {
      const t = scan([], [org, orgDup], {
        openTasks: [{ ...makeTaskRow(UUID_A, UUID_B), id: 'ceo-task', owner: 'ceo', status: 'waiting' }],
      });
      const result = await t.run();
      expect(t.updateTask).toHaveBeenCalledWith(
        'ceo-task',
        expect.objectContaining({ owner: 'curia', status: 'open', tags: expect.arrayContaining(['dedup-route:curia']) }),
        'contacts',
      );
      if (result.success) expect(result.data).toMatchObject({ tasks_handed_back: 1 });
    });

    it('leaves an owner-ceo task with the principal when a known person is on it', async () => {
      const known = makeContact(UUID_A, 'Robert Jones', { tier: 'known' });
      const other = makeContact(UUID_B, 'Rob Jones');
      const t = scan([], [known, other], {
        openTasks: [{ ...makeTaskRow(UUID_A, UUID_B), id: 'ceo-task', owner: 'ceo', status: 'waiting', tags: ['dedup', 'dedup-route:principal'] }],
      });
      await t.run();
      expect(t.updateTask).not.toHaveBeenCalled();
    });

    it('closes a task naming a contact that no longer exists, and a pair filed twice', async () => {
      const t = scan([], [org, orgDup], {
        openTasks: [
          { ...makeTaskRow(UUID_A, UUID_C), id: 'stale' },
          { ...makeTaskRow(UUID_A, UUID_B), id: 'first', createdAt: '2026-01-01T00:00:00.000Z', tags: ['dedup', 'dedup-route:curia'] },
          { ...makeTaskRow(UUID_B, UUID_A), id: 'second', createdAt: '2026-02-01T00:00:00.000Z', tags: ['dedup', 'dedup-route:curia'] },
        ],
      });
      const result = await t.run();
      expect(t.completeTask).toHaveBeenCalledWith('stale', expect.stringContaining('no longer exists'), 'contacts');
      expect(t.completeTask).toHaveBeenCalledWith('second', expect.stringContaining('duplicate of task first'), 'contacts');
      expect(t.completeTask).not.toHaveBeenCalledWith('first', expect.anything(), expect.anything());
      if (result.success) expect(result.data).toMatchObject({ tasks_closed: 2 });
    });

    it('closes a task whose pair is now excluded', async () => {
      const t = scan([], [org, orgDup], {
        openTasks: [{ ...makeTaskRow(UUID_A, UUID_B), id: 'excluded-task' }],
        excluded: [canonicalPairKey(UUID_A, UUID_B)],
      });
      await t.run();
      expect(t.completeTask).toHaveBeenCalledWith('excluded-task', expect.stringContaining('not a duplicate'), 'contacts');
    });
  });
});
