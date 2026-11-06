// findToolResultsForTasks against real Postgres (#2159): the evidence the band brief reads.
// Rows are seeded in the shape runtime.ts writes them: agent.task → tool.invoke → tool.result.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('audit-log findToolResultsForTasks (#2159)', () => {
  let pool: pg.Pool;
  let repo: AuditLogRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // audit_log is append-only (no DELETE), so the rows this suite seeds can't be cleaned up.
    // Refuse anything but the isolated test database before writing a single one.
    await requireCuriaTestDatabase(pool);
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

  // #2312: the report-to-principal tool files principal.report under the drafting turn's agent.task.
  it('returns the principal reports filed under the tasks, newest first, and nothing else', async () => {
    const task = await seed('agent.task', '2026-10-18T11:00:00.000Z', null);
    const other = await seed('agent.task', '2026-10-18T11:00:00.000Z', null);
    await seed('principal.report', '2026-10-18T11:00:01.000Z', task, { source: 'agent', summary: 'first' });
    await seed('principal.report', '2026-10-18T11:00:02.000Z', task, { source: 'agent', summary: 'second' });
    // The dispatcher's relay note arrives with the send, never from this query.
    await seed('principal.report', '2026-10-18T11:00:02.500Z', task, { source: 'principal_note', summary: 'relay note' });
    await seed('principal.report', '2026-10-18T11:00:03.000Z', other, { source: 'agent', summary: 'someone else\'s' });
    await seed('tool.result', '2026-10-18T11:00:04.000Z', task, { toolName: 'not-a-report' });
    // System-generated reports (a held draft verbatim, etc.) are not something Curia told the principal.
    await seed('principal.report', '2026-10-18T11:00:05.000Z', task, { source: 'relay_deferred', summary: 'held draft text' });

    const rows = await repo.findPrincipalReportsForTasks([task], 10);

    expect(rows.map((r) => r.payload['summary'])).toEqual(['second', 'first']);
    expect(await repo.findPrincipalReportsForTasks([task], 1)).toHaveLength(1);
  });

  // #2499: follow-ups a turn lane drained into a host task, as the runtime audits them.
  it('returns the inbound ids drained into a host task on its conversation, newest first, and nothing else', async () => {
    const conversationId = `conv-${randomUUID()}`;
    const host = await seed('agent.task', '2026-10-18T12:00:00.000Z', null);
    const otherHost = await seed('agent.task', '2026-10-18T12:00:00.000Z', null);
    async function injected(at: string, hostTaskEventId: string, inboundEventId: string, conv = conversationId): Promise<void> {
      await pool.query(
        `INSERT INTO audit_log (timestamp, event_type, source_layer, source_id, payload, parent_event_id, conversation_id)
         VALUES ($1, 'agent.task.input_injected', 'agent', 'coordinator', $2::jsonb, $3, $4)`,
        [new Date(at), JSON.stringify({ hostTaskEventId, inboundEventId, conversationId: conv, agentId: 'coordinator', drainPoint: 'round', senderContactId: 'c' }), inboundEventId, conv],
      );
    }
    await injected('2026-10-18T12:00:01.000Z', host, 'inbound-a');
    await injected('2026-10-18T12:00:02.000Z', host, 'inbound-b');
    await injected('2026-10-18T12:00:03.000Z', otherHost, 'inbound-other-host');
    await injected('2026-10-18T12:00:04.000Z', host, 'inbound-other-conv', `conv-${randomUUID()}`);

    expect(await repo.findInjectedInboundIds(conversationId, host, 10)).toEqual(['inbound-b', 'inbound-a']);
    expect(await repo.findInjectedInboundIds(conversationId, host, 1)).toEqual(['inbound-b']);
    expect(await repo.findInjectedInboundIds(conversationId, randomUUID(), 10)).toEqual([]);
  });

  // #2499: one sender's earlier inbound messages on a conversation, for the band brief.
  it('returns one sender\'s inbound messages on the conversation before a time, newest first', async () => {
    const conversationId = `conv-${randomUUID()}`;
    async function inbound(at: string, senderId: string, content: string, conv = conversationId, eventType = 'inbound.message'): Promise<void> {
      await pool.query(
        `INSERT INTO audit_log (timestamp, event_type, source_layer, source_id, payload, conversation_id)
         VALUES ($1, $2, 'channel', 'email', $3::jsonb, $4)`,
        [new Date(at), eventType, JSON.stringify({ senderId, content, conversationId: conv }), conv],
      );
    }
    await inbound('2026-10-18T13:00:01.000Z', 'jordan@example.test', 'first');
    await inbound('2026-10-18T13:00:02.000Z', 'someone@example.test', 'other sender');
    await inbound('2026-10-18T13:00:03.000Z', 'jordan@example.test', 'second');
    await inbound('2026-10-18T13:00:04.000Z', 'jordan@example.test', 'other conversation', `conv-${randomUUID()}`);
    await inbound('2026-10-18T13:00:05.000Z', 'jordan@example.test', 'not an inbound', conversationId, 'agent.task');
    await inbound('2026-10-18T13:00:06.000Z', 'jordan@example.test', 'at the cutoff');

    const before = new Date('2026-10-18T13:00:06.000Z');
    const rows = await repo.findRecentInboundsFromSender(conversationId, 'jordan@example.test', before, 10);
    expect(rows.map((r) => r.payload['content'])).toEqual(['second', 'first']);
    expect((await repo.findRecentInboundsFromSender(conversationId, 'jordan@example.test', before, 1)).map((r) => r.payload['content'])).toEqual(['second']);
    // An address in another case is the same sender.
    expect((await repo.findRecentInboundsFromSender(conversationId, 'Jordan@Example.TEST', before, 10)).map((r) => r.payload['content'])).toEqual(['second', 'first']);
  });
});
