import { describe, it, expect, vi } from 'vitest';
import { ContactFindDuplicatesHandler } from '../../../skills/contact-find-duplicates/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import type { DuplicatePair } from '../../../src/contacts/types.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
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

function makeCtx(
  input: Record<string, unknown>,
  overrides: {
    contactService?: { findDuplicates: () => Promise<DuplicatePair[]> };
    taskRepo?: {
      listTasks: () => Promise<Partial<TaskRow>[]>;
      createTask: (p: unknown) => Promise<Partial<TaskRow>>;
    };
    entityMemory?: { getFacts: (nodeId: string) => Promise<unknown[]> };
  } = {},
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: overrides.contactService as never,
    taskRepo: overrides.taskRepo as never,
    entityMemory: overrides.entityMemory as never,
  };
}

// Default stubs used in most tests
const emptyTaskRepo = {
  listTasks: async () => [],
  createTask: async () => ({ id: 'task-1' }),
};

const noFactsEntityMemory = {
  getFacts: async () => [],
};

describe('ContactFindDuplicatesHandler', () => {
  const handler = new ContactFindDuplicatesHandler();

  // ---------------------------------------------------------------------------
  // Service availability guards
  // ---------------------------------------------------------------------------

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('returns failure when taskRepo is not available', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(makeCtx({}, { contactService }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('taskRepo');
  });

  it('returns failure when entityMemory is not available', async () => {
    const contactService = { findDuplicates: async () => [] };
    const taskRepo = { listTasks: async () => [], createTask: async () => ({}) };
    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('entityMemory');
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  it('rejects min_score outside [0, 1]', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(
      makeCtx({ min_score: 1.5 }, { contactService, taskRepo: emptyTaskRepo as never, entityMemory: noFactsEntityMemory }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('min_score');
  });

  it('rejects non-integer max_tasks', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(
      makeCtx({ max_tasks: 1.5 }, { contactService, taskRepo: emptyTaskRepo as never, entityMemory: noFactsEntityMemory }),
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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({ min_score: 0.7 }, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({ max_tasks: 1 }, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({ max_tasks: 0 }, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_existing: number };
      expect(data.skipped_existing).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency: dedup_exclusion KG fact
  // ---------------------------------------------------------------------------

  it('skips pairs that have a dedup_exclusion fact on contact A naming contact B', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', 'kg-node-a', UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };
    const entityMemory = {
      getFacts: async (nodeId: string) => {
        if (nodeId === 'kg-node-a') {
          return [{ properties: { attribute: 'dedup_exclusion', value: UUID_B } }];
        }
        return [];
      },
    };

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_excluded: number };
      expect(data.filed).toBe(0);
      expect(data.skipped_excluded).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('skips pairs that have a dedup_exclusion fact on contact B naming contact A', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', 'kg-node-b', 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };
    const entityMemory = {
      getFacts: async (nodeId: string) => {
        if (nodeId === 'kg-node-b') {
          return [{ properties: { attribute: 'dedup_exclusion', value: UUID_A } }];
        }
        return [];
      },
    };

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { filed: number; skipped_excluded: number };
      expect(data.skipped_excluded).toBe(1);
      expect(createTask).not.toHaveBeenCalled();
    }
  });

  it('does not skip pairs when neither contact has a kgNodeId', async () => {
    const pairs = [
      makePair(UUID_A, 'Alice', null, UUID_B, 'Bob', null, 0.95),
    ];
    const contactService = { findDuplicates: async () => pairs };
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });
    const taskRepo = { listTasks: async () => [], createTask };
    const getFacts = vi.fn().mockResolvedValue([]);
    const entityMemory = { getFacts };

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory }));

    expect(result.success).toBe(true);
    // getFacts should never be called because both kgNodeIds are null
    expect(getFacts).not.toHaveBeenCalled();
    if (result.success) {
      const data = result.data as { filed: number };
      expect(data.filed).toBe(1);
    }
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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    const result = await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

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

    await handler.execute(makeCtx({}, { contactService, taskRepo: taskRepo as never, entityMemory: noFactsEntityMemory }));

    expect(createTask).toHaveBeenCalledOnce();
    const callArg = createTask.mock.calls[0]![0] as { description: string };
    expect(callArg.description).toContain(`Contact A ID: ${UUID_A}`);
    expect(callArg.description).toContain(`Contact B ID: ${UUID_B}`);
    expect(callArg.description).toContain('Score:');
  });
});
