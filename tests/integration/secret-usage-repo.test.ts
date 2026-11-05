// SecretUsageRepo over a real audit_log: secret.accessed rows written through the real
// AuditLogger. audit_log is append-only, so the suite uses run-unique secret names rather
// than cleaning up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { AuditLogger } from '../../src/audit/logger.js';
import { createCardUseDecided, createSecretAccessed } from '../../src/bus/events.js';
import { createSilentLogger } from '../../src/logger.js';
import { CardUseRepo } from '../../src/secrets/card-use-repo.js';
import { SecretUsageRepo, type SecretUse, type SecretUseItem } from '../../src/secrets/secret-usage-repo.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

/** The read items only; the test names fail loudly if a card_use item shows up unexpectedly. */
function reads(items: SecretUseItem[]): SecretUse[] {
  return items.map(i => {
    if (i.kind !== 'read') throw new Error(`expected a read item, got ${i.kind}`);
    return i;
  });
}

describeIf('SecretUsageRepo', () => {
  let pool: pg.Pool;
  let repo: SecretUsageRepo;
  const suffix = randomBytes(4).toString('hex');
  const nameA = `user.usage_rt_a_${suffix}`;
  const nameB = `user.usage_rt_b_${suffix}`;
  const cardName = `user.usage_rt_card_${suffix}`;
  const cardDecidedAt = new Date(Date.now() - 20_000);
  const cardReadAt = new Date(Date.now() - 25_000);
  const older = new Date(Date.now() - 60_000);
  const newer = new Date(Date.now() - 30_000);
  const other = new Date(Date.now() - 45_000);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Before any write: audit_log is append-only, so rows written to the wrong database stay.
    await requireCuriaTestDatabase(pool);
    const auditLogger = new AuditLogger(pool, createSilentLogger());
    repo = new SecretUsageRepo(pool);

    const write = async (secretName: string, at: Date, toolName: string, agentId?: string) => {
      const event = createSecretAccessed({ toolName, secretName, agentId, source: 'vault' });
      event.timestamp = at;
      await auditLogger.log(event);
    };
    await write(nameA, older, 'web-browser', 'travel');
    await write(nameB, other, 'web-browser');
    await write(nameA, newer, 'http-fetch', 'travel');

    // A saved card: one field fill, then the principal's decision on a checkout.
    const fill = createSecretAccessed({ toolName: 'browser-fill', secretName: cardName, agentId: 'travel', source: 'vault', byReference: true, secretField: 'expiry_mm' });
    fill.timestamp = cardReadAt;
    await auditLogger.log(fill);
    const request = await new CardUseRepo(pool).create({
      secretName: cardName, siteUrl: 'https://www.aircanada.com/checkout', conversationId: `conv-${suffix}`,
      taskId: `task-${suffix}`, amount: 'CA$412.30', purpose: 'flight', origin: { agentId: 'travel' },
    });
    const decided = createCardUseDecided({
      requestId: request.id, secretName: cardName, siteDomain: request.siteDomain, decision: 'approved',
      resume: false, origin: { agentId: 'travel' }, purpose: 'flight',
    });
    decided.timestamp = cardDecidedAt;
    await auditLogger.log(decided);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('lastUsedByName returns the newest access per secret', async () => {
    const last = await repo.lastUsedByName();
    expect(last.get(nameA)?.getTime()).toBe(newer.getTime());
    expect(last.get(nameB)?.getTime()).toBe(other.getTime());
  });

  it('recentUses honors the limit and orders newest first', async () => {
    const uses = reads(await repo.recentUses(nameA, 1));
    expect(uses).toHaveLength(1);
    expect(uses[0]!.at.getTime()).toBe(newer.getTime());
    expect(uses[0]!.toolName).toBe('http-fetch');
    expect(uses[0]!.agentId).toBe('travel');
    expect(uses[0]!.source).toBe('vault');
    expect(uses[0]!.byReference).toBe(false);
    expect(uses[0]!.secretField).toBeNull();

    const both = reads(await repo.recentUses(nameA, 5));
    expect(both.map((u) => u.toolName)).toEqual(['http-fetch', 'web-browser']);
  });

  it('recentUses is empty for a secret never read', async () => {
    expect(await repo.recentUses(`user.usage_rt_none_${suffix}`, 5)).toEqual([]);
  });

  it('recentUses returns the field filled and the card-use decision with its amount, newest first', async () => {
    const items = await repo.recentUses(cardName, 5);
    expect(items).toEqual([
      { kind: 'card_use', at: expect.any(Date), decision: 'approved', siteDomain: 'aircanada.com', amount: 'CA$412.30' },
      {
        kind: 'read', at: expect.any(Date), agentId: 'travel', toolName: 'browser-fill',
        source: 'vault', byReference: true, secretField: 'expiry_mm',
      },
    ]);
    expect(items[0]!.at.getTime()).toBe(cardDecidedAt.getTime());
    expect(JSON.stringify(items)).not.toMatch(/\d{12,}/);
    expect(await repo.recentUses(cardName, 1)).toHaveLength(1);
  });
});
