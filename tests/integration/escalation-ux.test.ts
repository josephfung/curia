// escalation-ux.test.ts — richer escalation UX end-to-end for the planned-parent and delegation
// sources (#1267). The resumable-leaf source is covered by resumable-circuit-breaker.test.ts; this
// file closes the OTHER TWO producers so all three have a DB-level assertion that the escalated CEO
// row carries the structured progress.escalation block AND a non-empty last progress note — the
// field the daily digest reads, which was the whole point of #1267 (detail reaching the principal,
// not a bare backlog row).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import {
  escalateCircuitBreach,
  type ResumableCircuitState,
} from '../../src/agents/resumable-circuit-breaker.js';
import { buildDelegationEscalation, renderEscalation } from '../../src/agents/task-escalation.js';
import { TaskCreateHandler } from '../../skills/task-create/handler.js';
import type { ToolContext } from '../../src/skills/types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'EscalationUX Test';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`%${PREFIX}%`],
  );
  // Both the seed tasks and their escalated "Review:" CEO rows carry the prefix (the planned-parent
  // Review title embeds the parent title; the delegation Review title is seeded with the prefix).
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`%${PREFIX}%`]);
}

describeIf('Escalation UX — planned-parent + delegation (#1267)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let bus: EventBus;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup(pool);
    bus = new EventBus(logger as never);
    repo = new TaskRepo(pool, bus, logger as never, 'UTC');
  });

  it('planned-parent circuit breach: CEO row carries a planned_parent escalation (X-of-Y, no throughput) + non-empty note', async () => {
    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} quarterly rollup plan`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    await repo.updateTask(parent.id, { status: 'in_progress' }, 'coordinator');

    // A planned parent advances by child completions, not resumable units. total must equal
    // steps.length (plan-progress validation); done < total leaves it mid-flight.
    const planResult = await repo.setPlanBlock(parent.id, {
      steps: [
        { id: 'step-1', taskId: null },
        { id: 'step-2', taskId: null },
        { id: 'step-3', taskId: null },
        { id: 'step-4', taskId: null },
        { id: 'step-5', taskId: null },
      ],
      deliverableStepId: null,
      done: 2,
      total: 5,
      next: 'Advance the frontier',
    }, 'coordinator');
    expect('task' in planResult).toBe(true);

    const reloaded = await repo.getTask(parent.id);
    expect(reloaded).toBeTruthy();

    // The planned-parent frontier circuit breaker calls escalateCircuitBreach with the parent row;
    // driving it directly here is the same seam (handlePlanFrontierWakeForCircuitBreaker).
    const breachState: ResumableCircuitState = {
      stallCount: 3,
      iterationCount: 6,
      startedAt: new Date().toISOString(),
      totalCostUsd: 4.2,
      lastProgress: { done: 2, cursor: null },
    };
    await escalateCircuitBreach({
      pool,
      bus,
      taskRepo: repo,
      logger: logger as never,
      task: reloaded!,
      breach: { reason: 'stall_limit', message: 'no progress across 3 frontier wakes', state: breachState },
      agentId: 'coordinator',
    });

    // The parent itself is failed and owned by the specialist — it is NOT the principal's carrier.
    const afterParent = await repo.getTask(parent.id);
    expect(afterParent?.status).toBe('failed');

    // The CEO backlog row is the digest carrier.
    const { rows: ceoRows } = await pool.query<{ progress: Record<string, unknown> }>(
      `SELECT progress FROM tasks
         WHERE owner = 'ceo' AND tags @> ARRAY['resumable-circuit-breach']::text[]
           AND title LIKE $1`,
      [`Review:%${PREFIX}%`],
    );
    expect(ceoRows).toHaveLength(1);

    const progress = ceoRows[0]!.progress;
    const escalation = progress.escalation as Record<string, unknown> | undefined;
    expect(escalation).toBeTruthy();
    expect(escalation!.source).toBe('planned_parent');
    expect(escalation!.failureMode).toBe('stalled');
    // X-of-Y comes from the plan rollup; planned parents carry no per-unit throughput/ETA.
    expect(escalation!.progress).toEqual({ done: 2, total: 5 });
    expect(escalation!.throughput).toBeUndefined();
    expect(Array.isArray(escalation!.suggestedActions)).toBe(true);
    expect((escalation!.suggestedActions as unknown[]).length).toBeGreaterThan(0);

    const notes = progress.notes as Array<{ note: string }> | undefined;
    const lastNote = notes && notes.length > 0 ? notes[notes.length - 1]!.note : '';
    expect(lastNote.length).toBeGreaterThan(0);
    expect(lastNote).toContain('2 of 5');
    expect(lastNote.toLowerCase()).toContain('stall');
  });

  it('delegation failure: task-create seeds a delegation escalation + non-empty note on the CEO row', async () => {
    // Mirror escalateDelegationFailure's payload construction, then drive the real task-create
    // handler against the DB — the seam it invokes via executionLayer.invoke('task-create', …).
    const escalation = buildDelegationEscalation({
      agent: 'research-analyst',
      reason: 'blocked',
      retryable: false,
      message: 'waiting on the CFO to approve the budget',
      task: 'Compile Q3 vendor spend',
    });
    const rendered = renderEscalation(escalation);

    const ctx = {
      input: {
        title: `Review: ${PREFIX} research-analyst is blocked on a person`,
        description: [rendered.description, '', 'Original delegated task:', 'Compile Q3 vendor spend'].join('\n'),
        owner: 'ceo',
        source: 'coordinator',
        tags: ['delegation-failure', 'research-analyst', escalation.failureMode],
        progress_note: rendered.progressNote,
        escalation_json: JSON.stringify(escalation),
      },
      secret: () => 'unused',
      log: logger,
      agentId: 'coordinator',
      timezone: 'UTC',
      taskRepo: repo,
    } as unknown as ToolContext;

    const result = await new TaskCreateHandler().execute(ctx);
    expect(result.success).toBe(true);
    const taskId = (result as { success: true; data: { task_id: string } }).data.task_id;

    const { rows } = await pool.query<{ owner: string; progress: Record<string, unknown> }>(
      `SELECT owner, progress FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe('ceo');

    const progress = rows[0]!.progress;
    const stored = progress.escalation as Record<string, unknown> | undefined;
    expect(stored).toBeTruthy();
    expect(stored!.source).toBe('delegation');
    expect(stored!.failureMode).toBe('blocked_on_human');
    // A delegation failure is a single attempt — no tracked X-of-Y progress or throughput.
    expect(stored!.progress).toBeUndefined();
    expect(stored!.throughput).toBeUndefined();
    expect((stored!.suggestedActions as unknown[]).length).toBeGreaterThan(0);

    const notes = progress.notes as Array<{ note: string }> | undefined;
    const lastNote = notes && notes.length > 0 ? notes[notes.length - 1]!.note : '';
    expect(lastNote.length).toBeGreaterThan(0);
    expect(lastNote).toContain('Blocked on a person');
    expect(lastNote).toContain('research-analyst');
  });
});
