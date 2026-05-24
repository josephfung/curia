// tests/integration/ceo-inbox-bullpen-escalation.test.ts
//
// Integration test: validates the infrastructure path for ceo-inbox
// urgent alerts routed through bullpen-through-coordinator pattern.
// Verifies: thread creation → coordinator receives → context bridge
// entry registered → delegation hint points back to ceo-inbox.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BullpenService } from '../../src/memory/bullpen.js';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('ceo-inbox bullpen-through-coordinator escalation', () => {
  let pool: pg.Pool;
  let bullpen: BullpenService;
  let outboundContext: OutboundContextService;
  let runId: string;

  beforeAll(async () => {
    runId = randomUUID();
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM bullpen_threads LIMIT 0');
    await pool.query('SELECT 1 FROM outbound_context LIMIT 0');
    const logger = createLogger('error');
    bullpen = BullpenService.createWithPostgres(pool, logger);
    outboundContext = new OutboundContextService(pool, logger);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM bullpen_threads WHERE topic LIKE $1`,
      [`${runId}%`],
    );
    // Remove only the specific entry created by this test run, identified by
    // conversation_id scoped to runId, to avoid colliding with other test runs.
    await pool.query(
      `DELETE FROM outbound_context WHERE conversation_id = $1`,
      [`conv-${runId}`],
    );
    await pool.end();
  });

  it('ceo-inbox opens a bullpen thread mentioning coordinator for urgent email', async () => {
    // Simulate: ceo-inbox posts a structured send request to coordinator
    const { thread, message } = await bullpen.openThread(
      `${runId} — Urgent email escalation: merger deadline`,
      'ceo-inbox',
      ['ceo-inbox', 'coordinator'],
      `@coordinator I'd like you to send a message to the CEO.\n\n` +
        `Urgency: immediate\n` +
        `Channel: Signal\n` +
        `Message: "Alice Chen — Merger deadline: Decision needed on terms by Friday EOD"\n` +
        `Context bridge: agent_id=ceo-inbox, expected_reply="Decision or follow-up instruction", ` +
        `delegation_hint="Delegate replies to ceo-inbox", expires_in_hours=24`,
      ['coordinator'],
    );

    expect(thread.creatorAgentId).toBe('ceo-inbox');
    expect(thread.participants).toContain('coordinator');
    expect(message.content).toContain('Urgency: immediate');
    expect(message.content).toContain('Channel: Signal');
    expect(message.content).toContain('Context bridge:');
  });

  it('coordinator registers context bridge entry after sending', async () => {
    // Simulate: coordinator processes the bullpen request and calls signal-send
    // with context_bridge params. The send skill registers the entry.
    //
    // register() returns only the UUID; fetch the full row via pool.query to
    // verify the persisted field values.
    const registeredEntryId = await outboundContext.register({
      conversationId: `conv-${runId}`,
      channelId: 'signal',
      agentId: 'ceo-inbox',
      content: 'Alice Chen — Merger deadline: Decision needed on terms by Friday EOD',
      expectedReply: 'Decision or follow-up instruction',
      delegationHint: 'Delegate replies to ceo-inbox',
      metadata: { source: 'urgent-email-escalation' },
      expiresInHours: 24,
    });

    expect(registeredEntryId).toBeDefined();

    // Fetch the persisted row to verify field values were stored correctly.
    const result = await pool.query<{
      id: string;
      agent_id: string;
      delegation_hint: string;
      expected_reply: string;
    }>(
      `SELECT id, agent_id, delegation_hint, expected_reply
       FROM outbound_context WHERE id = $1`,
      [registeredEntryId],
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.agent_id).toBe('ceo-inbox');
    expect(row.delegation_hint).toBe('Delegate replies to ceo-inbox');

    // Verify the entry appears in active entries (no channel filter — getActive
    // returns all active entries; filter by agentId client-side).
    const active = await outboundContext.getActive();
    const found = active.find(e => e.id === registeredEntryId);
    expect(found).toBeDefined();
    expect(found?.expectedReply).toBe('Decision or follow-up instruction');
  });

  it('active context entry enables delegation back to ceo-inbox', async () => {
    // Simulate: CEO replies on Signal. Dispatcher queries active entries.
    // We verify the entry we registered in test 2 is still present and has the
    // correct delegation hint. Use the conversation_id scoped to this run to
    // avoid depending on getActive()'s limit or parallel test state.
    const result = await pool.query<{ agent_id: string; delegation_hint: string }>(
      `SELECT agent_id, delegation_hint FROM outbound_context
       WHERE conversation_id = $1 AND released = false`,
      [`conv-${runId}`],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    const row = result.rows[0]!;
    expect(row.agent_id).toBe('ceo-inbox');
    expect(row.delegation_hint).toContain('ceo-inbox');

    // Coordinator uses this hint to delegate the reply back to ceo-inbox
    // (actual delegation is tested in dispatcher-context-bridging.test.ts)
  });
});
