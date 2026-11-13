// The console's principal mailbox routes write principal_mailbox.changed rows to the real
// audit_log through the production write-ahead hook (#2475 P11). The admin is a fake: this
// pins the audit path, not the mailbox change itself.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { principalMailboxesRoutes } from '../../src/channels/http/routes/principal-mailboxes.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { EventBus } from '../../src/bus/bus.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;
const SECRET = 'test-bootstrap-secret';
const hdr = { 'x-web-bootstrap-secret': SECRET };
const logger = pino({ level: 'silent' });

describeIf('principal mailbox console audit (P11)', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof Fastify>;
  // Unique per run: audit_log is append-only, so rows are told apart by target id.
  const mailboxId = `audit-${randomBytes(3).toString('hex')}`;
  const GRANT = 'grant-audit-SECRET-0001';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    const auditLogger = new AuditLogger(pool, logger);
    const bus = new EventBus(logger, (e) => auditLogger.log(e), (id) => auditLogger.markAcknowledged(id));
    const view: PrincipalMailboxView = { id: mailboxId, label: 'Audit', address: 'audit@example.com', isDefault: false, triageStartAt: null };
    app = Fastify();
    await app.register(principalMailboxesRoutes, {
      mailboxes: { list: vi.fn(async () => [view]), isFallbackActive: vi.fn(async () => false), pendingMigrationReason: vi.fn(() => null) },
      store: { relabel: vi.fn(async () => {}) },
      admin: {
        add: vi.fn(async () => ({ ok: true as const, mailbox: view })),
        setDefault: vi.fn(async () => ({})),
        replaceGrant: vi.fn(async () => ({ ok: true as const })),
        removalPreview: vi.fn(async () => { throw new Error('unused'); }),
        remove: vi.fn(async () => ({ cleanupIncomplete: ['inbox_rules'], restartRequired: false })),
      },
      lookupGrant: vi.fn(async () => ({ email: 'audit@example.com', provider: 'google' })),
      webAppBootstrapSecret: SECRET,
      sessions: new Map(),
      bus,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('writes two-stage rows for add, set_default, replace_grant and remove; never the grant id', async () => {
    const since = new Date();
    const base = '/api/registry/principal-mailboxes';
    expect((await app.inject({ method: 'POST', url: base, headers: hdr, payload: { id: mailboxId, label: 'Audit', grant_id: GRANT } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'PATCH', url: `${base}/${mailboxId}`, headers: hdr, payload: { make_default: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `${base}/${mailboxId}`, headers: hdr, payload: { grant_id: GRANT } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `${base}/${mailboxId}`, headers: hdr, payload: { still_owned: true, rules: 'delete' } })).statusCode).toBe(200);
    const { rows } = await pool.query<{ action: string; outcome: string; target_type: string; initiator_id: string; payload: string }>(
      `SELECT action, outcome, target_type, initiator_id, payload::text AS payload FROM audit_log
        WHERE event_type = 'principal_mailbox.changed' AND target_id = $1 AND timestamp >= $2
        ORDER BY timestamp, seq`,
      [mailboxId, since],
    );
    expect(rows.map((r) => `${r.action}:${r.outcome}`)).toEqual([
      'add:pending', 'add:success',
      'set_default:pending', 'set_default:success',
      'replace_grant:pending', 'replace_grant:success',
      'remove:pending', 'remove:success',
    ]);
    expect(rows.every((r) => r.target_type === 'principal_mailbox' && r.initiator_id === 'bootstrap_secret')).toBe(true);
    expect(JSON.parse(rows[7]!.payload)).toMatchObject({ rules: 'delete', cleanupIncomplete: ['inbox_rules'] });
    const all = rows.map((r) => r.payload).join();
    expect(all).not.toContain(GRANT);
    expect(all).not.toContain('audit@example.com');
  });
});
