// findToolResultsForTasks against real Postgres (#2159): the evidence the band brief reads.
// Rows are seeded in the shape runtime.ts writes them: agent.task → tool.invoke → tool.result.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('audit-log findToolResultsForTasks (#2159)', () => {
  let pool: pg.Pool;
  let repo: AuditLogRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new AuditLogRepo(pool, createSilentLogger());
    await pool.query('SELECT 1 FROM audit_log LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seed(eventType: string, at: string, parentEventId: string | null, payload: Record<string, unknown> = {}): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO audit_log (timestamp, event_type, source_layer, source_id, payload, parent_event_id)
       VALUES ($1, $2, 'test-evidence', 'test-agent', $3::jsonb, $4)
       RETURNING id`,
      [new Date(at), eventType, JSON.stringify(payload), parentEventId],
    );
    return result.rows[0]!.id;
  }

  it('returns the results of the tasks\' tool calls, newest first, and nothing else', async () => {
    const task = await seed('agent.task', '2026-10-18T09:00:00.000Z', null, { content: 'Confirm Tuesday?' });
    const other = await seed('agent.task', '2026-10-18T09:00:00.000Z', null);
    const inv1 = await seed('tool.invoke', '2026-10-18T09:00:01.000Z', task, { toolName: 'calendar-list' });
    await seed('tool.result', '2026-10-18T09:00:02.000Z', inv1, { toolName: 'calendar-list', result: { success: true, data: 1 } });
    const inv2 = await seed('tool.invoke', '2026-10-18T09:00:03.000Z', task, { toolName: 'contact-lookup' });
    await seed('tool.result', '2026-10-18T09:00:04.000Z', inv2, { toolName: 'contact-lookup', result: { success: true, data: 2 } });
    await seed('llm.call', '2026-10-18T09:00:05.000Z', task);
    const otherInv = await seed('tool.invoke', '2026-10-18T09:00:06.000Z', other, { toolName: 'web-fetch' });
    await seed('tool.result', '2026-10-18T09:00:07.000Z', otherInv, { toolName: 'web-fetch', result: { success: true, data: 3 } });

    const rows = await repo.findToolResultsForTasks([task], 50);

    expect(rows.map((r) => r.payload['toolName'])).toEqual(['contact-lookup', 'calendar-list']);
  });

  it('keeps the newest when the limit cuts', async () => {
    const task = await seed('agent.task', '2026-10-18T10:00:00.000Z', null);
    for (let i = 0; i < 5; i++) {
      const inv = await seed('tool.invoke', `2026-10-18T10:00:0${i}.500Z`, task);
      await seed('tool.result', `2026-10-18T10:00:0${i}.900Z`, inv, { toolName: `t${i}` });
    }

    const rows = await repo.findToolResultsForTasks([task], 2);

    expect(rows.map((r) => r.payload['toolName'])).toEqual(['t4', 't3']);
  });

  it('returns nothing for an unknown task', async () => {
    expect(await repo.findToolResultsForTasks([randomUUID()], 10)).toEqual([]);
  });
});
