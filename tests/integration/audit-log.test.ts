import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import { createInboundMessage } from '../../src/bus/events.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;

// Skip if DATABASE_URL is not set (CI may not have Postgres).
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('audit_log append-only enforcement', () => {
  let pool: pg.Pool;
  let auditLogger: AuditLogger;
  const logger = createSilentLogger();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    auditLogger = new AuditLogger(pool, logger);

    // Sanity check: migrations have run and the table exists.
    await pool.query('SELECT 1 FROM audit_log LIMIT 0');

    // Fast-fail if migration 021 (append-only trigger) hasn't been applied.
    // Without the trigger the "rejects" assertions below would fail with
    // misleading "expected to throw but didn't" errors instead of surfacing
    // the real problem: a missing migration.
    const triggerResult = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM   pg_trigger  t
         JOIN   pg_class    c ON c.oid = t.tgrelid
         WHERE  c.relname = 'audit_log'
         AND    t.tgname  = 'audit_log_immutable_trigger'
       ) AS exists`,
    );
    if (!triggerResult.rows[0].exists) {
      throw new Error(
        'audit_log_immutable_trigger not found — run migration 021 before running integration tests',
      );
    }
  });

  afterAll(async () => {
    // audit_log is append-only — rows cannot be deleted, even in tests.
    // The trigger we're verifying here blocks DELETE, so teardown is just closing the pool.
    // Test rows (source_layer = 'test-audit-enforcement') accumulate in the dev DB but are
    // harmless; they will not appear in production.
    await pool.end();
  });

  // Helper: insert a raw row with a known source_layer sentinel so cleanup is precise.
  async function insertTestRow(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO audit_log (event_type, source_layer, source_id, payload)
       VALUES ('inbound.message', 'test-audit-enforcement', 'test-source', '{}')
       RETURNING id`,
    );
    return result.rows[0].id;
  }

  // ---- Trigger: DELETE is rejected ----

  it('rejects DELETE on audit_log', async () => {
    const id = await insertTestRow();

    await expect(
      pool.query('DELETE FROM audit_log WHERE id = $1', [id]),
    ).rejects.toThrow(/append-only/);
  });

  // ---- Trigger: arbitrary UPDATE is rejected ----

  it('rejects UPDATE of any immutable column', async () => {
    const id = await insertTestRow();

    await expect(
      pool.query(`UPDATE audit_log SET event_type = $2 WHERE id = $1`, [id, 'tampered']),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE that changes payload', async () => {
    const id = await insertTestRow();

    await expect(
      pool.query(`UPDATE audit_log SET payload = $2 WHERE id = $1`, [id, '{"tampered":true}']),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE that flips acknowledged true → true (already acknowledged)', async () => {
    const id = await insertTestRow();
    // First, legitimately acknowledge the row.
    await pool.query(`UPDATE audit_log SET acknowledged = true WHERE id = $1 AND acknowledged = false`, [id]);

    // Attempting to set it to true again should be rejected because
    // OLD.acknowledged = true (not false), so the trigger's exception branch fires.
    await expect(
      pool.query(`UPDATE audit_log SET acknowledged = true WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });

  // ---- Trigger: acknowledged false → true is the one permitted UPDATE ----

  it('allows UPDATE that flips acknowledged from false to true', async () => {
    const id = await insertTestRow();

    // Must not throw.
    await expect(
      pool.query(
        `UPDATE audit_log SET acknowledged = true WHERE id = $1 AND acknowledged = false`,
        [id],
      ),
    ).resolves.toBeDefined();

    const result = await pool.query<{ acknowledged: boolean }>(
      `SELECT acknowledged FROM audit_log WHERE id = $1`,
      [id],
    );
    expect(result.rows[0].acknowledged).toBe(true);
  });

  // ---- AuditLogger.markAcknowledged ----

  it('markAcknowledged flips the row to acknowledged = true', async () => {
    const id = await insertTestRow();
    await auditLogger.markAcknowledged(id);

    const result = await pool.query<{ acknowledged: boolean }>(
      `SELECT acknowledged FROM audit_log WHERE id = $1`,
      [id],
    );
    expect(result.rows[0].acknowledged).toBe(true);
  });

  it('markAcknowledged is idempotent (no error on already-acknowledged row)', async () => {
    const id = await insertTestRow();
    // Pre-acknowledge using parameterized query (WHERE guards double-flip in app layer).
    await pool.query(
      `UPDATE audit_log SET acknowledged = true WHERE id = $1 AND acknowledged = false`,
      [id],
    );

    // The WHERE id = $1 AND acknowledged = false matches 0 rows — no UPDATE issued,
    // so the trigger never fires. markAcknowledged should silently succeed.
    await expect(auditLogger.markAcknowledged(id)).resolves.toBeUndefined();
  });

  // ---- EventBus + AuditLogger end-to-end: INSERT succeeds, acknowledged flips ----

  it('publishes an event: audit row is inserted then acknowledged', async () => {
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );

    const event = createInboundMessage({
      conversationId: 'conv-test',
      channelId: 'test-channel',
      senderId: 'test-sender',
      content: 'hello audit',
    });

    await bus.publish('channel', event);

    const result = await pool.query<{ acknowledged: boolean; source_layer: string }>(
      `SELECT acknowledged, source_layer FROM audit_log WHERE id = $1`,
      [event.id],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].acknowledged).toBe(true);
    expect(result.rows[0].source_layer).toBe('channel');

    // Clean up this row (different source_layer sentinel, so clean up individually).
    // The trigger blocks DELETE — use the test workaround: UPDATE is the only path,
    // but we actually want to remove it. We must bypass via a direct pool query
    // that the trigger allows... but it doesn't. Instead, leave it and rely on
    // a future cleanup migration, OR mark it acknowledged and leave it.
    // Acceptable: the row is already acknowledged = true, it won't appear in scans.
    // NOTE: leaving this row is intentional — audit rows are immutable by design.
  });

  // ---- AuditLogger.scanForUnacknowledged ----

  it('scanForUnacknowledged resolves without throwing when called', async () => {
    // Insert a row and immediately acknowledge it.
    const id = await insertTestRow();
    await auditLogger.markAcknowledged(id);

    // The append-only table means prior tests left unacknowledged rows — we
    // cannot guarantee the "no unacked rows" branch. What we CAN assert: the
    // function always resolves regardless of DB state, and no spurious debug
    // call is emitted for the row this test inserted (it's already acked).
    //
    // Use a spy logger to confirm no unexpected error-level calls occur.
    const spyLogger = createSilentLogger();
    const errorSpy = vi.spyOn(spyLogger, 'error');
    const scanLogger = new AuditLogger(pool, spyLogger);

    await expect(scanLogger.scanForUnacknowledged()).resolves.toBeUndefined();

    // The scan query itself must not fail — any error would surface here.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('scanForUnacknowledged logs a warn with pending count when unacknowledged rows exist', async () => {
    // Insert a row and leave it unacknowledged so the scan definitely finds it.
    await insertTestRow();

    const spyLogger = createSilentLogger();
    const warnSpy = vi.spyOn(spyLogger, 'warn');
    const scanLogger = new AuditLogger(pool, spyLogger);

    // The scan logs a warning but does NOT throw — it's diagnostic only.
    await expect(scanLogger.scanForUnacknowledged()).resolves.toBeUndefined();

    // Assert the observable logging contract: at least one warn call with a
    // numeric count field > 0.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ count: expect.any(Number) }),
      expect.any(String),
    );
    const [payload] = warnSpy.mock.calls[0];
    expect((payload as { count: number }).count).toBeGreaterThan(0);
  });
});
