// action-log-repo.test.ts — unit tests for ActionLogRepo using a mock pool.
// All DB interaction is intercepted; no real Postgres connection is required.

import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { ActionLogRepo } from './action-log-repo.js';
import { createSilentLogger } from '../logger.js';

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

describe('ActionLogRepo', () => {
  describe('insert', () => {
    it('inserts a row and returns the id', async () => {
      const { pool, queries } = makePool([{ id: 42 }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const id = await repo.insert({
        taskId: 'task-1',
        conversationId: 'conv-1',
        skillName: 'calendar-create-event',
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
        skillName: 'calendar-create-event',
        actionRisk: 'high',
        outcome: 'success',
        parentActionId: 42,
      });
      expect(id).toBe(99);
      expect(queries[0]!.sql).toContain('parent_action_id');
      expect(queries[0]!.params).toContain(42);
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
      expect(rows[0]!.skillName).toBe('send-email');
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
      const { pool } = makePool([{ count: '47' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.countScored();
      expect(count).toBe(47);
    });
  });

  describe('getRecentCompetenceErrorRate', () => {
    it('returns the error rate from the last N scored rows', async () => {
      const { pool } = makePool([{ total: '30', errors: '8' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rate = await repo.getRecentCompetenceErrorRate(30);
      expect(rate).toBeCloseTo(8 / 30);
    });

    it('returns 0 when no scored rows exist', async () => {
      const { pool } = makePool([{ total: '0', errors: '0' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rate = await repo.getRecentCompetenceErrorRate(30);
      expect(rate).toBe(0);
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

  describe('countShortRefsForTask', () => {
    it('returns the count of short_ref rows for a task', async () => {
      const { pool } = makePool([{ count: '3' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.countShortRefsForTask('t1');
      expect(count).toBe(3);
    });

    it('returns 0 when no short_ref rows exist', async () => {
      const { pool } = makePool([{ count: '0' }]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.countShortRefsForTask('t1');
      expect(count).toBe(0);
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

      const result = await repo.linkPayload('email-1', { draftId: 'draft-abc', accountId: 'curia' });

      expect(result).toBe(true);
      expect(queries[0]!.sql).toContain('UPDATE');
      expect(queries[0]!.sql).toContain('short_ref');
      expect(queries[0]!.sql).toContain('jsonb');
      expect(queries[0]!.params).toContain('email-1');
    });

    it('returns false when no row matches the short_ref', async () => {
      const { pool } = makePool([]);  // empty result — rowCount = 0
      const repo = new ActionLogRepo(pool, createSilentLogger());

      const result = await repo.linkPayload('unknown-ref', { draftId: 'draft-xyz' });

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
});
