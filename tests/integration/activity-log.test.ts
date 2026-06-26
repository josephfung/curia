import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { ActivityLogHandler } from '../../skills/activity-log/handler.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('activity-log integration', () => {
  let pool: pg.Pool;
  let repo: AuditLogRepo;
  const logger = createSilentLogger();
  const sourceLayer = 'test-activity-log';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new AuditLogRepo(pool, logger);
    await pool.query('SELECT 1 FROM audit_log LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns seeded RSVP rows from audit_log', async () => {
    const since = new Date('2026-06-25T12:00:00.000Z');
    const until = new Date('2026-06-25T13:00:00.000Z');
    const payload = {
      skillName: 'calendar-respond-to-invite',
      conversationId: 'conv-test',
      agentId: 'calendar',
      result: {
        success: true,
        data: {
          response: 'accept',
          event: { title: 'Project sync' },
          releasedHolds: [],
        },
      },
      durationMs: 120,
    };

    await pool.query(
      `INSERT INTO audit_log (timestamp, event_type, source_layer, source_id, payload)
       VALUES ($1, 'skill.result', $2, 'calendar', $3::jsonb)`,
      [new Date('2026-06-25T12:30:00.000Z'), sourceLayer, JSON.stringify(payload)],
    );

    const handler = new ActivityLogHandler();
    const result = await handler.execute({
      input: {
        since: since.toISOString(),
        until: until.toISOString(),
        skill_name: 'calendar-respond-to-invite',
      },
      secret: () => { throw new Error('no secrets'); },
      log: logger,
      timezone: 'UTC',
      auditLogRepo: repo,
    } as never);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { actions: Array<{ skill: string; target: string }> } }).data;
    expect(data.actions.some((action) => action.skill === 'calendar-respond-to-invite')).toBe(true);
    expect(data.actions.some((action) => action.target.includes('Project sync'))).toBe(true);
  });
});
