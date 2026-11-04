// CardUseRepo over a real card_use_requests table (migration 118). Windows use the DB clock, so
// back-dating created_at / approved_at via SQL exercises the 30-minute bounds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { CardUseRepo } from '../../src/secrets/card-use-repo.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('CardUseRepo', () => {
  let pool: pg.Pool;
  let repo: CardUseRepo;
  const suffix = randomBytes(4).toString('hex');
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    repo = new CardUseRepo(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM card_use_requests WHERE secret_name LIKE $1`, [`user.cu_${suffix}%`]);
    await pool.end();
  });

  // Each test gets its own secret name + conversation so grants never leak between tests.
  function fixture() {
    seq += 1;
    return { secretName: `user.cu_${suffix}_${seq}`, conversationId: `conv-${suffix}-${seq}` };
  }

  async function createApproved(f: { secretName: string; conversationId: string }, siteUrl = 'https://www.aircanada.com/checkout') {
    const { id } = await repo.create({
      ...f,
      siteUrl,
      taskId: 'task-1',
      amount: 'CAD 100.00',
      purpose: 'flight',
      origin: { conversationId: f.conversationId },
    });
    expect(await repo.approve(id)).toBe('approved');
    return id;
  }

  it('create stores the registrable domain and round-trips through get', async () => {
    const f = fixture();
    const { id, siteDomain } = await repo.create({
      ...f,
      siteUrl: 'https://www.aircanada.com/checkout',
      taskId: 't',
      amount: '1',
      purpose: 'p',
      origin: { agentId: 'travel' },
    });
    expect(siteDomain).toBe('aircanada.com');
    await repo.setShortRef(id, 'ab12');
    const row = await repo.get(id);
    expect(row).toMatchObject({
      id,
      secretName: f.secretName,
      siteDomain: 'aircanada.com',
      status: 'pending',
      approvalShortRef: 'ab12',
      origin: { agentId: 'travel' },
      approvedAt: null,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(await repo.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('create throws when the site has no registrable domain', async () => {
    const f = fixture();
    await expect(
      repo.create({ ...f, siteUrl: 'http://127.0.0.1/x', taskId: 't', amount: '1', purpose: 'p', origin: {} }),
    ).rejects.toThrow();
  });

  it('grant matches subdomain of approved site, refuses other top-level site', async () => {
    const f = fixture();
    await createApproved(f);
    const q = { ...f, field: 'number' as const };
    expect(await repo.consumeFill({ ...q, siteUrl: 'https://pay.aircanada.com/x' })).toBe('ok');
    expect(await repo.consumeFill({ ...q, siteUrl: 'https://checkout.example-pay.com' })).toBe('no_grant');
  });

  it('third number fill is refused', async () => {
    const f = fixture();
    await createApproved(f);
    const q = { ...f, siteUrl: 'https://www.aircanada.com', field: 'number' as const };
    expect(await repo.consumeFill(q)).toBe('ok');
    expect(await repo.consumeFill(q)).toBe('ok');
    expect(await repo.consumeFill(q)).toBe('fill_limit');
    // CVV has its own counter.
    expect(await repo.consumeFill({ ...q, field: 'cvv' })).toBe('ok');
  });

  it('public-field fills are unlimited', async () => {
    const f = fixture();
    await createApproved(f);
    const q = { ...f, siteUrl: 'https://www.aircanada.com', field: null };
    for (let i = 0; i < 5; i++) expect(await repo.consumeFill(q)).toBe('ok');
  });

  it('grant older than 30 minutes is refused', async () => {
    const f = fixture();
    const id = await createApproved(f);
    await pool.query(`UPDATE card_use_requests SET approved_at = now() - interval '31 minutes' WHERE id = $1`, [id]);
    expect(
      await repo.consumeFill({ ...f, siteUrl: 'https://www.aircanada.com', field: 'number' }),
    ).toBe('no_grant');
  });

  it('approve after 30 minutes expires the row', async () => {
    const f = fixture();
    const { id } = await repo.create({
      ...f,
      siteUrl: 'https://www.aircanada.com',
      taskId: 't',
      amount: '1',
      purpose: 'p',
      origin: {},
    });
    await pool.query(`UPDATE card_use_requests SET created_at = now() - interval '31 minutes' WHERE id = $1`, [id]);
    expect(await repo.approve(id)).toBe('expired');
    expect((await repo.get(id))?.status).toBe('expired');
  });

  it('second approve is already_resolved', async () => {
    const f = fixture();
    const id = await createApproved(f);
    expect(await repo.approve(id)).toBe('already_resolved');
  });

  it('decide resolves a pending row once', async () => {
    const f = fixture();
    const { id } = await repo.create({
      ...f,
      siteUrl: 'https://www.aircanada.com',
      taskId: 't',
      amount: '1',
      purpose: 'p',
      origin: {},
    });
    expect(await repo.decide(id, 'denied')).toBe(true);
    expect(await repo.decide(id, 'expired')).toBe(false);
    expect(await repo.approve(id)).toBe('already_resolved');
    expect((await repo.get(id))?.status).toBe('denied');
  });

  it('other conversation has no grant', async () => {
    const f = fixture();
    await createApproved(f);
    expect(
      await repo.consumeFill({
        secretName: f.secretName,
        conversationId: `${f.conversationId}-other`,
        siteUrl: 'https://www.aircanada.com',
        field: 'number',
      }),
    ).toBe('no_grant');
  });

  it('concurrent number fills never exceed 2', async () => {
    const f = fixture();
    await createApproved(f);
    const q = { ...f, siteUrl: 'https://www.aircanada.com', field: 'number' as const };
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.consumeFill(q)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r === 'fill_limit')).toHaveLength(3);
  });
});
