import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { EventBus } from '../../src/bus/bus.js';
import {
  createInboundMessage,
  createToolResult,
  createLlmCall,
} from '../../src/bus/events.js';
import {
  GENESIS_HASH,
  computeEntryHash,
  toHashTimestamp,
} from '../../src/audit/hash-chain.js';
import { createSilentLogger } from '../../src/logger.js';
import { ActivityLogHandler } from '../../skills/activity-log/handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('audit log Phase 1 hardening (#1383)', () => {
  let pool: pg.Pool;
  let auditLogger: AuditLogger;
  let repo: AuditLogRepo;
  const logger = createSilentLogger();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Destructive suite (DISABLE TRIGGER + UPDATE on append-only audit_log).
    await requireCuriaTestDatabase(pool);
    auditLogger = new AuditLogger(pool, logger);
    await auditLogger.seedHashChain();
    repo = new AuditLogRepo(pool, logger);

    // Require migrations 078/079/080.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'audit_log'
         AND column_name IN ('action', 'entry_hash', 'seq')`,
    );
    if (cols.rows.length < 3) {
      throw new Error('migrations 078/080 not applied — run pnpm migrate before this suite');
    }
    const archive = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'llm_call_archive'
       ) AS exists`,
    );
    if (!archive.rows[0]?.exists) {
      throw new Error('migration 079 not applied — run pnpm migrate before this suite');
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('writes structured columns + entry_hash; verify recomputes; tamper is detected', async () => {
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );

    const event = createInboundMessage({
      conversationId: `conv-harden-${Date.now()}`,
      channelId: 'test-channel',
      senderId: 'sender-harden',
      content: 'phase1',
    });
    await bus.publish('channel', event);

    const row = await pool.query<{
      action: string;
      outcome: string;
      target_type: string;
      target_id: string;
      initiator_type: string;
      initiator_id: string;
      entry_hash: string;
      payload: unknown;
      source_id: string;
      conversation_id: string | null;
      task_id: string | null;
      parent_event_id: string | null;
      timestamp: Date;
      event_type: string;
      source_layer: string;
      seq: string;
    }>(
      `SELECT action, outcome, target_type, target_id, initiator_type, initiator_id,
              entry_hash, payload, source_id, conversation_id, task_id, parent_event_id,
              timestamp, event_type, source_layer, seq::text AS seq
       FROM audit_log WHERE id = $1`,
      [event.id],
    );
    expect(row.rows).toHaveLength(1);
    const r = row.rows[0]!;
    expect(r.action).toBe('receive');
    expect(r.outcome).toBe('success');
    expect(r.target_type).toBe('conversation');
    expect(r.target_id).toBe(event.payload.conversationId);
    expect(r.initiator_type).toBe('human');
    expect(r.initiator_id).toBe('sender-harden');
    expect(r.entry_hash).toMatch(/^[a-f0-9]{64}$/);
    // timestamp is factual event time — never mutated for chain order
    expect(r.timestamp.toISOString()).toBe(event.timestamp.toISOString());

    // Predecessor by seq (chain order), not wall-clock timestamp.
    const prev = await pool.query<{ entry_hash: string | null }>(
      `SELECT entry_hash FROM audit_log
       WHERE seq < $1::bigint
         AND entry_hash IS NOT NULL
       ORDER BY seq DESC
       LIMIT 1`,
      [r.seq],
    );
    const previousHash = prev.rows[0]?.entry_hash ?? GENESIS_HASH;
    const expected = computeEntryHash(
      {
        id: event.id,
        timestamp: toHashTimestamp(r.timestamp),
        event_type: r.event_type,
        source_layer: r.source_layer,
        source_id: r.source_id,
        payload: r.payload,
        conversation_id: r.conversation_id,
        task_id: r.task_id,
        parent_event_id: r.parent_event_id,
        action: r.action,
        outcome: r.outcome,
        target_type: r.target_type,
        target_id: r.target_id,
        initiator_type: r.initiator_type,
        initiator_id: r.initiator_id,
      },
      previousHash,
    );
    expect(r.entry_hash).toBe(expected);

    // Tamper detection: flip a column with the immutability trigger briefly
    // disabled. The DISABLE/UPDATE/ENABLE runs in one transaction so a crash
    // mid-step rolls back and restores the trigger automatically.
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trigger');
        await client.query(
          `UPDATE audit_log SET action = 'tampered' WHERE id = $1`,
          [event.id],
        );
        await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trigger');
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors — connection may already be aborted
        }
        throw err;
      } finally {
        client.release();
      }
    }

    const tampered = await pool.query<{ action: string; entry_hash: string; payload: unknown }>(
      `SELECT action, entry_hash, payload, source_id, conversation_id, task_id,
              parent_event_id, timestamp, event_type, source_layer,
              outcome, target_type, target_id, initiator_type, initiator_id
       FROM audit_log WHERE id = $1`,
      [event.id],
    );
    const t = tampered.rows[0]!;
    expect(t.action).toBe('tampered');
    const afterTamper = computeEntryHash(
      {
        id: event.id,
        timestamp: toHashTimestamp(r.timestamp),
        event_type: r.event_type,
        source_layer: r.source_layer,
        source_id: r.source_id,
        payload: t.payload,
        conversation_id: r.conversation_id,
        task_id: r.task_id,
        parent_event_id: r.parent_event_id,
        action: t.action,
        outcome: r.outcome,
        target_type: r.target_type,
        target_id: r.target_id,
        initiator_type: r.initiator_type,
        initiator_id: r.initiator_id,
      },
      previousHash,
    );
    expect(afterTamper).not.toBe(t.entry_hash);

    // Restore the row so subsequent verify / tests see an intact chain.
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trigger');
        await client.query(
          `UPDATE audit_log SET action = 'receive' WHERE id = $1`,
          [event.id],
        );
        await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trigger');
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw err;
      } finally {
        client.release();
      }
    }
  });

  it('writes a redacted llm_call_archive row keyed to the audit event', async () => {
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );

    const event = createLlmCall({
      agentId: 'coordinator',
      conversationId: `conv-archive-${Date.now()}`,
      requestedModel: 'claude-sonnet-4-6',
      actualModel: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 1,
      providerRequestId: 'req-archive',
      promptHash: 'c'.repeat(64),
      responseHash: 'd'.repeat(64),
      parentEventId: 'system',
      archive: {
        prompt: {
          messages: [{ role: 'user', content: 'secret sk-ant-abcdefghijklmnopqrstuvwxyz012345' }],
          api_key: 'should-be-redacted',
        },
        response: { type: 'text', content: 'ok' },
        toolDefinitions: [{ name: 'noop' }],
      },
    });

    await bus.publish('agent', event);

    const archive = await pool.query<{
      prompt: Record<string, unknown>;
      response: Record<string, unknown>;
      tool_definitions: unknown;
    }>(
      `SELECT prompt, response, tool_definitions FROM llm_call_archive WHERE audit_event_id = $1`,
      [event.id],
    );
    expect(archive.rows).toHaveLength(1);
    const a = archive.rows[0]!;
    expect(a.prompt.api_key).toBe('[REDACTED]');
    const msg = (a.prompt.messages as Array<{ content: string }>)[0]!;
    expect(msg.content).toContain('[REDACTED]');
    expect(msg.content).not.toContain('sk-ant-');
    expect(a.response).toMatchObject({ type: 'text', content: 'ok' });
  });

  it('activity-log returns structured-column data for new hashed rows', async () => {
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );

    const since = new Date();
    const toolEvent = createToolResult({
      agentId: 'calendar',
      conversationId: `conv-activity-${Date.now()}`,
      toolName: 'calendar-respond-to-invite',
      result: {
        success: true,
        data: {
          response: 'accept',
          event: { title: 'Board Sync' },
          releasedHolds: [],
        },
      },
      durationMs: 12,
      parentEventId: 'task-activity',
    });
    await bus.publish('execution', toolEvent);

    const until = new Date(Date.now() + 1000);
    const handler = new ActivityLogHandler();
    const result = await handler.execute({
      input: {
        since: since.toISOString(),
        until: until.toISOString(),
        tool_name: 'calendar-respond-to-invite',
      },
      secret: () => { throw new Error('no'); },
      log: logger,
      timezone: 'UTC',
      auditLogRepo: repo,
    } as unknown as ToolContext);

    expect(result.success).toBe(true);
    const actions = (result as { success: true; data: { actions: Array<{
      tool: string;
      outcome: string;
      target: string;
      agent_id: string;
    }> } }).data.actions;

    const fromColumns = actions.find((a) => a.target.includes('Board Sync'));
    expect(fromColumns).toMatchObject({
      tool: 'calendar-respond-to-invite',
      outcome: 'completed',
      agent_id: 'calendar',
    });

    const structured = await repo.findById(toolEvent.id);
    expect(structured?.action).toBe('execute');
    expect(structured?.outcome).toBe('success');
    expect(structured?.targetType).toBe('skill');
    expect(structured?.targetId).toBe('calendar-respond-to-invite');
    expect(structured?.initiatorType).toBe('agent');
    expect(structured?.initiatorId).toBe('calendar');
    expect(structured?.entryHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
