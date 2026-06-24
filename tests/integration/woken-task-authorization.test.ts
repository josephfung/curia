// woken-task-authorization.test.ts — integration coverage for the #1060 dedup scenario (#1125).
//
// The full chain against a real Postgres: a system-cron-filed review task (source='agent', so a
// DERIVED child, lineage='system') is heartbeat-woken; selectHeartbeatCandidates returns its
// lineage + derived flag; enqueueTaskWake persists both onto the wake row; the metadata the
// scheduler would fire is reconstructed from that row and fed to the REAL ExecutionLayer, which
// applies the bypass ladder: an elevated skill is BLOCKED below posture D (score < 90, downgraded
// to agent → surface-and-confirm) and ALLOWED at/above it (system standing retained).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { selectHeartbeatCandidates } from '../../src/db/queries/tasks.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { makeWakeContext } from '../../src/autonomy/effective-standing.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import type { SkillManifest, SkillHandler } from '../../src/skills/types.js';
import type { AutonomyService, AutonomyConfig } from '../../src/autonomy/autonomy-service.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'WokenAuthz Test';
const logger = pino({ level: 'silent' });

const SYSTEM_LINEAGE = {
  contactId: 'system', systemRole: 'system' as const, channel: 'declarative',
  initiatedAt: '2026-06-23T00:00:00.000Z', tier: null,
};

function makeAutonomyService(score: number): AutonomyService {
  const config: AutonomyConfig = { score, band: 'full', updatedAt: new Date('2026-06-23T00:00:00Z'), updatedBy: 'test' };
  return { getConfig: async () => config } as unknown as AutonomyService;
}

function elevatedManifest(): SkillManifest {
  return {
    name: 'contact-merge', description: 'merge two contacts', version: '1.0.0',
    sensitivity: 'elevated', action_risk: 'none', inputs: {}, outputs: {},
    permissions: [], secrets: [], timeout: 5000,
  };
}

/** Rebuild the agent.task metadata exactly as Scheduler.fireJob does from a persisted wake row. */
function metadataFromWakeRow(row: { originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }) {
  if (!row.originator) return undefined;
  const meta: Record<string, unknown> = { originator: row.originator };
  if (row.task_payload?.['type'] === 'task-wake') {
    const standing = (row.task_payload as { standing?: { derived?: boolean } }).standing;
    meta.wakeContext = makeWakeContext(standing?.derived === true);
  }
  return meta;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('woken-task authorization (#1060 dedup scenario)', () => {
  let pool: pg.Pool;
  let scheduler: SchedulerService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT originator FROM tasks LIMIT 0'); // fails loudly if migration 065 not applied
    const bus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;
    scheduler = new SchedulerService(pool, bus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  async function seedReviewTask(): Promise<string> {
    // Mirrors contact-find-duplicates: source='agent' (derived child), lineage='system' (the cron).
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (agent_id, title, intent_anchor, status, progress, error_budget, owner,
          priority, source, source_agent_id, created_by, tags, updated_at, originator)
       VALUES ('contacts',$1,'seeded','open','{}'::jsonb,'{}'::jsonb,'curia',50,'agent','contacts','test','{dedup}',
               now() - interval '10 hours', $2::jsonb)
       RETURNING id`,
      [`${PREFIX} review duplicate`, JSON.stringify(SYSTEM_LINEAGE)],
    );
    return rows[0]!.id;
  }

  it('persists lineage + derived through select → enqueue and the wake row round-trips', async () => {
    const taskId = await seedReviewTask();

    const candidates = await selectHeartbeatCandidates(pool, {
      eligibleAgents: ['coordinator', 'contacts'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5,
    });
    const candidate = candidates.find((c) => c.id === taskId);
    expect(candidate).toBeDefined();
    expect(candidate!.originator).toEqual(SYSTEM_LINEAGE);
    expect(candidate!.derived).toBe(true);

    const { jobId } = await scheduler.enqueueTaskWake({
      taskId, agentId: candidate!.agentId, runAt: new Date(),
      originator: candidate!.originator, derived: candidate!.derived,
    });

    const { rows } = await pool.query<{ originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }>(
      `SELECT originator, task_payload FROM scheduled_jobs WHERE id = $1`, [jobId],
    );
    expect(rows[0]!.originator).toEqual(SYSTEM_LINEAGE);
    expect(rows[0]!.task_payload).toMatchObject({ type: 'task-wake', standing: { derived: true } });
  });

  it('the woken derived task is BLOCKED below posture D and ALLOWED at it (surface-and-confirm)', async () => {
    const taskId = await seedReviewTask();
    const candidate = (await selectHeartbeatCandidates(pool, {
      eligibleAgents: ['contacts'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5,
    })).find((c) => c.id === taskId)!;
    const { jobId } = await scheduler.enqueueTaskWake({
      taskId, agentId: candidate.agentId, runAt: new Date(),
      originator: candidate.originator, derived: candidate.derived,
    });
    const { rows } = await pool.query<{ originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }>(
      `SELECT originator, task_payload FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    const taskMetadata = metadataFromWakeRow(rows[0]!);

    const handler: SkillHandler = { execute: async () => ({ success: true, data: 'merged' }) };

    // Score 85: derived child below posture D (90) → downgraded to agent → elevated gate blocks.
    const registry85 = new SkillRegistry();
    registry85.register(elevatedManifest(), handler);
    const blocked = await new ExecutionLayer(registry85, logger, { autonomyService: makeAutonomyService(85) })
      .invoke('contact-merge', {}, undefined, { taskMetadata });
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error).toContain('elevated privileges');

    // Score 90: posture D met → system standing retained → elevated gate satisfied.
    const registry90 = new SkillRegistry();
    registry90.register(elevatedManifest(), handler);
    const allowed = await new ExecutionLayer(registry90, logger, { autonomyService: makeAutonomyService(90) })
      .invoke('contact-merge', {}, undefined, { taskMetadata });
    expect(allowed.success).toBe(true);
  });
});
