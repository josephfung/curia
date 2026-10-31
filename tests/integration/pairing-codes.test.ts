// Two phones redeeming one pairing code: only one UPDATE wins (#2341).
// Skips when DATABASE_URL is unset. CI migrates before the suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { consumePairingCode, mintPairingCode } from '../../src/channels/http/pairing.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

function tokenFrom(pairUrl: string): string {
  return decodeURIComponent(new URL(pairUrl).hash.replace(/^#c=/, ''));
}

describeIf('pairing codes (integration)', () => {
  let pool: pg.Pool;
  const created: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT redeemed_device_name FROM pairing_codes LIMIT 0');
  });

  afterAll(async () => {
    try {
      if (created.length > 0) {
        await pool.query('DELETE FROM pairing_codes WHERE id = ANY($1::uuid[])', [created]);
      }
    } finally {
      await pool.end();
    }
  });

  it('lets one of two concurrent token redeems win, and rejects a replay', async () => {
    const minted = await mintPairingCode(pool, 'https://curia.example.com');
    created.push(minted.id);
    const token = tokenFrom(minted.pairUrl);
    const [first, second] = await Promise.all([
      consumePairingCode(pool, { kind: 'token', token }, 'iPhone'),
      consumePairingCode(pool, { kind: 'token', token }, 'iPhone'),
    ]);
    const wins = [first, second].filter((row) => row !== null);
    expect(wins).toHaveLength(1);
    await expect(consumePairingCode(pool, { kind: 'token', token }, 'iPhone')).resolves.toBeNull();
  });

  it('rejects an expired code and a second use of the short code', async () => {
    const minted = await mintPairingCode(pool, 'https://curia.example.com');
    created.push(minted.id);
    await pool.query(`UPDATE pairing_codes SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [minted.id]);
    const token = tokenFrom(minted.pairUrl);
    await expect(consumePairingCode(pool, { kind: 'token', token }, 'iPhone')).resolves.toBeNull();

    const live = await mintPairingCode(pool, 'https://curia.example.com');
    created.push(live.id);
    const code = live.shortCode.replace('-', '');
    const used = await consumePairingCode(pool, { kind: 'short', code }, 'iPhone');
    expect(used?.id).toBe(live.id);
    await expect(consumePairingCode(pool, { kind: 'short', code }, 'iPhone')).resolves.toBeNull();
  });

  it('caps the short code at two minutes after the token is redeemed', async () => {
    const minted = await mintPairingCode(pool, 'https://curia.example.com');
    created.push(minted.id);
    const consumed = await consumePairingCode(pool, { kind: 'token', token: tokenFrom(minted.pairUrl) }, 'iPhone');
    expect(consumed?.otherAlreadyRedeemed).toBe(false);
    const row = await pool.query<{ expires_at: Date; short_redeemed_at: Date | null }>(
      'SELECT expires_at, short_redeemed_at FROM pairing_codes WHERE id = $1',
      [minted.id],
    );
    const expiresAt = row.rows[0]?.expires_at;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt!.getTime()).toBeLessThan(Date.now() + 3 * 60 * 1000);
    expect(row.rows[0]?.short_redeemed_at).toBeNull();
    const code = minted.shortCode.replace('-', '');
    const second = await consumePairingCode(pool, { kind: 'short', code }, 'iPad');
    expect(second).toMatchObject({ id: minted.id, otherAlreadyRedeemed: true });
  });
});
