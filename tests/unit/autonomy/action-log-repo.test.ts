// action-log-repo.test.ts — unit tests for ActionLogRepo using a mock pool.
// All DB interaction is intercepted; no real Postgres connection is required.

import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

function makePool(rows: Record<string, unknown>[] = [], rowCount = 0): {
  pool: Pool;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows, rowCount } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, queries };
}

/**
 * Like makePool, but returns different rows for each successive query call.
 * Used to test methods that make multiple DB round-trips (e.g. resolvePending).
 */
function makeSequentialPool(
  callResults: Array<Record<string, unknown>[]>,
): { pool: Pool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callIndex = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      const rows = callResults[callIndex] ?? [];
      callIndex++;
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, queries };
}

/**
 * A pool whose connect() hands out a fake client that records every query it runs (#2159
 * Phase 3). Pending-approval inserts allocate their approval number on that client inside a
 * transaction. `pool.query` is recorded separately, so a test can prove which path ran.
 *
 * `freeNumber` is what the free-number query returns (null: all 999 are taken).
 * `failOn` makes the first query whose SQL contains it throw, to exercise the rollback path;
 * `failRollback` makes the ROLLBACK itself throw too.
 */
function makeTxPool(opts: { freeNumber?: number | null; insertedId?: string; failOn?: string; failRollback?: boolean } = {}): {
  pool: Pool;
  clientQueries: Array<{ sql: string; params: unknown[] }>;
  poolQueries: Array<{ sql: string; params: unknown[] }>;
  release: ReturnType<typeof vi.fn>;
} {
  const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
  const poolQueries: Array<{ sql: string; params: unknown[] }> = [];
  const release = vi.fn();
  const freeNumber = opts.freeNumber === undefined ? 3 : opts.freeNumber;
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params: params ?? [] });
      if (opts.failRollback && sql === 'ROLLBACK') throw new Error('connection terminated');
      if (opts.failOn && sql.includes(opts.failOn)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      if (sql.includes('generate_series')) {
        const rows = freeNumber === null ? [] : [{ n: freeNumber }];
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }
      if (sql.includes('INSERT INTO autonomy_action_log')) {
        return { rows: [{ id: opts.insertedId ?? '42' }], rowCount: 1 } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }),
    release,
  };
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params: params ?? [] });
      return { rows: [{ id: '7' }], rowCount: 1 } as unknown as QueryResult;
    }),
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, clientQueries, poolQueries, release };
}

const pendingInsert = {
  taskId: 'task-1',
  toolName: 'email-send',
  actionRisk: 'medium',
  outcome: 'pending_approval' as const,
  shortRef: 'a3f7c12b',
  description: 'Send email to dana@example.com',
  expiresAt: new Date('2026-10-20T12:00:00Z'),
};

describe('ActionLogRepo', () => {
  // #2159 Phase 3: a pending approval gets a small number the principal can type ("approve 3").
  describe('insert: approval number allocation', () => {
    it('allocates under an advisory lock and inserts the number on the same client, in one transaction', async () => {
      const { pool, clientQueries, poolQueries, release } = makeTxPool({ freeNumber: 3, insertedId: '42' });
      const repo = new ActionLogRepo(pool, createSilentLogger());

      const id = await repo.insert(pendingInsert);

      // Return value unchanged: the id, coerced from pg's int8 string.
      expect(id).toBe(42);
      expect(poolQueries).toHaveLength(0);
      const sqls = clientQueries.map((q) => q.sql);
      expect(sqls).toHaveLength(5);
      // READ COMMITTED explicitly: the free-number read must see the previous holder's commit.
      expect(sqls[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(sqls[1]).toContain("SELECT pg_advisory_xact_lock(hashtext('autonomy_approval_number'))");
      expect(sqls[2]).toContain('generate_series(1, 999)');
      expect(sqls[2]).toContain("created_at > now() - interval '7 days'");
      expect(sqls[2]).toContain('approval_number IS NOT NULL');
      expect(sqls[3]).toContain('INSERT INTO autonomy_action_log');
      expect(sqls[3]).toContain('approval_number)');
      expect(sqls[4]).toBe('COMMIT');
      // Controller ruling R1: approval_number is the LAST column ($17), so the positional
      // indices of the existing 16 params are unchanged.
      const insertParams = clientQueries[3]!.params;
      expect(insertParams).toHaveLength(17);
      expect(insertParams[16]).toBe(3);
      expect(insertParams[4]).toBe('pending_approval');
      expect(insertParams[8]).toBe('a3f7c12b');
      expect(release).toHaveBeenCalledTimes(1);
      // Released cleanly, not with an error (which would destroy the connection).
      expect(release.mock.calls[0]![0]).toBeUndefined();
    });

    it('destroys the connection when ROLLBACK itself fails, and still rethrows the original error', async () => {
      const { pool, release } = makeTxPool({ failOn: 'INSERT INTO autonomy_action_log', failRollback: true });
      const repo = new ActionLogRepo(pool, createSilentLogger());

      await expect(repo.insert(pendingInsert)).rejects.toMatchObject({ code: '23505' });

      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
    });

    it('rolls back without inserting, releases once and rethrows when the free-number SELECT fails', async () => {
      const { pool, clientQueries, release } = makeTxPool({ failOn: 'generate_series' });
      const repo = new ActionLogRepo(pool, createSilentLogger());

      await expect(repo.insert(pendingInsert)).rejects.toMatchObject({ code: '23505' });

      const sqls = clientQueries.map((q) => q.sql);
      expect(sqls.some((sql) => sql.includes('INSERT INTO autonomy_action_log'))).toBe(false);
      expect(sqls).not.toContain('COMMIT');
      expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]![0]).toBeUndefined();
    });

    it('rolls back, releases the client and rethrows when the INSERT fails', async () => {
      const { pool, clientQueries, release } = makeTxPool({ failOn: 'INSERT INTO autonomy_action_log' });
      const repo = new ActionLogRepo(pool, createSilentLogger());

      // The original error comes through unchanged: approval-trigger retries on its 23505 code.
      await expect(repo.insert(pendingInsert)).rejects.toMatchObject({ code: '23505' });

      const sqls = clientQueries.map((q) => q.sql);
      expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
      expect(sqls).not.toContain('COMMIT');
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('inserts NULL and warns when all 999 numbers are in use', async () => {
      const { pool, clientQueries, release } = makeTxPool({ freeNumber: null });
      const logger = createSilentLogger();
      const warn = vi.spyOn(logger, 'warn');
      const repo = new ActionLogRepo(pool, logger);

      await repo.insert(pendingInsert);

      const insert = clientQueries.find((q) => q.sql.includes('INSERT INTO autonomy_action_log'))!;
      expect(insert.params[16]).toBeNull();
      expect(clientQueries[clientQueries.length - 1]!.sql).toBe('COMMIT');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('does not allocate for a non-pending insert, and uses pool.query as before', async () => {
      const { pool, clientQueries, poolQueries } = makeTxPool();
      const repo = new ActionLogRepo(pool, createSilentLogger());

      const id = await repo.insert({ ...pendingInsert, outcome: 'success' });

      expect(id).toBe(7);
      expect(clientQueries).toHaveLength(0);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(poolQueries).toHaveLength(1);
      expect(poolQueries[0]!.sql).not.toContain('pg_advisory_xact_lock');
      // The column is still in the list (one insert shape), always NULL off the pending path.
      expect(poolQueries[0]!.params).toHaveLength(17);
      expect(poolQueries[0]!.params[16]).toBeNull();
    });
  });

  describe('findApprovalNumber', () => {
    it('returns the number for the row', async () => {
      const { pool, queries } = makePool([{ approval_number: 5 }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      expect(await repo.findApprovalNumber(42)).toBe(5);
      expect(queries[0]!.sql).toContain('approval_number');
      expect(queries[0]!.params).toEqual([42]);
    });

    it('returns null when the row has no number or does not exist', async () => {
      const unnumbered = makePool([{ approval_number: null }]);
      expect(await new ActionLogRepo(unnumbered.pool, createSilentLogger()).findApprovalNumber(42)).toBeNull();
      const missing = makePool([]);
      expect(await new ActionLogRepo(missing.pool, createSilentLogger()).findApprovalNumber(42)).toBeNull();
    });
  });

  describe('insert', () => {
    it('inserts a row and returns the id coerced from pg\'s int8 string', async () => {
      // pg returns the BIGSERIAL id as a string; the repo coerces it to a number at the boundary.
      const { pool, queries } = makePool([{ id: '42' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const id = await repo.insert({
        taskId: 'task-1',
        conversationId: 'conv-1',
        toolName: 'calendar-create-event',
        actionRisk: 'high',
        outcome: 'success',
        taskSummary: 'Create a lunch meeting',
      });
      expect(id).toBe(42);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('INSERT INTO autonomy_action_log');
      expect(queries[0]!.params).toContain('task-1');
      expect(queries[0]!.params).toContain('conv-1');
    });

    it('includes parent_action_id in INSERT when provided', async () => {
      const { pool, queries } = makePool([{ id: 99 }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const id = await repo.insert({
        taskId: 'task-1',
        toolName: 'calendar-create-event',
        actionRisk: 'high',
        outcome: 'success',
        parentActionId: 42,
      });
      expect(id).toBe(99);
      expect(queries[0]!.sql).toContain('parent_action_id');
      expect(queries[0]!.params).toContain(42);
    });
  });

  describe('insertShadowEvaluated', () => {
    it('inserts with ON CONFLICT DO NOTHING and returns the id coerced from pg\'s int8 string', async () => {
      // node-postgres returns BIGSERIAL/int8 as a STRING; the fixture mirrors that so the assertion
      // proves the repo coerces it to a number at the boundary (id === 7, not '7').
      const { pool, queries } = makePool([{ id: '7' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const id = await repo.insertShadowEvaluated({
        taskId: 'shadow:src-1',
        toolName: 'shadow-draft-eval',
        actionRisk: 'none',
        outcome: 'shadow_evaluated',
        payload: { shadow: true, source_message_id: 'src-1' },
        competenceFlag: 1,
        scoredBy: 'shadow-reconciler',
      });
      expect(id).toBe(7);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('ON CONFLICT');
      expect(queries[0]!.sql).toContain("payload->>'source_message_id'");
      expect(queries[0]!.sql).toContain('DO NOTHING');
    });

    it('returns null when the insert is a no-op (conflict — row already exists)', async () => {
      // ON CONFLICT DO NOTHING returns zero rows when the row already exists.
      const { pool } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const id = await repo.insertShadowEvaluated({
        taskId: 'shadow:src-1',
        toolName: 'shadow-draft-eval',
        actionRisk: 'none',
        outcome: 'shadow_evaluated',
        payload: { shadow: true, source_message_id: 'src-1' },
        competenceFlag: 1,
        scoredBy: 'shadow-reconciler',
      });
      expect(id).toBeNull();
    });
  });

  describe('findUnscoredTerminal', () => {
    it('returns rows ordered by created_at asc with limit', async () => {
      const now = new Date();
      const { pool } = makePool([
        {
          id: 1, task_id: 't1', conversation_id: null, skill_name: 'send-email',
          action_risk: 'medium', outcome: 'success', task_summary: 'Send reply',
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: null, notification_sent_at: null,
          resolved_at: null, resolved_by: null, expires_at: null,
          parent_action_id: null, short_ref: null, description: null,
          created_at: now,
        },
      ]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.findUnscoredTerminal(10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(1);
      expect(rows[0]!.toolName).toBe('send-email');
    });
  });

  describe('updateScoringFlags', () => {
    it('updates the scoring columns for a row', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.updateScoringFlags(42, {
        competenceFlag: 1,
        commitmentFlag: 1,
        compatibility: null,
        scoredBy: 'llm-judge',
      });
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('UPDATE autonomy_action_log');
      expect(queries[0]!.params).toContain(42);
      expect(queries[0]!.params).toContain('llm-judge');
    });
  });

  describe('countScored', () => {
    it('returns the count of scored rows', async () => {
      const { pool, queries } = makePool([{ count: '47' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.countScored();
      expect(count).toBe(47);
      expect(queries[0]!.sql).toMatch(/competence_flag IS NOT NULL/);
      expect(queries[0]!.sql).toMatch(/commitment_flag IS NOT NULL/);
      expect(queries[0]!.sql).toMatch(/compatibility IS NOT NULL/);
    });
  });

  describe('findAllScored', () => {
    // Coordinator-resolved rows are scored with every flag null (#2159). They must be
    // filtered before the LIMIT, or a run of them pushes real evidence out of the window.
    it('selects only evidence-bearing rows, before the limit applies', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.findAllScored(500);
      const sql = queries[0]!.sql;
      expect(sql).toMatch(/competence_flag IS NOT NULL/);
      expect(sql).toMatch(/commitment_flag IS NOT NULL/);
      expect(sql).toMatch(/compatibility IS NOT NULL/);
      expect(sql.indexOf('competence_flag IS NOT NULL')).toBeLessThan(sql.indexOf('LIMIT'));
      expect(queries[0]!.params).toEqual([500]);
    });
  });

  describe('getRecentCompetenceErrorRate', () => {
    it('returns the error rate from the last N scored rows', async () => {
      const { pool } = makePool([{ total: '30', errors: '8' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rate = await repo.getRecentCompetenceErrorRate(30);
      expect(rate).toBeCloseTo(8 / 30);
    });

    // #2159: an empty window is "no evidence", not "no errors" — the guard blocks increases on it.
    it('returns null when no scored rows exist', async () => {
      const { pool } = makePool([{ total: '0', errors: '0' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rate = await repo.getRecentCompetenceErrorRate(30);
      expect(rate).toBeNull();
    });
  });

  describe('findPendingByTaskAndSkill', () => {
    it('returns the matching pending row when one exists', async () => {
      const now = new Date();
      const { pool } = makePool([
        {
          id: 10, task_id: 't1', conversation_id: null, skill_name: 'calendar-create-event',
          action_risk: 'high', outcome: 'pending_approval', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: { title: 'Lunch' }, notification_sent_at: null,
          resolved_at: null, resolved_by: null, expires_at: null,
          parent_action_id: null, short_ref: 'cal-1', description: 'Create calendar event: Lunch',
          created_at: now,
        },
      ]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const row = await repo.findPendingByTaskAndSkill('t1', 'calendar-create-event', { title: 'Lunch' });
      expect(row).not.toBeNull();
      expect(row!.id).toBe(10);
      expect(row!.shortRef).toBe('cal-1');
    });

    it('returns null when no matching row exists', async () => {
      const { pool } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const row = await repo.findPendingByTaskAndSkill('t1', 'calendar-create-event', { title: 'Lunch' });
      expect(row).toBeNull();
    });

    it('uses JSONB equality for payload comparison', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.findPendingByTaskAndSkill('t1', 'send-email', { to: 'a@b.com', subject: 'Hi' });
      expect(queries[0]!.sql).toContain('payload::jsonb = $3::jsonb');
      expect(queries[0]!.params[2]).toBe(JSON.stringify({ to: 'a@b.com', subject: 'Hi' }));
    });
  });

  describe('setNotificationSentAt', () => {
    it('updates the notification_sent_at column', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.setNotificationSentAt(42);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('UPDATE autonomy_action_log');
      expect(queries[0]!.sql).toContain('notification_sent_at');
      expect(queries[0]!.params).toContain(42);
    });
  });

  describe('findAllPending', () => {
    it('returns pending rows ordered by created_at asc', async () => {
      const now = new Date();
      const { pool } = makePool([
        {
          id: 1, task_id: 't1', conversation_id: null, skill_name: 'calendar-create-event',
          action_risk: 'high', outcome: 'pending_approval', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: { title: 'Lunch' }, notification_sent_at: null,
          resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() + 86_400_000),
          parent_action_id: null, short_ref: 'cal-1', description: 'Create calendar event: Lunch',
          created_at: now,
        },
      ]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.findAllPending();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.shortRef).toBe('cal-1');
    });

    it('uses the correct SQL filter for pending + non-expired', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.findAllPending();
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.sql).toContain('expires_at > now()');
    });
  });

  describe('resolveRow', () => {
    it('updates outcome and returns true when row was pending', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const updated = await repo.resolveRow(42, 'approved', 'ceo');
      expect(updated).toBe(true);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('UPDATE autonomy_action_log');
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.params).toContain(42);
      expect(queries[0]!.params).toContain('approved');
      expect(queries[0]!.params).toContain('ceo');
    });

    it('returns false when row was already resolved (rowCount 0)', async () => {
      const { pool } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const updated = await repo.resolveRow(42, 'approved', 'ceo');
      expect(updated).toBe(false);
    });

    it('accepts denied outcome', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const updated = await repo.resolveRow(10, 'denied', 'ceo');
      expect(updated).toBe(true);
      expect(queries[0]!.params).toContain('denied');
    });

    it('accepts resolved_externally outcome', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const updated = await repo.resolveRow(10, 'resolved_externally', 'ceo');
      expect(updated).toBe(true);
      expect(queries[0]!.params).toContain('resolved_externally');
    });
  });

  describe('resolvePending', () => {
    // A representative pending row fixture used across multiple tests.
    const pendingRow = {
      id: 10, task_id: 't1', conversation_id: null, skill_name: 'calendar-create-event',
      action_risk: 'high', outcome: 'pending_approval', task_summary: null,
      competence_flag: null, commitment_flag: null, compatibility: null,
      scored_by: null, payload: { title: 'Lunch' }, notification_sent_at: null,
      resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() + 86_400_000),
      parent_action_id: null, short_ref: 'cal-1', description: 'Create calendar event: Lunch',
      created_at: new Date(),
    };

    it('resolves by short_ref when provided', async () => {
      const { pool, queries } = makeSequentialPool([[pendingRow]]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending('cal-1');
      expect(result.found).toBe(true);
      if (result.found) expect(result.row.id).toBe(10);
      // Query 1 should include ORDER BY created_at ASC for deterministic resolution
      expect(queries[0]!.sql).toContain('ORDER BY created_at ASC');
    });

    it('returns not_found when short_ref does not match any row', async () => {
      // Both queries (pending-only and any-outcome) return nothing.
      const { pool } = makeSequentialPool([[], []]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending('cal-99');
      expect(result).toEqual({
        found: false,
        reason: 'not_found',
        error: expect.stringContaining('cal-99'),
      });
    });

    it('returns already_resolved when row exists but is not pending', async () => {
      const resolvedRow = { ...pendingRow, outcome: 'approved' };
      // Query 1 (pending + non-expired) returns nothing;
      // Query 2 (any outcome) returns the resolved row.
      const { pool, queries } = makeSequentialPool([[], [resolvedRow]]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending('cal-1');
      expect(result).toEqual({
        found: false,
        reason: 'already_resolved',
        error: expect.stringContaining('already resolved'),
      });
      // Query 2 should include ORDER BY created_at DESC for most recent row
      expect(queries[1]!.sql).toContain('ORDER BY created_at DESC');
    });

    it('returns expired when row is pending but past expires_at', async () => {
      const expiredRow = { ...pendingRow, expires_at: new Date(Date.now() - 1000) };
      // Query 1 (pending + non-expired) returns nothing;
      // Query 2 (any outcome) returns the expired-but-still-pending row.
      const { pool } = makeSequentialPool([[], [expiredRow]]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending('cal-1');
      expect(result).toEqual({
        found: false,
        reason: 'expired',
        error: expect.stringContaining('expired'),
      });
    });

    it('resolvePending(a3f7c12b) still looks up by short_ref, never by number', async () => {
      const { pool, queries } = makeSequentialPool([[{ ...pendingRow, short_ref: 'a3f7c12b' }]]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending('a3f7c12b');
      expect(result.found).toBe(true);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('WHERE short_ref = $1');
      expect(queries[0]!.sql).not.toContain('approval_number');
      expect(queries[0]!.params).toEqual(['a3f7c12b']);
    });

    // #2159 Phase 3: approval numbers.
    describe('by approval number', () => {
      const numbered = { ...pendingRow, approval_number: 3 };

      it('resolvePending(3) looks the number up among pending, non-expired rows of the last 7 days', async () => {
        const { pool, queries } = makeSequentialPool([[numbered]]);
        const repo = new ActionLogRepo(pool, createSilentLogger());
        const result = await repo.resolvePending('3');
        expect(result.found).toBe(true);
        if (result.found) {
          expect(result.row.id).toBe(10);
          expect(result.row.approvalNumber).toBe(3);
        }
        expect(queries).toHaveLength(1);
        const { sql, params } = queries[0]!;
        expect(sql).toContain('approval_number = $1');
        expect(sql).toContain("outcome = 'pending_approval'");
        expect(sql).toContain('expires_at > now()');
        expect(sql).toContain("created_at > now() - interval '7 days'");
        expect(sql).not.toContain('short_ref');
        // Parameterized, and as a number: '3' and '03' are the same approval.
        expect(params).toEqual([3]);
      });

      it('accepts leading zeros up to three digits', async () => {
        const { pool, queries } = makeSequentialPool([[numbered]]);
        await new ActionLogRepo(pool, createSilentLogger()).resolvePending('003');
        expect(queries[0]!.params).toEqual([3]);
      });

      it('treats four digits as a short_ref, not a number', async () => {
        const { pool, queries } = makeSequentialPool([[], []]);
        await new ActionLogRepo(pool, createSilentLogger()).resolvePending('1234');
        expect(queries[0]!.sql).toContain('short_ref = $1');
        expect(queries[0]!.params).toEqual(['1234']);
      });

      it('returns not_found when no row in the last 7 days carries the number', async () => {
        const { pool, queries } = makeSequentialPool([[], []]);
        const result = await new ActionLogRepo(pool, createSilentLogger()).resolvePending('7');
        expect(result).toEqual({ found: false, reason: 'not_found', error: expect.stringContaining('7') });
        // The fallback lookup is restricted to the same 7-day window, newest first.
        expect(queries[1]!.sql).toContain('approval_number = $1');
        expect(queries[1]!.sql).toContain("created_at > now() - interval '7 days'");
        expect(queries[1]!.sql).toContain('ORDER BY created_at DESC');
        expect(queries[1]!.params).toEqual([7]);
      });

      it('returns already_resolved when the numbered row is no longer pending', async () => {
        const { pool, queries } = makeSequentialPool([[], [{ ...numbered, outcome: 'approved' }]]);
        const result = await new ActionLogRepo(pool, createSilentLogger()).resolvePending('3');
        expect(result).toEqual({ found: false, reason: 'already_resolved', error: expect.stringContaining('already resolved') });
        // Guard: these fixtures would give the same reason on the short_ref path.
        expect(queries[0]!.sql).toContain('approval_number = $1');
        expect(queries[1]!.sql).toContain('approval_number = $1');
      });

      it('returns expired when the numbered row is pending but past expires_at', async () => {
        const { pool, queries } = makeSequentialPool([[], [{ ...numbered, expires_at: new Date(Date.now() - 1000) }]]);
        const result = await new ActionLogRepo(pool, createSilentLogger()).resolvePending('3');
        expect(result).toEqual({ found: false, reason: 'expired', error: expect.stringContaining('expired') });
        expect(queries[0]!.sql).toContain('approval_number = $1');
        expect(queries[1]!.sql).toContain('approval_number = $1');
      });

      it('refuses to pick when two live rows carry the same number', async () => {
        // Allocation makes this impossible; if it ever happens, never resolve the wrong approval.
        const { pool, queries } = makeSequentialPool([[numbered, { ...numbered, id: 11 }]]);
        const result = await new ActionLogRepo(pool, createSilentLogger()).resolvePending('3');
        expect(result.found).toBe(false);
        if (!result.found) expect(result.reason).toBe('ambiguous');
        expect(queries[0]!.sql).toContain('approval_number = $1');
      });
    });

    // #2159 Phase 3: the reaction mapper binds a delivered "Approval <n>" message by number.
    describe('findPendingByApprovalNumber', () => {
      const numbered = { ...pendingRow, approval_number: 3 };

      it('finds the live row among pending, non-expired rows of the last 7 days', async () => {
        const { pool, queries } = makeSequentialPool([[numbered]]);
        const row = await new ActionLogRepo(pool, createSilentLogger()).findPendingByApprovalNumber(3);
        expect(row?.id).toBe(10);
        expect(row?.approvalNumber).toBe(3);
        const { sql, params } = queries[0]!;
        expect(sql).toContain('approval_number = $1');
        expect(sql).toContain("outcome = 'pending_approval'");
        expect(sql).toContain('expires_at > now()');
        expect(sql).toContain("created_at > now() - interval '7 days'");
        expect(params).toEqual([3]);
      });

      it('returns null when no live row carries the number', async () => {
        const { pool } = makeSequentialPool([[]]);
        expect(await new ActionLogRepo(pool, createSilentLogger()).findPendingByApprovalNumber(3)).toBeNull();
      });

      it('returns null, never a guess, when two live rows carry the same number', async () => {
        const { pool } = makeSequentialPool([[numbered, { ...numbered, id: 11 }]]);
        expect(await new ActionLogRepo(pool, createSilentLogger()).findPendingByApprovalNumber(3)).toBeNull();
      });

      // The mapper must bind exactly the row "approve 3" would resolve: one shared lookup.
      it('runs the same live-row query as resolvePending(n)', async () => {
        const binding = makeSequentialPool([[numbered]]);
        await new ActionLogRepo(binding.pool, createSilentLogger()).findPendingByApprovalNumber(3);
        const resolving = makeSequentialPool([[numbered]]);
        await new ActionLogRepo(resolving.pool, createSilentLogger()).resolvePending('3');
        expect(binding.queries[0]).toEqual(resolving.queries[0]);
      });
    });

    it('resolves to sole pending row when no short_ref provided', async () => {
      // findAllPending returns one row
      const { pool } = makePool([pendingRow]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending();
      expect(result.found).toBe(true);
      if (result.found) expect(result.row.id).toBe(10);
    });

    it('returns not_found when no short_ref and no pending rows', async () => {
      const { pool } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending();
      expect(result).toEqual({
        found: false,
        reason: 'not_found',
        error: expect.stringContaining('No pending'),
      });
    });

    it('returns ambiguous when no short_ref and multiple pending rows', async () => {
      const row2 = { ...pendingRow, id: 11, short_ref: 'email-1', skill_name: 'email-reply' };
      const { pool } = makePool([pendingRow, row2]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolvePending();
      expect(result.found).toBe(false);
      if (!result.found) {
        expect(result.reason).toBe('ambiguous');
        expect((result as { pending: unknown[] }).pending).toHaveLength(2);
      }
    });
  });

  // #2159: approval delivery claims and the safety net's lookup.
  describe('claimNotification / releaseNotification', () => {
    it('claims only an unclaimed pending row, parameterized', async () => {
      const { pool, queries } = makePool([{ id: 7 }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());

      await expect(repo.claimNotification(7)).resolves.toBe(true);
      expect(queries[0]!.sql).toMatch(/notification_sent_at IS NULL/);
      expect(queries[0]!.sql).toMatch(/outcome = 'pending_approval'/);
      expect(queries[0]!.params).toEqual([7]);
    });

    it('reports a lost race as false', async () => {
      const { pool } = makePool([]);
      await expect(new ActionLogRepo(pool, createSilentLogger()).claimNotification(7)).resolves.toBe(false);
    });

    it('releases by id', async () => {
      const { pool, queries } = makePool([]);
      await new ActionLogRepo(pool, createSilentLogger()).releaseNotification(7);
      expect(queries[0]!.sql).toMatch(/SET notification_sent_at = NULL/);
      expect(queries[0]!.params).toEqual([7]);
    });
  });

  describe('findUndelivered', () => {
    it('finds live pending rows never delivered and older than the cutoff', async () => {
      const { pool, queries } = makePool([]);
      const cutoff = new Date('2026-10-18T12:00:00Z');

      await new ActionLogRepo(pool, createSilentLogger()).findUndelivered(cutoff);

      const { sql, params } = queries[0]!;
      expect(sql).toMatch(/outcome = 'pending_approval'/);
      expect(sql).toMatch(/notification_sent_at IS NULL/);
      expect(sql).toMatch(/expires_at > now\(\)/);
      expect(sql).toMatch(/created_at < \$1/);
      expect(params).toEqual([cutoff]);
    });
  });

  describe('findExpired', () => {
    it('returns expired pending_approval rows ordered by created_at asc', async () => {
      const now = new Date();
      const { pool } = makePool([
        {
          id: 5, task_id: 't1', conversation_id: null, skill_name: 'email-send',
          action_risk: 'medium', outcome: 'pending_approval', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: { to: 'a@b.com' }, notification_sent_at: null,
          resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() - 1000),
          parent_action_id: null, short_ref: 'email-1', description: 'Send email to a@b.com',
          created_at: now,
        },
      ]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.findExpired();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(5);
      expect(rows[0]!.shortRef).toBe('email-1');
    });

    it('uses correct SQL filter for pending + expired', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.findExpired();
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.sql).toContain('expires_at <= now()');
    });
  });

  describe('linkPayload', () => {
    it('merges additional payload into existing row by short_ref', async () => {
      // rowCount = 1 signals that one row was updated; rows array is the RETURNING result (unused here)
      const { pool, queries } = makePool([{ id: 1, payload: { source: 'autonomy_gate' } }], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());

      const result = await repo.linkPayload('email-1', 'task-evt-001', { draftId: 'draft-abc', accountId: 'curia' });

      expect(result).toBe(true);
      expect(queries[0]!.sql).toContain('UPDATE');
      expect(queries[0]!.sql).toContain('short_ref');
      expect(queries[0]!.sql).toContain('jsonb');
      expect(queries[0]!.params).toContain('email-1');
    });

    it('returns false when no row matches the short_ref', async () => {
      const { pool } = makePool([]);  // empty result — rowCount = 0
      const repo = new ActionLogRepo(pool, createSilentLogger());

      const result = await repo.linkPayload('unknown-ref', undefined, { draftId: 'draft-xyz' });

      expect(result).toBe(false);
    });

    it('scopes update to task_id column (not task_event_id) when taskEventId is provided', async () => {
      // Bug fix: the WHERE clause previously used task_event_id which doesn't exist —
      // the actual column is task_id. Verify the SQL uses the correct column name.
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());

      await repo.linkPayload('email-1', 'task-evt-001', { draftId: 'draft-abc' });

      expect(queries[0]!.sql).toContain('task_id');
      expect(queries[0]!.sql).not.toContain('task_event_id');
    });
  });

  describe('findPendingByPayloadField', () => {
    it('returns row when payload field matches', async () => {
      const now = new Date();
      const { pool } = makePool([
        {
          id: 1, task_id: 't-1', conversation_id: null, skill_name: 'send-email',
          action_risk: 'medium', outcome: 'pending_approval', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: { draftId: 'draft-abc' }, notification_sent_at: null,
          resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() + 86_400_000),
          parent_action_id: null, short_ref: 'email-1', description: 'Send email draft',
          created_at: now,
        },
      ]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.findPendingByPayloadField('draftId', 'draft-abc');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
    });

    it('returns null when no match', async () => {
      const { pool } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.findPendingByPayloadField('draftId', 'nonexistent');
      expect(result).toBeNull();
    });

    it('queries with correct SQL targeting payload JSONB field and pending_approval outcome', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.findPendingByPayloadField('draftId', 'draft-xyz');
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.sql).toContain('payload->>');
      expect(queries[0]!.params).toContain('draftId');
      expect(queries[0]!.params).toContain('draft-xyz');
    });
  });

  describe('resolveById', () => {
    it('returns true when row is updated', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolveById(42, 'approved', 'ceo');
      expect(result).toBe(true);
      expect(queries[0]!.sql).toContain('UPDATE autonomy_action_log');
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.params).toContain(42);
      expect(queries[0]!.params).toContain('approved');
      expect(queries[0]!.params).toContain('ceo');
    });

    it('returns false when no matching row (already resolved or not found)', async () => {
      const { pool } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const result = await repo.resolveById(99, 'approved', 'ceo');
      expect(result).toBe(false);
    });
  });

  describe('expireRows', () => {
    it('batch-transitions rows to expired and returns the updated rows', async () => {
      const now = new Date();
      const returnedRows = [
        {
          id: 1, task_id: 't1', conversation_id: null, skill_name: 'email-send',
          action_risk: 'medium', outcome: 'expired', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: null, notification_sent_at: null,
          resolved_at: now, resolved_by: 'system',
          expires_at: new Date(now.getTime() - 1000),
          parent_action_id: null, short_ref: 'email-1', description: 'Send email', created_at: now,
        },
        {
          id: 2, task_id: 't1', conversation_id: null, skill_name: 'create-calendar-event',
          action_risk: 'high', outcome: 'expired', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: null, notification_sent_at: null,
          resolved_at: now, resolved_by: 'system',
          expires_at: new Date(now.getTime() - 1000),
          parent_action_id: null, short_ref: 'cal-1', description: 'Create event', created_at: now,
        },
      ];
      const { pool, queries } = makePool(returnedRows);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.expireRows([1, 2]);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe(1);
      expect(rows[0]!.outcome).toBe('expired');
      expect(rows[0]!.resolvedBy).toBe('system');
      expect(rows[1]!.id).toBe(2);
      expect(queries[0]!.sql).toContain("outcome = 'expired'");
      expect(queries[0]!.sql).toContain("resolved_by = 'system'");
      expect(queries[0]!.sql).toContain('resolved_at = now()');
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.sql).toContain('RETURNING');
      expect(queries[0]!.params[0]).toEqual([1, 2]);
    });

    it('returns empty array for empty ids (no-op — no query issued)', async () => {
      const { pool, queries } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.expireRows([]);
      expect(rows).toEqual([]);
      // Early return path — no DB query issued for empty input
      expect(queries).toHaveLength(0);
    });

    it('returns empty array when no rows matched (idempotency — all concurrently resolved)', async () => {
      // RETURNING returns 0 rows when WHERE clause matches nothing
      const { pool } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.expireRows([42]);
      expect(rows).toHaveLength(0);
    });
  });

  // Spot-check pool (#2159 Phase 3)
  describe('sample pool (#2159 Phase 3)', () => {
    it('insertSampled writes a success row the LLM judge will skip', async () => {
      const { pool, queries } = makePool([{ id: '42' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const id = await repo.insertSampled({
        taskId: 't1', conversationId: 'email:th1', toolName: 'email-send', actionRisk: 'medium',
        summary: 'Emailed dana@example.com: "Re: Payment schedule"', signals: { firstContact: true },
      });
      expect(id).toBe(42);
      const params = queries[0]!.params;
      expect(params[4]).toBe('success');                     // outcome
      expect(params[9]).toBe('Emailed dana@example.com: "Re: Payment schedule"'); // description
      expect(params[11]).toBeNull();                         // competence_flag
      expect(params[14]).toBe('sample-pool');                // scored_by
      expect(JSON.parse(params[6] as string)).toEqual({ sample: { signals: { firstContact: true } } });
    });

    it('findSampleCandidates reads unsampled pool rows since a date', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const since = new Date('2026-10-12T00:00:00Z');
      await repo.findSampleCandidates(since, 200);
      expect(queries[0]!.sql).toContain("scored_by = 'sample-pool'");
      expect(queries[0]!.sql).toContain("payload->'sample'->>'sampledAt' IS NULL");
      expect(queries[0]!.params).toEqual([since, 200]);
    });

    it('insertSampled persists a small tool input on the row', async () => {
      const { pool, queries } = makePool([{ id: '43' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.insertSampled({
        taskId: 't1', toolName: 'ceo-inbox-archive', actionRisk: 'low',
        summary: 'Archive an email', signals: { triage: true }, input: { message_id: 'm-1' },
      });
      expect(JSON.parse(queries[0]!.params[6] as string)).toEqual({
        sample: { signals: { triage: true }, input: { message_id: 'm-1' } },
      });
    });

    it('insertSampled stores the email subject and sender under payload.sample.email', async () => {
      const { pool, queries } = makePool([{ id: '45' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.insertSampled({
        taskId: 't1', toolName: 'ceo-inbox-archive', actionRisk: 'low',
        summary: 'Archive an email: "Statement ready"', signals: { triage: true },
        email: { subject: 'Statement ready', from: 'Billing (billing@example.com)' },
      });
      expect(JSON.parse(queries[0]!.params[6] as string)).toEqual({
        sample: { signals: { triage: true }, email: { subject: 'Statement ready', from: 'Billing (billing@example.com)' } },
      });
    });

    it('insertSampled omits a tool input over 2000 characters of JSON', async () => {
      const { pool, queries } = makePool([{ id: '44' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.insertSampled({
        taskId: 't1', toolName: 'calendar-create-event', actionRisk: 'high',
        summary: 'Create a calendar event', signals: {}, input: { description: 'x'.repeat(2001) },
      });
      expect(JSON.parse(queries[0]!.params[6] as string)).toEqual({ sample: { signals: {} } });
    });

    it('markSampled stamps the ids and returns the count, and does nothing for an empty list', async () => {
      const { pool, queries } = makePool([], 2);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      expect(await repo.markSampled([], new Date('2026-10-19T12:00:00Z'))).toBe(0);
      expect(queries).toHaveLength(0);
      expect(await repo.markSampled([3, 4], new Date('2026-10-19T12:00:00Z'))).toBe(2);
      expect(queries[0]!.params).toEqual([[3, 4], '2026-10-19T12:00:00.000Z']);
    });

    it('markSampled stamps pool rows only, so its count means what the warning says', async () => {
      const { pool, queries } = makePool([], 1);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.markSampled([3], new Date('2026-10-19T12:00:00Z'));
      expect(queries[0]!.sql).toContain("outcome = 'success'");
      expect(queries[0]!.sql).toContain("scored_by IN ('sample-pool', 'principal')");
    });

    it('markSampled warns when fewer rows were stamped than asked for', async () => {
      const { pool } = makePool([], 1);
      const logger = createSilentLogger();
      const warn = vi.spyOn(logger, 'warn');
      const repo = new ActionLogRepo(pool, logger);
      expect(await repo.markSampled([3, 4], new Date('2026-10-19T12:00:00Z'))).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ requested: 2, updated: 1 });
    });

    it('recordPrincipalVerdict sets competence only, and only on pool rows', async () => {
      const { pool, queries } = makePool([{ id: '7' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      expect(await repo.recordPrincipalVerdict(7, false, 'that was a renewal notice')).toBe(true);
      expect(queries[0]!.sql).toContain("scored_by IN ('sample-pool', 'principal')");
      expect(queries[0]!.params).toEqual([7, 0, JSON.stringify({ good: false, reason: 'that was a renewal notice' })]);
    });

    it('recordPrincipalVerdict returns false when the id is not a pool row', async () => {
      const { pool } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      expect(await repo.recordPrincipalVerdict(8, true, null)).toBe(false);
    });

    it('countScored and findAllScored leave out expired rows', async () => {
      const { pool, queries } = makeSequentialPool([[{ count: '0' }], []]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.countScored();
      await repo.findAllScored();
      expect(queries[0]!.sql).toContain("outcome <> 'expired'");
      expect(queries[1]!.sql).toContain("outcome <> 'expired'");
    });

    it('findTerminalBetween reads newest first with a default limit of 1000', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const since = new Date('2026-10-18T00:00:00Z');
      const until = new Date('2026-10-19T00:00:00Z');
      await repo.findTerminalBetween(since, until);
      expect(queries[0]!.sql).toContain('ORDER BY created_at DESC');
      expect(queries[0]!.params[3]).toBe(1000);
    });

    it('maps ids to numbers', async () => {
      const { pool } = makePool([{ id: '9', parent_action_id: '4', task_id: 't', skill_name: 'x', action_risk: 'low', outcome: 'success', created_at: new Date().toISOString() }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.findSampleCandidates(new Date(0), 10);
      expect(rows[0]!.id).toBe(9);
      expect(rows[0]!.parentActionId).toBe(4);
    });
  });
});
