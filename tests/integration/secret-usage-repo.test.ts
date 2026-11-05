// SecretUsageRepo over a real audit_log: secret.accessed rows written through the real
// AuditLogger. audit_log is append-only, so the suite uses run-unique secret names rather
// than cleaning up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { AuditLogger } from '../../src/audit/logger.js';
import { createSecretAccessed } from '../../src/bus/events.js';
import { createSilentLogger } from '../../src/logger.js';
import { SecretUsageRepo } from '../../src/secrets/secret-usage-repo.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('SecretUsageRepo', () => {
  let pool: pg.Pool;
  let repo: SecretUsageRepo;
  const suffix = randomBytes(4).toString('hex');
  const nameA = `user.usage_rt_a_${suffix}`;
  const nameB = `user.usage_rt_b_${suffix}`;
  const nameTie = `user.usage_rt_tie_${suffix}`;
  const tied = new Date(Date.now() - 20_000);
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
    // Same timestamp twice: the one written second (higher seq) is the newer read.
    await write(nameTie, tied, 'web-browser');
    await write(nameTie, tied, 'http-fetch');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('lastUsedByName returns the newest access for each name asked, and omits a never-read one', async () => {
    const never = `user.usage_rt_never_${suffix}`;
    const last = await repo.lastUsedByName([nameA, nameB, never]);
    expect(last.get(nameA)?.getTime()).toBe(newer.getTime());
    expect(last.get(nameB)?.getTime()).toBe(other.getTime());
    expect(last.has(never)).toBe(false);
    expect([...last.keys()].sort()).toEqual([nameA, nameB].sort());
    expect((await repo.lastUsedByName([])).size).toBe(0);
  });

  it('recentUses breaks a timestamp tie by seq, newest write first', async () => {
    const [first] = await repo.recentUses(nameTie, 1);
    expect(first!.toolName).toBe('http-fetch');
  });

  it('recentUses honors the limit and orders newest first', async () => {
    const uses = await repo.recentUses(nameA, 1);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.at.getTime()).toBe(newer.getTime());
    expect(uses[0]!.toolName).toBe('http-fetch');
    expect(uses[0]!.agentId).toBe('travel');
    expect(uses[0]!.source).toBe('vault');
    expect(uses[0]!.byReference).toBe(false);

    const both = await repo.recentUses(nameA, 5);
    expect(both.map((u) => u.toolName)).toEqual(['http-fetch', 'web-browser']);
  });

  it('recentUses is empty for a secret never read', async () => {
    expect(await repo.recentUses(`user.usage_rt_none_${suffix}`, 5)).toEqual([]);
  });
});
