// The phone app invitation link against real Postgres (#2412): one current
// link, 48 hours, single use, and a new link stops the old one.
// Skips when DATABASE_URL is unset. CI migrates before the suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  cancelInvitation,
  consumeInvitation,
  mintInvitation,
  readCurrentInvitation,
  recordPairedNotice,
  releaseInvitation,
  stopInvitation,
} from '../../src/channels/http/pairing-invitations.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

function tokenFrom(pairUrl: string): string {
  return decodeURIComponent(new URL(pairUrl).hash.replace(/^#c=/, ''));
}

describeIf('pairing invitations (integration)', () => {
  let pool: pg.Pool;
  let verified = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // These tests delete every invitation, so refuse anything but curia_test.
    await requireCuriaTestDatabase(pool);
    verified = true;
    await pool.query('SELECT superseded_at FROM pairing_invitations LIMIT 0');
  });

  // The table holds one current row for the whole install, so each test starts empty.
  beforeEach(async () => {
    await pool.query('DELETE FROM pairing_invitations');
  });

  afterAll(async () => {
    try {
      if (verified) await pool.query('DELETE FROM pairing_invitations');
    } finally {
      await pool.end();
    }
  });

  it('stores only the hash, lasts 48 hours, and redeems once', async () => {
    const minted = await mintInvitation(pool, 'https://curia.example.com');
    const token = tokenFrom(minted.pairUrl);
    const stored = await pool.query<{ token_hash: string; expires_at: Date }>(
      'SELECT token_hash, expires_at FROM pairing_invitations WHERE id = $1',
      [minted.id],
    );
    expect(stored.rows[0]!.token_hash).not.toBe(token);
    const hours = (stored.rows[0]!.expires_at.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);

    const [first, second] = await Promise.all([
      consumeInvitation(pool, token, 'iPhone'),
      consumeInvitation(pool, token, 'iPhone'),
    ]);
    expect([first, second].filter((row) => row !== null)).toHaveLength(1);
    await expect(consumeInvitation(pool, token, 'iPhone')).resolves.toBeNull();
    await expect(readCurrentInvitation(pool)).resolves.toMatchObject({
      id: minted.id,
      state: 'redeemed',
      deviceName: 'iPhone',
    });
  });

  it('rejects the old link once a new one is minted', async () => {
    const old = await mintInvitation(pool, 'https://curia.example.com');
    const fresh = await mintInvitation(pool, 'https://curia.example.com');
    await expect(consumeInvitation(pool, tokenFrom(old.pairUrl), 'iPhone')).resolves.toBeNull();
    await expect(readCurrentInvitation(pool)).resolves.toMatchObject({ id: fresh.id, state: 'waiting' });
    await expect(consumeInvitation(pool, tokenFrom(fresh.pairUrl), 'iPhone')).resolves.toMatchObject({ id: fresh.id });
  });

  it('rejects an expired link and reports it as expired', async () => {
    const minted = await mintInvitation(pool, 'https://curia.example.com');
    await pool.query(
      `UPDATE pairing_invitations SET expires_at = NOW() - interval '1 minute' WHERE id = $1`,
      [minted.id],
    );
    await expect(consumeInvitation(pool, tokenFrom(minted.pairUrl), 'iPhone')).resolves.toBeNull();
    await expect(readCurrentInvitation(pool)).resolves.toMatchObject({ state: 'expired' });
  });

  it('leaves one current link when two mints race', async () => {
    const minted = await Promise.all([
      mintInvitation(pool, 'https://curia.example.com'),
      mintInvitation(pool, 'https://curia.example.com'),
      mintInvitation(pool, 'https://curia.example.com'),
    ]);
    const current = await pool.query<{ id: string }>(
      'SELECT id FROM pairing_invitations WHERE superseded_at IS NULL',
    );
    expect(current.rows).toHaveLength(1);
    const live = minted.filter((row) => row.id === current.rows[0]!.id);
    expect(live).toHaveLength(1);
    for (const row of minted) {
      const redeemed = await consumeInvitation(pool, tokenFrom(row.pairUrl), 'iPhone');
      expect(redeemed !== null).toBe(row.id === current.rows[0]!.id);
    }
  });

  it('stopping one link by id leaves a newer current link alone', async () => {
    const first = await mintInvitation(pool, 'https://curia.example.com');
    const second = await mintInvitation(pool, 'https://curia.example.com');
    // A failed mint's cleanup runs after another mint has superseded it.
    await expect(stopInvitation(pool, first.id)).resolves.toBe(false);
    await expect(readCurrentInvitation(pool)).resolves.toMatchObject({ id: second.id, state: 'waiting' });
    await expect(consumeInvitation(pool, tokenFrom(second.pairUrl), 'iPhone')).resolves.toMatchObject({ id: second.id });
  });

  it('a stopped link no longer redeems, and a released one works again', async () => {
    const minted = await mintInvitation(pool, 'https://curia.example.com');
    const token = tokenFrom(minted.pairUrl);
    const used = await consumeInvitation(pool, token, 'iPhone');
    expect(used?.id).toBe(minted.id);
    await releaseInvitation(pool, minted.id);
    await expect(readCurrentInvitation(pool)).resolves.toMatchObject({ state: 'waiting', deviceName: null });

    await expect(cancelInvitation(pool)).resolves.toBe(true);
    await expect(consumeInvitation(pool, token, 'iPhone')).resolves.toBeNull();
    await expect(readCurrentInvitation(pool)).resolves.toBeNull();
    await expect(cancelInvitation(pool)).resolves.toBe(false);
  });

  it('records a paired notice tied to the new phone', async () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    await recordPairedNotice(pool, sessionId, 'iPhone · Safari');
    try {
      const rows = await pool.query<{ kind: string; detail: string }>(
        'SELECT kind, detail FROM push_notices WHERE subject_session_id = $1',
        [sessionId],
      );
      expect(rows.rows).toEqual([{ kind: 'paired', detail: expect.stringContaining('iPhone · Safari') }]);
    } finally {
      await pool.query('DELETE FROM push_notices WHERE subject_session_id = $1', [sessionId]);
    }
  });
});
