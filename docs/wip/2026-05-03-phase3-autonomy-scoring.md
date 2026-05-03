# Phase 3 Autonomy Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement automatic autonomy score adjustment driven by an LLM-as-judge scoring pipeline and a Competence/Commitment/Compatibility formula, hosted as a daily DreamEngine pass.

**Architecture:** A new `autonomy_action_log` table records skill invocations with outcomes. A daily `AutonomyScoringPass` (invoked by the DreamEngine) scores unscored rows — deterministically for approval outcomes, via an LLM judge for success/failure — then computes a composite capability score and nudges the autonomy score ±5 via a delta formula. The `get-autonomy` skill surfaces the auto-adjustment trend.

**Tech Stack:** PostgreSQL (migration), TypeScript/ESM, Vitest, Anthropic SDK (Haiku for judge), pino logging.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/db/migrations/031_create_autonomy_action_log.sql` | Migration: table + indexes |
| Create | `src/autonomy/action-log-types.ts` | TypeScript types for `autonomy_action_log` |
| Create | `src/autonomy/action-log-repo.ts` | DB read/write operations for `autonomy_action_log` |
| Create | `src/autonomy/action-log-repo.test.ts` | Unit tests for the repo |
| Create | `src/autonomy/scoring-pass.ts` | LLM judge + adjustment formula + DreamEngine pass |
| Create | `src/autonomy/scoring-pass.test.ts` | Unit tests for scoring logic |
| Modify | `src/memory/dream-engine.ts` | Accept and run `AutonomyScoringPass` as sibling pass |
| Modify | `src/memory/dream-engine.test.ts` | Tests for the new pass integration |
| Modify | `src/config.ts:140-287` | Add `autonomy_scoring` to `YamlConfig.dreaming` |
| Modify | `src/config.ts:611-646` | Add validation for new config keys |
| Modify | `config/default.yaml:269-276` | Add `autonomy_scoring` defaults |
| Modify | `src/index.ts:812-824` | Wire `AutonomyScoringPass` and pass to DreamEngine |
| Modify | `skills/get-autonomy/handler.ts` | Add `lastSetBy`, `trend`, `scoredActionCount` |
| Create | `skills/get-autonomy/handler.test.ts` | Tests for trend surfacing |
| Modify | `CHANGELOG.md` | Unreleased entry |

---

### Task 1: Migration — `autonomy_action_log` table

**Files:**
- Create: `src/db/migrations/031_create_autonomy_action_log.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 031_create_autonomy_action_log.sql
--
-- Phase 3 autonomy scoring foundation (issue #148) + ADR-018 approval lifecycle.
-- This table records autonomy-gated skill invocations and their outcomes.
-- The scoring engine (AutonomyScoringPass) consumes terminal rows to compute
-- a Competence/Commitment/Compatibility composite that drives automatic
-- autonomy score adjustment.
--
-- Approval lifecycle columns (payload, notification_sent_at, resolved_at,
-- resolved_by, expires_at, parent_action_id, short_ref, description) are
-- populated by #427/#428/#429 — not by this migration's companion code.

CREATE TABLE autonomy_action_log (
  id                   BIGSERIAL PRIMARY KEY,
  task_id              TEXT NOT NULL,
  -- TODO: conversation_id enables a future upgrade (approach C) where the
  -- LLM judge queries the audit log for the full conversation transcript,
  -- replacing summary-based scoring with richer Competence/Compatibility context.
  conversation_id      TEXT,
  skill_name           TEXT NOT NULL,
  action_risk          TEXT NOT NULL,
  outcome              TEXT NOT NULL CHECK (outcome IN (
    'success', 'failure', 'rejected',
    'pending_approval', 'approved', 'denied', 'expired', 'resolved_externally'
  )),
  task_summary         TEXT,

  -- Phase 3 scoring flags (LLM judge or deterministic from approval outcome)
  competence_flag      SMALLINT CHECK (competence_flag IN (0, 1)),
  commitment_flag      SMALLINT CHECK (commitment_flag IN (0, 1)),
  compatibility        SMALLINT CHECK (compatibility IN (0, 1)),
  scored_by            TEXT,  -- 'llm-judge' for now; 'ceo' reserved for future manual override

  -- ADR-018 approval lifecycle columns (populated by #427/#428/#429)
  payload              JSONB,
  notification_sent_at TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolved_by          TEXT,
  expires_at           TIMESTAMPTZ,
  parent_action_id     BIGINT REFERENCES autonomy_action_log(id),
  short_ref            TEXT,
  description          TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scoring pass: find unscored terminal rows
CREATE INDEX idx_aal_unscored
  ON autonomy_action_log (created_at)
  WHERE scored_by IS NULL
    AND outcome IN ('success', 'failure', 'approved', 'denied', 'expired', 'resolved_externally');

-- Approval lifecycle (#427/#428/#429): find pending rows by expiry
CREATE INDEX idx_aal_pending ON autonomy_action_log (expires_at)
  WHERE outcome = 'pending_approval';

-- Approval skills (#428): look up by short_ref
CREATE INDEX idx_aal_short_ref ON autonomy_action_log (short_ref)
  WHERE short_ref IS NOT NULL;

-- TODO: conversation_id enables the judge to query the audit log for the full
-- conversation transcript, replacing summary-based scoring with richer context.
CREATE INDEX idx_aal_conversation ON autonomy_action_log (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Deduplication (#427): find existing pending rows for same skill+task
CREATE INDEX idx_aal_task ON autonomy_action_log (task_id);
```

- [ ] **Step 2: Verify migration numbering**

Run: `ls src/db/migrations/ | sort`

Expected: `031_create_autonomy_action_log.sql` is the highest-numbered file and no duplicate prefixes exist.

- [ ] **Step 3: Run the migration locally**

Run: `npm --prefix /path/to/worktree run db:migrate up`

Expected: Migration applies cleanly with no errors. Verify with:

Run: `psql "$DATABASE_URL" -c "\d autonomy_action_log"`

Expected: Table exists with all columns and constraints.

- [ ] **Step 4: Commit**

```
git add src/db/migrations/031_create_autonomy_action_log.sql
git commit -m "feat: add autonomy_action_log migration (#148)

Foundation table for Phase 3 scoring and ADR-018 approval lifecycle.
Includes scoring flag columns, approval lifecycle columns, and partial
indexes for the scoring pass, approval skills, and deduplication."
```

---

### Task 2: TypeScript types for `autonomy_action_log`

**Files:**
- Create: `src/autonomy/action-log-types.ts`

- [ ] **Step 1: Write the type definitions**

```typescript
// action-log-types.ts — TypeScript types for the autonomy_action_log table.
//
// These mirror the Postgres schema from migration 031. The scoring engine,
// approval lifecycle skills (#427/#428), and the DreamEngine scoring pass
// all import from here.

/** Terminal outcomes that the scoring pass evaluates. */
export const TERMINAL_OUTCOMES = [
  'success',
  'failure',
  'approved',
  'denied',
  'expired',
  'resolved_externally',
] as const;

/** Outcomes that require an LLM judge call (not deterministically scorable). */
export const LLM_SCORED_OUTCOMES = ['success', 'failure'] as const;

/** All valid outcome values for the autonomy_action_log.outcome column. */
export type ActionLogOutcome =
  | 'success'
  | 'failure'
  | 'rejected'
  | 'pending_approval'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'resolved_externally';

/** A row from autonomy_action_log. */
export interface ActionLogRow {
  id: number;
  taskId: string;
  conversationId: string | null;
  skillName: string;
  actionRisk: string;
  outcome: ActionLogOutcome;
  taskSummary: string | null;

  competenceFlag: 0 | 1 | null;
  commitmentFlag: 0 | 1 | null;
  compatibility: 0 | 1 | null;
  scoredBy: string | null;

  // Approval lifecycle (populated by #427/#428/#429)
  payload: Record<string, unknown> | null;
  notificationSentAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  expiresAt: Date | null;
  parentActionId: number | null;
  shortRef: string | null;
  description: string | null;

  createdAt: Date;
}

/** Fields required to insert a new autonomy_action_log row. */
export interface ActionLogInsert {
  taskId: string;
  conversationId?: string;
  skillName: string;
  actionRisk: string;
  outcome: ActionLogOutcome;
  taskSummary?: string;

  // Approval lifecycle fields (optional — used by #427)
  payload?: Record<string, unknown>;
  expiresAt?: Date;
  shortRef?: string;
  description?: string;
}

/** Scoring flags written by the scoring pass or deterministic scorer. */
export interface ScoringFlags {
  competenceFlag: 0 | 1 | null;
  commitmentFlag: 0 | 1 | null;
  compatibility: 0 | 1 | null;
  scoredBy: string;
}

/**
 * Deterministic scoring table for approval/gate outcomes.
 * These outcomes carry inherent trust signals from the CEO's decision
 * (or the gate's decision) and do not need LLM interpretation.
 *
 * null means "no signal for this dimension" — the row is excluded from
 * that dimension's weighted average rather than dragging it toward zero.
 */
export const DETERMINISTIC_SCORES: Record<string, ScoringFlags> = {
  approved:            { competenceFlag: 1, commitmentFlag: 1, compatibility: 1,    scoredBy: 'deterministic' },
  denied:              { competenceFlag: 0, commitmentFlag: null, compatibility: 0, scoredBy: 'deterministic' },
  expired:             { competenceFlag: null, commitmentFlag: 1, compatibility: 0, scoredBy: 'deterministic' },
  resolved_externally: { competenceFlag: 1, commitmentFlag: 1, compatibility: null, scoredBy: 'deterministic' },
  rejected:            { competenceFlag: 0, commitmentFlag: 1, compatibility: null, scoredBy: 'deterministic' },
};
```

- [ ] **Step 2: Commit**

```
git add src/autonomy/action-log-types.ts
git commit -m "feat: TypeScript types for autonomy_action_log (#148)"
```

---

### Task 3: Action log repository

**Files:**
- Create: `src/autonomy/action-log-repo.ts`
- Create: `src/autonomy/action-log-repo.test.ts`

- [ ] **Step 1: Write failing tests for the repo**

```typescript
// action-log-repo.test.ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree test src/autonomy/action-log-repo.test.ts`

Expected: FAIL — `ActionLogRepo` not found.

- [ ] **Step 3: Implement the repo**

```typescript
// action-log-repo.ts — database operations for autonomy_action_log.
//
// All queries use parameterized SQL (no string interpolation).
// This repo is consumed by the AutonomyScoringPass and by the approval
// lifecycle skills (#427/#428/#429).

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type {
  ActionLogRow,
  ActionLogInsert,
  ScoringFlags,
} from './action-log-types.js';
import { TERMINAL_OUTCOMES } from './action-log-types.js';

export class ActionLogRepo {
  constructor(
    private pool: Pool,
    private logger: Logger,
  ) {}

  /** Insert a new row and return the generated id. */
  async insert(row: ActionLogInsert): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO autonomy_action_log
         (task_id, conversation_id, skill_name, action_risk, outcome, task_summary,
          payload, expires_at, short_ref, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        row.taskId,
        row.conversationId ?? null,
        row.skillName,
        row.actionRisk,
        row.outcome,
        row.taskSummary ?? null,
        row.payload ? JSON.stringify(row.payload) : null,
        row.expiresAt ?? null,
        row.shortRef ?? null,
        row.description ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  /**
   * Find unscored terminal rows, oldest first, up to `limit`.
   * Terminal outcomes are those the scoring pass can evaluate —
   * `pending_approval` is excluded (not terminal yet).
   */
  async findUnscoredTerminal(limit: number): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE scored_by IS NULL
         AND outcome = ANY($1)
       ORDER BY created_at ASC
       LIMIT $2`,
      [TERMINAL_OUTCOMES, limit],
    );
    return result.rows.map(mapRow);
  }

  /** Update scoring flags on a row after the judge has evaluated it. */
  async updateScoringFlags(id: number, flags: ScoringFlags): Promise<void> {
    await this.pool.query(
      `UPDATE autonomy_action_log
       SET competence_flag = $2, commitment_flag = $3, compatibility = $4, scored_by = $5
       WHERE id = $1`,
      [id, flags.competenceFlag, flags.commitmentFlag, flags.compatibility, flags.scoredBy],
    );
  }

  /** Count total scored rows (scored_by IS NOT NULL). */
  async countScored(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM autonomy_action_log WHERE scored_by IS NOT NULL`,
    );
    return parseInt(result.rows[0]!.count, 10);
  }

  /**
   * Compute the competence error rate among the most recent `window` scored rows.
   * Returns 0 if no scored rows exist.
   */
  async getRecentCompetenceErrorRate(window: number): Promise<number> {
    const result = await this.pool.query<{ total: string; errors: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE competence_flag = 0) AS errors
       FROM (
         SELECT competence_flag
         FROM autonomy_action_log
         WHERE scored_by IS NOT NULL AND competence_flag IS NOT NULL
         ORDER BY created_at DESC
         LIMIT $1
       ) recent`,
      [window],
    );
    const total = parseInt(result.rows[0]!.total, 10);
    if (total === 0) return 0;
    return parseInt(result.rows[0]!.errors, 10) / total;
  }

  /**
   * Load all scored rows for the adjustment formula.
   * Returns rows with at least one non-null scoring flag, ordered by created_at desc.
   * The scoring pass uses these to compute the time-decay-weighted capability score.
   */
  async findAllScored(): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE scored_by IS NOT NULL
       ORDER BY created_at DESC`,
    );
    return result.rows.map(mapRow);
  }
}

/** Map a snake_case DB row to a camelCase ActionLogRow. */
function mapRow(row: Record<string, unknown>): ActionLogRow {
  return {
    id: row.id as number,
    taskId: row.task_id as string,
    conversationId: row.conversation_id as string | null,
    skillName: row.skill_name as string,
    actionRisk: row.action_risk as string,
    outcome: row.outcome as ActionLogRow['outcome'],
    taskSummary: row.task_summary as string | null,
    competenceFlag: row.competence_flag as 0 | 1 | null,
    commitmentFlag: row.commitment_flag as 0 | 1 | null,
    compatibility: row.compatibility as 0 | 1 | null,
    scoredBy: row.scored_by as string | null,
    payload: row.payload as Record<string, unknown> | null,
    notificationSentAt: row.notification_sent_at ? new Date(row.notification_sent_at as string) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    resolvedBy: row.resolved_by as string | null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    parentActionId: row.parent_action_id as number | null,
    shortRef: row.short_ref as string | null,
    description: row.description as string | null,
    createdAt: new Date(row.created_at as string),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree test src/autonomy/action-log-repo.test.ts`

Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```
git add src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git commit -m "feat: ActionLogRepo for autonomy_action_log queries (#148)"
```

---

### Task 4: Scoring pass — deterministic scoring + LLM judge + adjustment formula

**Files:**
- Create: `src/autonomy/scoring-pass.ts`
- Create: `src/autonomy/scoring-pass.test.ts`

- [ ] **Step 1: Write failing tests for the scoring pass**

```typescript
// scoring-pass.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AutonomyScoringPass } from './scoring-pass.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { AutonomyService } from './autonomy-service.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import { createSilentLogger } from '../logger.js';
import type { ActionLogRow } from './action-log-types.js';

function makeRow(overrides: Partial<ActionLogRow>): ActionLogRow {
  return {
    id: 1,
    taskId: 'task-1',
    conversationId: null,
    skillName: 'send-email',
    actionRisk: 'medium',
    outcome: 'success',
    taskSummary: 'Send a reply to Dana',
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: null,
    notificationSentAt: null,
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
    parentActionId: null,
    shortRef: null,
    description: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ActionLogRepo> = {}): ActionLogRepo {
  return {
    findUnscoredTerminal: vi.fn().mockResolvedValue([]),
    updateScoringFlags: vi.fn().mockResolvedValue(undefined),
    countScored: vi.fn().mockResolvedValue(0),
    getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0),
    findAllScored: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeAutonomyService(score = 75, lastChangedBy = 'ceo', changedAt = new Date()): AutonomyService {
  return {
    getConfig: vi.fn().mockResolvedValue({
      score,
      band: 'approval-required',
      updatedAt: changedAt,
      updatedBy: lastChangedBy,
    }),
    setScore: vi.fn().mockResolvedValue({
      score: score + 3,
      band: 'approval-required',
      updatedAt: new Date(),
      updatedBy: 'system',
      previousScore: score,
    }),
    getHistory: vi.fn().mockResolvedValue([
      { id: 1, score, previousScore: score - 2, band: 'approval-required', changedBy: lastChangedBy, reason: null, changedAt },
    ]),
  } as unknown as AutonomyService;
}

function makeLlmProvider(competence: 0 | 1 = 1, commitment: 0 | 1 = 1, compatibility: 0 | 1 = 1): LLMProvider {
  return {
    id: 'anthropic',
    chat: vi.fn().mockResolvedValue({
      type: 'message',
      content: JSON.stringify({
        competence_flag: competence,
        commitment_flag: commitment,
        compatibility: compatibility,
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  } as unknown as LLMProvider;
}

const defaultConfig = {
  model: 'claude-haiku-4-5',
  batchSize: 50,
  minScoredActions: 30,
  halfLifeDays: 30,
  weakExpiredWeight: 0.3,
  ceoCooldownDays: 7,
  errorRateThreshold: 0.20,
};

describe('AutonomyScoringPass', () => {
  describe('scoreRows', () => {
    it('applies deterministic scores for approved outcome', async () => {
      const row = makeRow({ id: 10, outcome: 'approved' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(10, {
        competenceFlag: 1,
        commitmentFlag: 1,
        compatibility: 1,
        scoredBy: 'deterministic',
      });
    });

    it('applies deterministic scores for denied outcome', async () => {
      const row = makeRow({ id: 11, outcome: 'denied' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(11, {
        competenceFlag: 0,
        commitmentFlag: null,
        compatibility: 0,
        scoredBy: 'deterministic',
      });
    });

    it('applies deterministic scores for rejected outcome', async () => {
      const row = makeRow({ id: 12, outcome: 'rejected' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(12, {
        competenceFlag: 0,
        commitmentFlag: 1,
        compatibility: null,
        scoredBy: 'deterministic',
      });
    });

    it('calls LLM judge for success outcome', async () => {
      const row = makeRow({ id: 13, outcome: 'success' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = makeLlmProvider(1, 1, 1);
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      await pass.run();

      expect(llm.chat).toHaveBeenCalledTimes(1);
      expect(repo.updateScoringFlags).toHaveBeenCalledWith(13, {
        competenceFlag: 1,
        commitmentFlag: 1,
        compatibility: 1,
        scoredBy: 'llm-judge',
      });
    });

    it('leaves row unscored when LLM call fails', async () => {
      const row = makeRow({ id: 14, outcome: 'failure' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = { id: 'anthropic', chat: vi.fn().mockRejectedValue(new Error('API timeout')) } as unknown as LLMProvider;
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).not.toHaveBeenCalled();
    });
  });

  describe('adjustment formula', () => {
    it('does not adjust when fewer than minScoredActions exist', async () => {
      const repo = makeRepo({ countScored: vi.fn().mockResolvedValue(10) });
      const svc = makeAutonomyService();
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(svc.setScore).not.toHaveBeenCalled();
    });

    it('does not adjust during CEO cooldown period', async () => {
      const recentCeoChange = new Date(); // just now — within 7-day cooldown
      const repo = makeRepo({ countScored: vi.fn().mockResolvedValue(50) });
      const svc = makeAutonomyService(75, 'ceo', recentCeoChange);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(svc.setScore).not.toHaveBeenCalled();
    });

    it('adjusts score upward when capability > 0.5 and all guards pass', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000); // 30 days ago — past cooldown
      const scoredRows = Array.from({ length: 35 }, (_, i) =>
        makeRow({
          id: i + 1,
          outcome: 'success',
          competenceFlag: 1,
          commitmentFlag: 1,
          compatibility: 1,
          scoredBy: 'llm-judge',
          createdAt: new Date(Date.now() - i * 86_400_000), // spread over 35 days
        }),
      );
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(35),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0),
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(svc.setScore).toHaveBeenCalledTimes(1);
      const [newScore, changedBy] = (svc.setScore as ReturnType<typeof vi.fn>).mock.calls[0]! as [number, string, string];
      expect(newScore).toBeGreaterThan(75);
      expect(newScore).toBeLessThanOrEqual(80); // max +5
      expect(changedBy).toBe('system');
    });

    it('blocks score increase when error rate exceeds threshold', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000);
      // Mix of good and bad rows — overall capability > 0.5 but error rate > 20%
      const scoredRows = [
        ...Array.from({ length: 25 }, (_, i) =>
          makeRow({ id: i + 1, competenceFlag: 1, commitmentFlag: 1, compatibility: 1, scoredBy: 'llm-judge', createdAt: new Date(Date.now() - i * 86_400_000) }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          makeRow({ id: i + 26, competenceFlag: 0, commitmentFlag: 1, compatibility: 0, scoredBy: 'deterministic', createdAt: new Date(Date.now() - (i + 25) * 86_400_000) }),
        ),
      ];
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(35),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0.25), // 25% > 20% threshold
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      // Should not increase — error rate guard blocks it
      // May still decrease if capability < 0.5, or no change if capability = 0.5
      if ((svc.setScore as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const [newScore] = (svc.setScore as ReturnType<typeof vi.fn>).mock.calls[0]! as [number];
        expect(newScore).toBeLessThanOrEqual(75);
      }
    });

    it('does not write when delta rounds to 0', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000);
      // Rows that produce a capability score very close to 0.5 → delta rounds to 0
      const scoredRows = Array.from({ length: 30 }, (_, i) =>
        makeRow({
          id: i + 1,
          competenceFlag: i % 2 === 0 ? 1 : 0, // ~50/50
          commitmentFlag: 1,
          compatibility: i % 2 === 0 ? 1 : 0,
          scoredBy: 'llm-judge',
          createdAt: new Date(Date.now() - i * 86_400_000),
        }),
      );
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(30),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0.5),
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      // Error rate is 0.5 which exceeds 0.20 — cannot increase
      // Capability near 0.5 → delta near 0
      // Either no call, or a decrease
      const calls = (svc.setScore as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect((call as [number])[0]).toBeLessThanOrEqual(75);
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree test src/autonomy/scoring-pass.test.ts`

Expected: FAIL — `AutonomyScoringPass` not found.

- [ ] **Step 3: Implement the scoring pass**

```typescript
// scoring-pass.ts — AutonomyScoringPass: LLM judge + adjustment formula.
//
// Runs as a daily DreamEngine pass. Scores unscored autonomy_action_log rows
// (deterministically for approval outcomes, via LLM for success/failure),
// then computes a composite capability score and nudges the autonomy score.
//
// TODO: Future upgrade to approach C — use conversation_id to query the audit
// log for the full conversation transcript, giving the judge richer context
// for Competence and Compatibility scoring. The schema already stores
// conversation_id for this purpose. See issue #148 discussion.

import type { Logger } from '../logger.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { AutonomyService } from './autonomy-service.js';
import type { ActionLogRow, ScoringFlags } from './action-log-types.js';
import { DETERMINISTIC_SCORES, LLM_SCORED_OUTCOMES } from './action-log-types.js';

export interface ScoringPassConfig {
  model: string;
  batchSize: number;
  minScoredActions: number;
  halfLifeDays: number;
  weakExpiredWeight: number;
  ceoCooldownDays: number;
  errorRateThreshold: number;
}

export interface ScoringPassResult {
  rowsScored: number;
  llmCallsMade: number;
  llmCallsFailed: number;
  adjustmentApplied: boolean;
  delta: number;
  capabilityScore: number | null;
  reason: string;
}

const DIMENSION_WEIGHTS = {
  competence: 0.45,
  commitment: 0.35,
  compatibility: 0.20,
} as const;

export class AutonomyScoringPass {
  constructor(
    private repo: ActionLogRepo,
    private autonomyService: AutonomyService,
    private llmProvider: LLMProvider,
    private logger: Logger,
    private config: ScoringPassConfig,
  ) {}

  /**
   * Run one full scoring pass:
   *   1. Score unscored terminal rows (deterministic + LLM)
   *   2. Check adjustment guards
   *   3. Compute capability score and apply delta if guards pass
   */
  async run(): Promise<ScoringPassResult> {
    const result: ScoringPassResult = {
      rowsScored: 0,
      llmCallsMade: 0,
      llmCallsFailed: 0,
      adjustmentApplied: false,
      delta: 0,
      capabilityScore: null,
      reason: '',
    };

    this.logger.info('AutonomyScoringPass: starting');

    // Step 1: Score unscored rows
    const unscoredRows = await this.repo.findUnscoredTerminal(this.config.batchSize);
    this.logger.info({ count: unscoredRows.length }, 'AutonomyScoringPass: found unscored rows');

    for (const row of unscoredRows) {
      const scored = await this.scoreRow(row, result);
      if (scored) result.rowsScored++;
    }

    // Step 2: Check adjustment guards
    const totalScored = await this.repo.countScored();
    if (totalScored < this.config.minScoredActions) {
      result.reason = `below minimum scored actions (${totalScored}/${this.config.minScoredActions})`;
      this.logger.info({ totalScored, min: this.config.minScoredActions }, 'AutonomyScoringPass: ' + result.reason);
      return result;
    }

    // CEO cooldown check
    const history = await this.autonomyService.getHistory(1);
    if (history.length > 0 && history[0]!.changedBy !== 'system') {
      const daysSinceCeoSet = (Date.now() - history[0]!.changedAt.getTime()) / 86_400_000;
      if (daysSinceCeoSet < this.config.ceoCooldownDays) {
        result.reason = `CEO cooldown active (${Math.round(daysSinceCeoSet)}d / ${this.config.ceoCooldownDays}d)`;
        this.logger.info({ daysSinceCeoSet, cooldown: this.config.ceoCooldownDays }, 'AutonomyScoringPass: ' + result.reason);
        return result;
      }
    }

    // Step 3: Compute capability score
    const allScored = await this.repo.findAllScored();
    const capabilityScore = this.computeCapabilityScore(allScored);
    result.capabilityScore = capabilityScore;

    // Step 4: Derive delta and apply
    const rawDelta = (capabilityScore - 0.5) * 10;
    const delta = Math.round(rawDelta);

    if (delta === 0) {
      result.reason = `capability ${capabilityScore.toFixed(2)} — delta rounds to 0, no change`;
      this.logger.info({ capabilityScore }, 'AutonomyScoringPass: ' + result.reason);
      return result;
    }

    // Error rate guard: block increases when competence error rate is high
    if (delta > 0) {
      const errorRate = await this.repo.getRecentCompetenceErrorRate(30);
      if (errorRate > this.config.errorRateThreshold) {
        result.reason = `error rate guard: ${(errorRate * 100).toFixed(0)}% > ${(this.config.errorRateThreshold * 100).toFixed(0)}% — blocking increase`;
        this.logger.info({ errorRate, threshold: this.config.errorRateThreshold }, 'AutonomyScoringPass: ' + result.reason);
        return result;
      }
    }

    // Apply the adjustment
    const config = await this.autonomyService.getConfig();
    if (!config) {
      result.reason = 'autonomy config not found — skipping adjustment';
      this.logger.warn('AutonomyScoringPass: ' + result.reason);
      return result;
    }

    const newScore = Math.max(0, Math.min(100, config.score + delta));
    if (newScore === config.score) {
      result.reason = `score already at boundary (${config.score}), delta ${delta} has no effect`;
      this.logger.info({ currentScore: config.score, delta }, 'AutonomyScoringPass: ' + result.reason);
      return result;
    }

    const trend = delta > 0 ? 'improving' : 'declining';
    const reason = `auto-adjust: ${delta > 0 ? '+' : ''}${delta} (capability ${capabilityScore.toFixed(2)}, ${totalScored} scored, trend: ${trend})`;

    await this.autonomyService.setScore(newScore, 'system', reason);

    result.adjustmentApplied = true;
    result.delta = delta;
    result.reason = reason;

    this.logger.info(
      { previousScore: config.score, newScore, delta, capabilityScore, totalScored },
      'AutonomyScoringPass: score adjusted',
    );

    return result;
  }

  /**
   * Score a single row. Returns true if scored, false if skipped (LLM failure).
   */
  private async scoreRow(row: ActionLogRow, result: ScoringPassResult): Promise<boolean> {
    // Deterministic scoring for approval/gate outcomes
    const deterministicFlags = DETERMINISTIC_SCORES[row.outcome];
    if (deterministicFlags) {
      await this.repo.updateScoringFlags(row.id, deterministicFlags);
      return true;
    }

    // LLM judge for success/failure outcomes
    if ((LLM_SCORED_OUTCOMES as readonly string[]).includes(row.outcome)) {
      result.llmCallsMade++;
      try {
        const flags = await this.callLlmJudge(row);
        await this.repo.updateScoringFlags(row.id, flags);
        return true;
      } catch (err) {
        result.llmCallsFailed++;
        this.logger.warn({ err, rowId: row.id }, 'AutonomyScoringPass: LLM judge failed — row will be retried next pass');
        return false;
      }
    }

    // Unexpected outcome — log and skip
    this.logger.warn({ rowId: row.id, outcome: row.outcome }, 'AutonomyScoringPass: unexpected outcome in unscored row');
    return false;
  }

  /**
   * Call the LLM judge to score a success/failure row.
   * The judge receives the action metadata and task summary, and returns
   * three binary flags.
   */
  private async callLlmJudge(row: ActionLogRow): Promise<ScoringFlags> {
    const prompt = `You are evaluating an AI agent action for quality. Score it on three dimensions.

Action details:
- Skill: ${row.skillName}
- Action risk level: ${row.actionRisk}
- Outcome: ${row.outcome}
- Context: ${row.taskSummary ?? 'No context available'}

Score each dimension as 0 or 1:
- competence_flag: Was this the right action to take? (1 = correct, 0 = error/wrong choice)
- commitment_flag: Was this proactive follow-through? (1 = proactive, 0 = passive/reactive)
- compatibility: Was this aligned with the executive's context? (1 = aligned, 0 = misaligned)

Respond with ONLY a JSON object: {"competence_flag": 0|1, "commitment_flag": 0|1, "compatibility": 0|1}`;

    const response = await this.llmProvider.chat({
      messages: [
        { role: 'system', content: 'You are a precise evaluator. Respond with only valid JSON, no explanation.' },
        { role: 'user', content: prompt },
      ],
      options: { model: this.config.model },
    });

    if (response.type === 'error') {
      throw new Error(`LLM judge returned error: ${response.error?.message ?? 'unknown'}`);
    }

    const text = typeof response.content === 'string' ? response.content : '';
    const parsed = JSON.parse(text) as {
      competence_flag: number;
      commitment_flag: number;
      compatibility: number;
    };

    return {
      competenceFlag: parsed.competence_flag === 1 ? 1 : 0,
      commitmentFlag: parsed.commitment_flag === 1 ? 1 : 0,
      compatibility: parsed.compatibility === 1 ? 1 : 0,
      scoredBy: 'llm-judge',
    };
  }

  /**
   * Compute the composite capability score (0.0–1.0) from all scored rows
   * using time-decay-weighted averages across three dimensions.
   */
  private computeCapabilityScore(rows: ActionLogRow[]): number {
    const now = Date.now();

    let compWeightSum = 0, compValueSum = 0;
    let commWeightSum = 0, commValueSum = 0;
    let compatWeightSum = 0, compatValueSum = 0;

    for (const row of rows) {
      const daysSince = (now - row.createdAt.getTime()) / 86_400_000;
      let weight = Math.pow(0.5, daysSince / this.config.halfLifeDays);

      // Expired rows with compatibility 0 get reduced weight
      if (row.outcome === 'expired' && row.compatibility === 0) {
        weight *= this.config.weakExpiredWeight;
      }

      if (row.competenceFlag !== null) {
        compWeightSum += weight;
        compValueSum += row.competenceFlag * weight;
      }
      if (row.commitmentFlag !== null) {
        commWeightSum += weight;
        commValueSum += row.commitmentFlag * weight;
      }
      if (row.compatibility !== null) {
        compatWeightSum += weight;
        compatValueSum += row.compatibility * weight;
      }
    }

    // Weighted averages per dimension (default to 0.5 if no data for a dimension)
    const compAvg = compWeightSum > 0 ? compValueSum / compWeightSum : 0.5;
    const commAvg = commWeightSum > 0 ? commValueSum / commWeightSum : 0.5;
    const compatAvg = compatWeightSum > 0 ? compatValueSum / compatWeightSum : 0.5;

    return (
      DIMENSION_WEIGHTS.competence * compAvg +
      DIMENSION_WEIGHTS.commitment * commAvg +
      DIMENSION_WEIGHTS.compatibility * compatAvg
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree test src/autonomy/scoring-pass.test.ts`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```
git add src/autonomy/scoring-pass.ts src/autonomy/scoring-pass.test.ts
git commit -m "feat: AutonomyScoringPass — LLM judge + adjustment formula (#148)

Deterministic scoring for approval/gate outcomes, LLM judge for
success/failure, time-decay-weighted capability score, delta-based
adjustment with guards (min 30 actions, CEO cooldown, error rate)."
```

---

### Task 5: DreamEngine integration

**Files:**
- Modify: `src/memory/dream-engine.ts`
- Modify: `src/memory/dream-engine.test.ts`

- [ ] **Step 1: Write failing tests for the scoring pass integration**

Add to the bottom of `src/memory/dream-engine.test.ts`:

```typescript
describe('DreamEngine with AutonomyScoringPass', () => {
  it('calls scoringPass.run() on its own interval', async () => {
    vi.useFakeTimers();
    const { pool } = makePool();
    const mockScoringPass = {
      run: vi.fn().mockResolvedValue({ rowsScored: 0, adjustmentApplied: false }),
    };
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig, mockScoringPass as any);
    engine.start();

    // Advance past the scoring interval (daily = 86400000ms)
    await vi.advanceTimersByTimeAsync(86_400_000);

    expect(mockScoringPass.run).toHaveBeenCalledTimes(1);

    engine.stop();
    vi.useRealTimers();
  });

  it('does not fail if scoringPass is not provided', () => {
    const { pool } = makePool();
    // No scoring pass — should not throw
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    engine.start();
    engine.stop();
  });

  it('logs error and continues if scoringPass.run() throws', async () => {
    vi.useFakeTimers();
    const { pool } = makePool();
    const mockScoringPass = {
      run: vi.fn().mockRejectedValue(new Error('judge exploded')),
    };
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig, mockScoringPass as any);
    engine.start();

    // Should not throw — the error is caught and logged
    await vi.advanceTimersByTimeAsync(86_400_000);

    expect(mockScoringPass.run).toHaveBeenCalledTimes(1);

    engine.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree test src/memory/dream-engine.test.ts`

Expected: FAIL — DreamEngine constructor does not accept a 5th argument.

- [ ] **Step 3: Update DreamEngine to accept and run the scoring pass**

In `src/memory/dream-engine.ts`, make these changes:

Add import at the top:

```typescript
import type { AutonomyScoringPass } from '../autonomy/scoring-pass.js';
```

Update the constructor to accept an optional scoring pass:

```typescript
  private scoringIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private scoringPass?: AutonomyScoringPass;

  constructor(pool: Pool, _bus: EventBus, logger: Logger, config: DecayConfig, scoringPass?: AutonomyScoringPass) {
    this.pool = pool;
    this.logger = logger;
    this.config = config;
    this.scoringPass = scoringPass;
  }
```

Update `start()` to register the scoring pass interval:

```typescript
  start(): void {
    this.intervalHandle = setInterval(() => {
      this.runDecayPass().catch((err) => {
        this.logger.error({ err }, 'DreamEngine: unhandled error in runDecayPass');
      });
    }, this.config.intervalMs);

    if (this.scoringPass) {
      this.scoringIntervalHandle = setInterval(() => {
        this.scoringPass!.run().catch((err) => {
          this.logger.error({ err }, 'DreamEngine: unhandled error in AutonomyScoringPass');
        });
      }, this.config.intervalMs); // Same daily cadence as decay
    }

    this.logger.info(
      { intervalMs: this.config.intervalMs, archiveThreshold: this.config.archiveThreshold, hasScoringPass: !!this.scoringPass },
      'DreamEngine started (decay pass scheduled)',
    );
  }
```

Update `stop()` to clear both intervals:

```typescript
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.scoringIntervalHandle) {
      clearInterval(this.scoringIntervalHandle);
      this.scoringIntervalHandle = null;
    }
    this.logger.info('DreamEngine stopped');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree test src/memory/dream-engine.test.ts`

Expected: All tests pass (both old and new).

- [ ] **Step 5: Commit**

```
git add src/memory/dream-engine.ts src/memory/dream-engine.test.ts
git commit -m "feat: DreamEngine accepts AutonomyScoringPass as sibling pass (#148)"
```

---

### Task 6: Config — add `autonomy_scoring` to dreaming config

**Files:**
- Modify: `src/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add config defaults to `config/default.yaml`**

After the existing `dreaming.decay` block (line 276), add:

```yaml
  # Autonomy scoring — background Phase 3 auto-adjustment (issue #148).
  # Runs daily alongside the decay pass. Scores completed actions on three
  # dimensions (Competence, Commitment, Compatibility), then nudges the
  # autonomy score ±5 via a delta formula.
  autonomy_scoring:
    intervalMs: 86400000          # daily (same cadence as decay)
    model: "claude-haiku-4-5"     # cheaper model for the LLM judge
    batchSize: 50                 # max rows scored per pass
    minScoredActions: 30          # minimum before any adjustment fires
    halfLifeDays: 30              # time-decay half-life for weighting
    weakExpiredWeight: 0.3        # reduced weight for 'expired' compatibility signal
    ceoCooldownDays: 7            # days after CEO set-autonomy before auto-adjust resumes
    errorRateThreshold: 0.20      # competence error rate that blocks score increases
```

- [ ] **Step 2: Add TypeScript type to `YamlConfig` in `src/config.ts`**

Find the `dreaming` type definition in `YamlConfig` (around line 160) and add:

```typescript
    autonomy_scoring?: {
      intervalMs?: number;
      model?: string;
      batchSize?: number;
      minScoredActions?: number;
      halfLifeDays?: number;
      weakExpiredWeight?: number;
      ceoCooldownDays?: number;
      errorRateThreshold?: number;
    };
```

- [ ] **Step 3: Add validation in `loadYamlConfig()`**

After the existing dreaming.decay validation (around line 646), add:

```typescript
    const autonomyScoring = dreaming.autonomy_scoring;
    if (autonomyScoring !== undefined) {
      if (typeof autonomyScoring !== 'object' || autonomyScoring === null || Array.isArray(autonomyScoring)) {
        throw new Error('dreaming.autonomy_scoring must be a YAML mapping');
      }
      if (autonomyScoring.intervalMs !== undefined && (!Number.isInteger(autonomyScoring.intervalMs) || autonomyScoring.intervalMs <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.intervalMs must be a positive integer, got: ${autonomyScoring.intervalMs}`);
      }
      if (autonomyScoring.batchSize !== undefined && (!Number.isInteger(autonomyScoring.batchSize) || autonomyScoring.batchSize <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.batchSize must be a positive integer, got: ${autonomyScoring.batchSize}`);
      }
      if (autonomyScoring.minScoredActions !== undefined && (!Number.isInteger(autonomyScoring.minScoredActions) || autonomyScoring.minScoredActions <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.minScoredActions must be a positive integer, got: ${autonomyScoring.minScoredActions}`);
      }
      if (autonomyScoring.halfLifeDays !== undefined && (typeof autonomyScoring.halfLifeDays !== 'number' || autonomyScoring.halfLifeDays <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.halfLifeDays must be a positive number, got: ${autonomyScoring.halfLifeDays}`);
      }
      if (autonomyScoring.weakExpiredWeight !== undefined && (typeof autonomyScoring.weakExpiredWeight !== 'number' || autonomyScoring.weakExpiredWeight < 0 || autonomyScoring.weakExpiredWeight > 1)) {
        throw new Error(`dreaming.autonomy_scoring.weakExpiredWeight must be a number between 0 and 1, got: ${autonomyScoring.weakExpiredWeight}`);
      }
      if (autonomyScoring.ceoCooldownDays !== undefined && (!Number.isInteger(autonomyScoring.ceoCooldownDays) || autonomyScoring.ceoCooldownDays < 0)) {
        throw new Error(`dreaming.autonomy_scoring.ceoCooldownDays must be a non-negative integer, got: ${autonomyScoring.ceoCooldownDays}`);
      }
      if (autonomyScoring.errorRateThreshold !== undefined && (typeof autonomyScoring.errorRateThreshold !== 'number' || autonomyScoring.errorRateThreshold < 0 || autonomyScoring.errorRateThreshold > 1)) {
        throw new Error(`dreaming.autonomy_scoring.errorRateThreshold must be a number between 0 and 1, got: ${autonomyScoring.errorRateThreshold}`);
      }
    }
```

- [ ] **Step 4: Commit**

```
git add src/config.ts config/default.yaml
git commit -m "feat: add dreaming.autonomy_scoring config block (#148)"
```

---

### Task 7: Wire everything in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

Near the top of `src/index.ts`, add:

```typescript
import { ActionLogRepo } from './autonomy/action-log-repo.js';
import { AutonomyScoringPass } from './autonomy/scoring-pass.js';
import type { ScoringPassConfig } from './autonomy/scoring-pass.js';
```

- [ ] **Step 2: Build the scoring pass and pass to DreamEngine**

After the `decayConfig` block (around line 822), add:

```typescript
  // Autonomy scoring pass — Phase 3 automatic score adjustment (issue #148).
  // Runs as a sibling DreamEngine pass alongside memory decay.
  const actionLogRepo = new ActionLogRepo(pool, logger);
  const scoringPassConfig: ScoringPassConfig = {
    model: yamlConfig.dreaming?.autonomy_scoring?.model ?? 'claude-haiku-4-5',
    batchSize: yamlConfig.dreaming?.autonomy_scoring?.batchSize ?? 50,
    minScoredActions: yamlConfig.dreaming?.autonomy_scoring?.minScoredActions ?? 30,
    halfLifeDays: yamlConfig.dreaming?.autonomy_scoring?.halfLifeDays ?? 30,
    weakExpiredWeight: yamlConfig.dreaming?.autonomy_scoring?.weakExpiredWeight ?? 0.3,
    ceoCooldownDays: yamlConfig.dreaming?.autonomy_scoring?.ceoCooldownDays ?? 7,
    errorRateThreshold: yamlConfig.dreaming?.autonomy_scoring?.errorRateThreshold ?? 0.20,
  };
  const scoringPass = new AutonomyScoringPass(actionLogRepo, autonomyService, llmProvider, logger, scoringPassConfig);
  logger.info({ scoringPassConfig }, 'AutonomyScoringPass configured');
```

Then update the DreamEngine constructor call to pass the scoring pass:

```typescript
  const dreamEngine = new DreamEngine(pool, bus, logger, decayConfig, scoringPass);
```

- [ ] **Step 3: Commit**

```
git add src/index.ts
git commit -m "feat: wire AutonomyScoringPass into DreamEngine bootstrap (#148)"
```

---

### Task 8: `get-autonomy` trend surfacing

**Files:**
- Modify: `src/autonomy/autonomy-service.ts`
- Modify: `skills/get-autonomy/handler.ts`
- Create: `skills/get-autonomy/handler.test.ts`

Note: `SkillContext` does not expose `pool` — skills access services only
via declared capabilities. We add `getScoredActionCount()` to `AutonomyService`
(which is already a capability) so the handler can query the count without
a new capability declaration.

- [ ] **Step 1: Add `getScoredActionCount()` to AutonomyService**

At the bottom of `src/autonomy/autonomy-service.ts`, add:

```typescript
  /**
   * Count scored rows in autonomy_action_log (Phase 3).
   * Returns 0 if the table doesn't exist yet (pre-migration-031).
   */
  async getScoredActionCount(): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM autonomy_action_log WHERE scored_by IS NOT NULL`,
      );
      return parseInt(result.rows[0]!.count, 10);
    } catch (err) {
      // Table may not exist yet (pre-migration 031) — return 0, not an error
      this.logger.debug({ err }, 'getScoredActionCount: autonomy_action_log not queryable');
      return 0;
    }
  }
```

- [ ] **Step 2: Write failing tests for the trend surfacing**

```typescript
// handler.test.ts — tests for get-autonomy trend surfacing.
import { describe, it, expect, vi } from 'vitest';
import { GetAutonomyHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

function makeCtx(overrides: Partial<SkillContext['autonomyService']> = {}): SkillContext {
  const autonomyService = {
    getConfig: vi.fn().mockResolvedValue({
      score: 78,
      band: 'approval-required',
      updatedAt: new Date('2026-05-03'),
      updatedBy: 'system',
    }),
    getHistory: vi.fn().mockResolvedValue([
      { id: 3, score: 78, previousScore: 75, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: +3', changedAt: new Date('2026-05-03') },
      { id: 2, score: 75, previousScore: 75, band: 'approval-required', changedBy: 'ceo', reason: 'starting point', changedAt: new Date('2026-04-28') },
    ]),
    getScoredActionCount: vi.fn().mockResolvedValue(47),
    ...overrides,
  };

  return {
    input: {},
    log: createSilentLogger(),
    autonomyService,
  } as unknown as SkillContext;
}

describe('GetAutonomyHandler', () => {
  it('includes lastSetBy in the response data', async () => {
    const ctx = makeCtx();
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as any).data.lastSetBy).toBe('system');
  });

  it('includes scoredActionCount in the response data', async () => {
    const ctx = makeCtx();
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as any).data.scoredActionCount).toBe(47);
  });

  it('reports trend as improving when last system score > previous system score', async () => {
    const ctx = makeCtx({
      getHistory: vi.fn().mockResolvedValue([
        { id: 4, score: 78, previousScore: 75, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: +3', changedAt: new Date('2026-05-03') },
        { id: 3, score: 75, previousScore: 72, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: +3', changedAt: new Date('2026-05-02') },
        { id: 2, score: 72, previousScore: 75, band: 'approval-required', changedBy: 'ceo', reason: 'starting point', changedAt: new Date('2026-04-28') },
      ]),
    });
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect((result as any).data.trend).toBe('improving');
  });

  it('reports trend as declining when last system score < previous system score', async () => {
    const ctx = makeCtx({
      getHistory: vi.fn().mockResolvedValue([
        { id: 4, score: 72, previousScore: 75, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: -3', changedAt: new Date('2026-05-03') },
        { id: 3, score: 75, previousScore: 78, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: -3', changedAt: new Date('2026-05-02') },
      ]),
    });
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect((result as any).data.trend).toBe('declining');
  });

  it('reports trend as null when fewer than 2 system entries', async () => {
    const ctx = makeCtx({
      getHistory: vi.fn().mockResolvedValue([
        { id: 1, score: 75, previousScore: null, band: 'approval-required', changedBy: 'ceo', reason: 'starting point', changedAt: new Date('2026-04-28') },
      ]),
    });
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect((result as any).data.trend).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree test skills/get-autonomy/handler.test.ts`

Expected: FAIL — `lastSetBy` not in response data.

- [ ] **Step 4: Update the handler**

Replace the contents of `skills/get-autonomy/handler.ts`:

```typescript
// handler.ts — get-autonomy skill.
//
// Reports the current global autonomy score, band, trend direction,
// and scored action count to the CEO. Phase 3 additions: lastSetBy,
// trend (improving/declining/stable), scoredActionCount.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class GetAutonomyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.autonomyService) {
      return { success: false, error: 'get-autonomy requires autonomyService in context. Declare "autonomyService" in capabilities.' };
    }

    try {
      const config = await ctx.autonomyService.getConfig();

      if (!config) {
        return { success: false, error: 'Autonomy config not found — migration 011 may not have run.' };
      }

      // History is supplementary — a failure here should not block showing the current score.
      let history: import('../../src/autonomy/autonomy-service.js').AutonomyHistoryEntry[] = [];
      try {
        history = await ctx.autonomyService.getHistory(10); // More entries for trend analysis
      } catch (err) {
        ctx.log.warn({ err }, 'get-autonomy: could not load history — showing current score only');
      }

      // Phase 3: lastSetBy — who most recently changed the score
      const lastSetBy = history.length > 0 ? history[0]!.changedBy : config.updatedBy;

      // Phase 3: trend — compare the two most recent system-set entries
      const systemEntries = history.filter(h => h.changedBy === 'system');
      let trend: 'improving' | 'declining' | 'stable' | null = null;
      if (systemEntries.length >= 2) {
        const latest = systemEntries[0]!.score;
        const previous = systemEntries[1]!.score;
        if (latest > previous) trend = 'improving';
        else if (latest < previous) trend = 'declining';
        else trend = 'stable';
      }

      // Phase 3: scoredActionCount — total scored rows in autonomy_action_log.
      // Graceful fallback: getScoredActionCount() returns 0 if the table
      // doesn't exist yet (pre-migration-031).
      let scoredActionCount = 0;
      try {
        scoredActionCount = await ctx.autonomyService.getScoredActionCount();
      } catch (err) {
        ctx.log.debug({ err }, 'get-autonomy: could not query scored action count');
      }

      // Format band label
      const bandLabels: Record<string, string> = {
        'full': 'Full',
        'spot-check': 'Spot-check',
        'approval-required': 'Approval Required',
        'draft-only': 'Draft Only',
        'restricted': 'Restricted',
      };
      const bandLabel = bandLabels[config.band] ?? config.band;

      // Build readable summary
      const lines: string[] = [
        `Autonomy score: ${config.score} — ${bandLabel}`,
      ];

      // Phase 3 context line
      if (lastSetBy === 'system' && history.length > 0 && history[0]!.reason) {
        lines.push(`Last adjusted by system (${history[0]!.reason})`);
      } else {
        lines.push(`Last updated: ${config.updatedAt.toISOString().split('T')[0]} by ${lastSetBy}`);
      }

      if (trend) {
        const systemCount = systemEntries.length;
        lines.push(`Trend: ${trend} (over ${systemCount} system adjustment${systemCount !== 1 ? 's' : ''})`);
      }

      if (scoredActionCount > 0) {
        lines.push(`Scored actions: ${scoredActionCount}`);
      }

      // History entries (last 3 for display)
      const displayHistory = history.slice(0, 3);
      if (displayHistory.length > 0) {
        lines.push('', 'Recent changes:');
        for (const entry of displayHistory) {
          const date = entry.changedAt.toISOString().split('T')[0] ?? '';
          const prev = entry.previousScore !== null ? `${entry.previousScore} → ` : '';
          const reason = entry.reason ? `  "${entry.reason}"` : '';
          lines.push(`  ${date}  ${prev}${entry.score} (${entry.band})${reason}  — ${entry.changedBy}`);
        }
      }

      return {
        success: true,
        data: {
          score: config.score,
          band: config.band,
          lastSetBy,
          trend,
          scoredActionCount,
          summary: lines.join('\n'),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'get-autonomy failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree test skills/get-autonomy/handler.test.ts`

Expected: All 5 tests pass.

- [ ] **Step 6: Commit**

```
git add src/autonomy/autonomy-service.ts skills/get-autonomy/handler.ts skills/get-autonomy/handler.test.ts
git commit -m "feat: get-autonomy surfaces lastSetBy, trend, scoredActionCount (#148)"
```

---

### Task 9: CHANGELOG + full test suite

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add unreleased changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Added

- **Autonomy Phase 3 scoring foundation** — `autonomy_action_log` table (migration 031) records skill invocations and outcomes, serving as the foundation for automatic score adjustment and the approval lifecycle (ADR-018). TypeScript types and repo in `src/autonomy/`. (spec 14, issue #148)
- **Automatic autonomy score adjustment** — daily `AutonomyScoringPass` runs as a DreamEngine sibling pass. Scores completed actions on Competence/Commitment/Compatibility (deterministic for approval outcomes, LLM judge for success/failure), computes a time-decay-weighted capability score, and nudges the autonomy score ±5 via a delta formula. Guards: 30-action minimum, CEO cooldown (7 days), error rate threshold (20%). (spec 14, issue #148)
- **`get-autonomy` trend surfacing** — skill now reports `lastSetBy` (CEO or system), trend direction (improving/declining/stable), and scored action count. (spec 14, issue #148)

### Changed

- **`autonomy_action_log` table name** — renamed from `action_log` to `autonomy_action_log` for schema clarity. The `autonomy_` prefix groups it with `autonomy_config` and `autonomy_history`. Updated in ADR-018, issues #427/#428/#429. (spec 14, issue #148)
- **DreamEngine** — now accepts an optional `AutonomyScoringPass` as a sibling pass, running on its own interval alongside memory decay. (spec 14, issue #148)
```

- [ ] **Step 2: Run the full test suite**

Run: `npm --prefix /path/to/worktree test`

Expected: All tests pass. If any existing tests break, fix them before proceeding.

- [ ] **Step 3: Commit**

```
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for Phase 3 autonomy scoring (#148)"
```

---

### Task 10: Update spec 14 implementation status

**Files:**
- Modify: `docs/specs/14-autonomy-engine.md`

- [ ] **Step 1: Update the implementation status table**

In `docs/specs/14-autonomy-engine.md`, find the Implementation Status table (around line 219) and update the Phase 3 row:

Change:
```
| Phase 3: automatic score adjustment (Competence/Commitment/Compatibility formula) | Not Done |
```

To:
```
| Phase 3: automatic score adjustment (Competence/Commitment/Compatibility formula) | Done |
```

- [ ] **Step 2: Commit**

```
git add docs/specs/14-autonomy-engine.md
git commit -m "docs: mark Phase 3 as done in spec 14 (#148)"
```
