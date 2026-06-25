// woken-task-authorization.test.ts — integration coverage for the #1060 dedup scenario (#1125/#1126).
//
// The full chain against a real Postgres: a system-cron-filed review task (source='agent', so a
// DERIVED child, lineage='system') is heartbeat-woken; selectHeartbeatCandidates returns its
// lineage + derived flag; enqueueTaskWake persists both onto the wake row; the metadata the
// scheduler would fire is reconstructed from that row and fed to the REAL ExecutionLayer.
//
// Two authorization facts are asserted end-to-end:
//  - #1126 elevated gate: a woken (non-live) task NEVER satisfies an `elevated` skill, at ANY
//    score — system/agent/woken-principal lineage all fail the live-principal requirement.
//  - #1126 contact-merge (now `normal` + action_risk:'medium'): the dedup resolution. The woken
//    derived task is BLOCKED below the medium threshold (surface-and-confirm via ADR-018) and
//    auto-executes at/above it — the bypass ladder downgrades its system lineage to agent, so it
//    is governed purely by the autonomy score.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { selectHeartbeatCandidates } from '../../src/db/queries/tasks.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { makePrincipalOriginator } from '../../src/contacts/principal.js';
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

function makeManifest(
  name: string,
  sensitivity: 'normal' | 'elevated',
  action_risk: SkillManifest['action_risk'],
): SkillManifest {
  return {
    name, description: name, version: '1.0.0',
    sensitivity, action_risk, inputs: {}, outputs: {},
    permissions: [], secrets: [], timeout: 5000,
  };
}

/** Rebuild the agent.task metadata exactly as Scheduler.fireJob does from a persisted wake row.
 *  Mirrors fireJob precisely: the wakeContext marker is keyed on the `standing` envelope being
 *  PRESENT, not merely on the task-wake payload type. A wake_at self-defer job (#1153) carries a
 *  task-wake payload with NO standing, so it threads the originator but mints no wakeContext — i.e.
 *  it keeps its originator like a scheduler-create fire and is not subject to the bypass ladder. */
function metadataFromWakeRow(row: { originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }) {
  const standing = row.task_payload?.['type'] === 'task-wake'
    // Cast through `unknown` first per the repo's Record<string, unknown> narrowing rule (CLAUDE.md).
    ? (row.task_payload as unknown as { standing?: { derived?: boolean } }).standing
    : undefined;
  if (!row.originator && !standing) return undefined;
  const meta: Record<string, unknown> = {};
  if (row.originator) meta.originator = row.originator;
  if (standing) meta.wakeContext = makeWakeContext(standing.derived === true);
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

  // The principal contact id a console row's originator carries (#1127). Value is cosmetic for
  // the gate — only systemRole='principal' drives the bypass — but mirrors the real shape.
  const CONSOLE_PRINCIPAL_LINEAGE = makePrincipalOriginator('contact-principal', 'console');

  /** Seed a top-level console-created task: source='ceo' (NOT derived), principal lineage. */
  async function seedConsoleTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (agent_id, title, intent_anchor, status, progress, error_budget, owner,
          priority, source, source_agent_id, created_by, tags, updated_at, originator)
       VALUES ('coordinator',$1,'seeded','open','{}'::jsonb,'{}'::jsonb,'curia',50,'ceo',NULL,'console','{console}',
               now() - interval '10 hours', $2::jsonb)
       RETURNING id`,
      [`${PREFIX} console task`, JSON.stringify(CONSOLE_PRINCIPAL_LINEAGE)],
    );
    return rows[0]!.id;
  }

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

  it('contact-merge (now normal+medium) on a woken dedup task: surface-and-confirm below 70, auto at/above', async () => {
    const taskId = await seedReviewTask();
    const candidate = (await selectHeartbeatCandidates(pool, {
      eligibleAgents: ['contacts'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5,
    })).find((c) => c.id === taskId);
    // Guard the lookup explicitly (CodeAnt, #1156): a missing candidate means the seed/selection
    // path regressed — fail with a clear message rather than a bare non-null-assertion crash.
    if (!candidate) throw new Error(`heartbeat candidate not found for seeded task ${taskId}`);
    const { jobId } = await scheduler.enqueueTaskWake({
      taskId, agentId: candidate.agentId, runAt: new Date(),
      originator: candidate.originator, derived: candidate.derived,
    });
    const { rows } = await pool.query<{ originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }>(
      `SELECT originator, task_payload FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1); // guard before indexing (CodeAnt, #1156): no row → clear assertion failure
    const taskMetadata = metadataFromWakeRow(rows[0]!);

    const handler: SkillHandler = { execute: async () => ({ success: true, data: 'merged' }) };

    // contact-merge is now `normal` + action_risk:'medium' (#1126). The wake's system lineage is
    // downgraded to agent by the ladder (derived child below posture D), so the autonomy score
    // alone governs it: below the medium threshold (70) → surface-and-confirm; at/above → auto.
    const registryLow = new SkillRegistry();
    registryLow.register(makeManifest('contact-merge', 'normal', 'medium'), handler);
    const blocked = await new ExecutionLayer(registryLow, logger, { autonomyService: makeAutonomyService(65) })
      .invoke('contact-merge', {}, undefined, { taskMetadata });
    expect(blocked.success).toBe(false); // 65 < 70 → ADR-018 surface-and-confirm

    const registryHigh = new SkillRegistry();
    registryHigh.register(makeManifest('contact-merge', 'normal', 'medium'), handler);
    const allowed = await new ExecutionLayer(registryHigh, logger, { autonomyService: makeAutonomyService(75) })
      .invoke('contact-merge', {}, undefined, { taskMetadata });
    expect(allowed.success).toBe(true); // 75 >= 70 → auto-merge
  });

  it('a principal-bypass action initiated from a console-created task behaves as principal-originated (#1127)', async () => {
    // The console is a principal-only surface, so a task created there carries principal lineage
    // (channel='console'). When the heartbeat later wakes this top-level, non-derived task, the
    // ladder keeps principal standing at posture B (70-89), so its EFFECTIVE standing is principal
    // — and the autonomy gate's principal-bypass fires for a normal skill that the raw score alone
    // would block. This is the end-to-end proof that console rows are not stranded propose-only.
    const taskId = await seedConsoleTask();

    const candidate = (await selectHeartbeatCandidates(pool, {
      eligibleAgents: ['coordinator'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5,
    })).find((c) => c.id === taskId);
    if (!candidate) throw new Error(`heartbeat candidate not found for seeded console task ${taskId}`);
    // A console task is top-level principal work, not an agent-spawned child → not derived.
    expect(candidate.originator).toEqual(CONSOLE_PRINCIPAL_LINEAGE);
    expect(candidate.derived).toBe(false);

    const { jobId } = await scheduler.enqueueTaskWake({
      taskId, agentId: candidate.agentId, runAt: new Date(),
      originator: candidate.originator, derived: candidate.derived,
    });
    const { rows } = await pool.query<{ originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }>(
      `SELECT originator, task_payload FROM scheduled_jobs WHERE id = $1`, [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.originator).toEqual(CONSOLE_PRINCIPAL_LINEAGE);
    const taskMetadata = metadataFromWakeRow(rows[0]!);

    const handler: SkillHandler = { execute: async () => ({ success: true, data: 'acted as principal' }) };

    // A `normal` skill with action_risk:'critical' (min score 90). At score 75 a non-principal task
    // is blocked by Gate B; the console task's retained principal standing bypasses gates A/B/C.
    const registry = new SkillRegistry();
    registry.register(makeManifest('commit-funds', 'normal', 'critical'), handler);
    const allowed = await new ExecutionLayer(registry, logger, { autonomyService: makeAutonomyService(75) })
      .invoke('commit-funds', {}, undefined, { taskMetadata });
    expect(allowed.success).toBe(true); // principal-bypass fired despite score 75 < 90

    // Control: the SAME wake metadata but with agent lineage gets no bypass and is blocked at 75.
    const agentMetadata = {
      originator: { contactId: 'a', systemRole: 'agent', channel: 'console', initiatedAt: CONSOLE_PRINCIPAL_LINEAGE.initiatedAt, tier: null },
      wakeContext: makeWakeContext(false),
    };
    const registryControl = new SkillRegistry();
    registryControl.register(makeManifest('commit-funds', 'normal', 'critical'), handler);
    const blocked = await new ExecutionLayer(registryControl, logger, { autonomyService: makeAutonomyService(75) })
      .invoke('commit-funds', {}, undefined, { taskMetadata: agentMetadata });
    expect(blocked.success).toBe(false); // no principal lineage → Gate B blocks (75 < 90)
  });

  it('the #1126 elevated gate rejects a woken system-lineage task at ANY score (never a live turn)', async () => {
    const taskId = await seedReviewTask();
    const candidate = (await selectHeartbeatCandidates(pool, {
      eligibleAgents: ['contacts'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5,
    })).find((c) => c.id === taskId);
    // Guard the lookup explicitly (CodeAnt, #1156): a missing candidate means the seed/selection
    // path regressed — fail with a clear message rather than a bare non-null-assertion crash.
    if (!candidate) throw new Error(`heartbeat candidate not found for seeded task ${taskId}`);
    const { jobId } = await scheduler.enqueueTaskWake({
      taskId, agentId: candidate.agentId, runAt: new Date(),
      originator: candidate.originator, derived: candidate.derived,
    });
    const { rows } = await pool.query<{ originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }>(
      `SELECT originator, task_payload FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1); // guard before indexing (CodeAnt, #1156): no row → clear assertion failure
    const taskMetadata = metadataFromWakeRow(rows[0]!);
    const handler: SkillHandler = { execute: async () => ({ success: true, data: 'should not run' }) };

    // Even at score 90 (posture D, system lineage retained as standing for the autonomy ladder),
    // an `elevated` skill is blocked: the gate now requires a LIVE principal turn, which a wake
    // never is. This is the self-approval-hole closure, end-to-end.
    for (const score of [65, 90]) {
      const registry = new SkillRegistry();
      registry.register(makeManifest('exercise-authority', 'elevated', 'none'), handler);
      const result = await new ExecutionLayer(registry, logger, { autonomyService: makeAutonomyService(score) })
        .invoke('exercise-authority', {}, undefined, { taskMetadata });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('live principal turn');
    }
  });

  it('a principal-lineage task self-deferring via wake_at keeps the autonomy bypass (no ladder), but elevated stays blocked (#1153)', async () => {
    // The actual self-deferral path: TaskRepo mints the wake_at wake job. Unlike a heartbeat wake,
    // it carries the task's originator but NO `standing` envelope — the time was pre-chosen, so the
    // fire keeps the originator (like scheduler-create) and is not laddered.
    const repo = new TaskRepo(
      pool,
      { publish: async () => {}, subscribe: () => {} } as unknown as EventBus,
      logger as never,
      'UTC',
    );
    const task = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} wake_at self-defer`, source: 'ceo',
      originator: CONSOLE_PRINCIPAL_LINEAGE, wakeAt: new Date(Date.now() + 3_600_000),
    });

    const { rows } = await pool.query<{ originator: Record<string, unknown> | null; task_payload: Record<string, unknown> }>(
      `SELECT originator, task_payload FROM scheduled_jobs WHERE task_id = $1`, [task.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.originator).toEqual(CONSOLE_PRINCIPAL_LINEAGE);
    expect(rows[0]!.task_payload).toEqual({ type: 'task-wake' }); // no standing envelope

    const taskMetadata = metadataFromWakeRow(rows[0]!);
    // Originator threaded; no wakeContext (so computeEffectiveTaskMetadata applies no ladder).
    expect(taskMetadata).toBeDefined();
    expect(taskMetadata).not.toHaveProperty('wakeContext');

    const handler: SkillHandler = { execute: async () => ({ success: true, data: 'acted as principal' }) };

    // A `normal` + action_risk:'critical' skill (min score 90). At score 75 a non-principal task is
    // blocked by Gate B; the wake's retained principal standing bypasses it — proof the bypass is
    // intact on a self-deferral (the very asymmetry #1153 closes: heartbeat floors, wake_at keeps).
    const registry = new SkillRegistry();
    registry.register(makeManifest('commit-funds', 'normal', 'critical'), handler);
    const allowed = await new ExecutionLayer(registry, logger, { autonomyService: makeAutonomyService(75) })
      .invoke('commit-funds', {}, undefined, { taskMetadata });
    expect(allowed.success).toBe(true);

    // But a wake_at fire is NOT a live principal turn, so an `elevated` authority primitive stays
    // blocked at any score — a pre-chosen deferral resumes work, it must not exercise authority.
    const elevatedRegistry = new SkillRegistry();
    elevatedRegistry.register(makeManifest('exercise-authority', 'elevated', 'none'), handler);
    const blocked = await new ExecutionLayer(elevatedRegistry, logger, { autonomyService: makeAutonomyService(90) })
      .invoke('exercise-authority', {}, undefined, { taskMetadata });
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error).toContain('live principal turn');
  });
});
