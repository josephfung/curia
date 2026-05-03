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
});
