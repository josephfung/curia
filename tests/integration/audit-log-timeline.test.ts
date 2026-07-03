import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('audit-log timeline query', () => {
  let pool: pg.Pool;
  let repo: AuditLogRepo;
  const logger = createSilentLogger();
  const sourceLayer = 'test-audit-timeline';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new AuditLogRepo(pool, logger);
    await pool.query('SELECT 1 FROM audit_log LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedRow(opts: {
    timestamp: string;
    eventType?: string;
    conversationId?: string | null;
    taskId?: string;
    parentEventId?: string | null;
  }): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (opts.taskId) {
      payload.taskId = opts.taskId;
    }
    const result = await pool.query<{ id: string }>(
      `INSERT INTO audit_log (
         timestamp, event_type, source_layer, source_id, payload,
         conversation_id, parent_event_id
       )
       VALUES ($1, $2, $3, 'test-agent', $4::jsonb, $5, $6)
       RETURNING id`,
      [
        new Date(opts.timestamp),
        opts.eventType ?? 'agent.task',
        sourceLayer,
        JSON.stringify(payload),
        opts.conversationId ?? null,
        opts.parentEventId ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  it('returns events ordered by timestamp ASC', async () => {
    const t1 = '2026-07-01T10:00:00.000Z';
    const t2 = '2026-07-01T10:01:00.000Z';
    const t3 = '2026-07-01T10:02:00.000Z';
    await seedRow({ timestamp: t3 });
    await seedRow({ timestamp: t1 });
    await seedRow({ timestamp: t2 });

    const rows = await repo.findTimeline({
      from: new Date('2026-07-01T09:59:00.000Z'),
      to: new Date('2026-07-01T10:03:00.000Z'),
    });

    const ours = rows.filter((r) => r.sourceLayer === sourceLayer);
    expect(ours.length).toBeGreaterThanOrEqual(3);
    const timestamps = ours.map((r) => r.timestamp.toISOString());
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);
  });

  it('filters by from/to window', async () => {
    const inside = '2026-07-01T11:00:00.000Z';
    const outside = '2026-07-01T11:05:00.000Z';
    await seedRow({ timestamp: inside, conversationId: 'conv-window' });
    await seedRow({ timestamp: outside, conversationId: 'conv-window' });

    const rows = await repo.findTimeline({
      from: new Date('2026-07-01T10:59:00.000Z'),
      to: new Date('2026-07-01T11:01:00.000Z'),
      conversationId: 'conv-window',
    });

    expect(rows.every((r) => r.timestamp >= new Date('2026-07-01T10:59:00.000Z'))).toBe(true);
    expect(rows.every((r) => r.timestamp < new Date('2026-07-01T11:01:00.000Z'))).toBe(true);
    expect(rows.some((r) => r.timestamp.toISOString() === new Date(outside).toISOString())).toBe(false);
  });

  it('filters by conversationId', async () => {
    const convA = 'conv-timeline-a';
    const convB = 'conv-timeline-b';
    await seedRow({ timestamp: '2026-07-01T12:00:00.000Z', conversationId: convA });
    await seedRow({ timestamp: '2026-07-01T12:01:00.000Z', conversationId: convB });

    const rows = await repo.findTimeline({
      from: new Date('2026-07-01T11:59:00.000Z'),
      to: new Date('2026-07-01T12:02:00.000Z'),
      conversationId: convA,
    });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.conversationId === convA)).toBe(true);
  });

  it('filters by taskId via payload->taskId when task_id column is NULL', async () => {
    const taskId = 'task-timeline-filter-1314';
    await seedRow({
      timestamp: '2026-07-01T13:00:00.000Z',
      conversationId: 'conv-task',
      taskId,
    });
    await seedRow({
      timestamp: '2026-07-01T13:01:00.000Z',
      conversationId: 'conv-task',
      taskId: 'other-task',
    });

    const colCheck = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM audit_log
       WHERE source_layer = $1 AND payload->>'taskId' = $2
       LIMIT 1`,
      [sourceLayer, taskId],
    );
    expect(colCheck.rows[0]!.task_id).toBeNull();

    const rows = await repo.findTimeline({
      from: new Date('2026-07-01T12:59:00.000Z'),
      to: new Date('2026-07-01T13:02:00.000Z'),
      taskId,
    });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.payload.taskId === taskId)).toBe(true);
  });

  it('includes parentEventId and clamps limit', async () => {
    const parentId = await seedRow({ timestamp: '2026-07-01T14:00:00.000Z' });
    await seedRow({
      timestamp: '2026-07-01T14:01:00.000Z',
      parentEventId: parentId,
      conversationId: 'conv-parent',
    });

    const rows = await repo.findTimeline({
      from: new Date('2026-07-01T13:59:00.000Z'),
      to: new Date('2026-07-01T14:02:00.000Z'),
      conversationId: 'conv-parent',
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    const child = rows.find((r) => r.parentEventId === parentId);
    expect(child).toBeDefined();
    expect(child!.parentEventId).toBe(parentId);
  });

  it('findByEventTypes filters by event type list', async () => {
    await seedRow({ timestamp: '2026-07-01T15:00:00.000Z', eventType: 'task.created', conversationId: 'conv-types' });
    await seedRow({ timestamp: '2026-07-01T15:01:00.000Z', eventType: 'task.completed', conversationId: 'conv-types' });
    await seedRow({ timestamp: '2026-07-01T15:02:00.000Z', eventType: 'agent.task', conversationId: 'conv-types' });

    const rows = await repo.findByEventTypes(
      ['task.created', 'task.completed'],
      {
        from: new Date('2026-07-01T14:59:00.000Z'),
        to: new Date('2026-07-01T15:03:00.000Z'),
        conversationId: 'conv-types',
      },
    );

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.eventType === 'task.created' || r.eventType === 'task.completed')).toBe(true);
  });
});
