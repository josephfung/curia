// Integration tests — require a live Postgres with migrations applied.
// Skips automatically when DATABASE_URL is unset (CI without Postgres).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import type { CreditCardPublicFields, CreditCardSecretDoc } from '../../src/secrets/structured-secret-schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });
const KEY = randomBytes(32);

describeIf('SecretsService', () => {
  let pool: pg.Pool;
  let service: SecretsService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM secrets LIMIT 0'); // sanity: migration applied
    service = new SecretsService(pool, KEY, logger);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM secrets WHERE name LIKE 'test_%' OR name LIKE 'user.test_%' OR name LIKE 'channel.test_%'");
    await pool.query("DELETE FROM user_secret_details WHERE name LIKE 'user.test_%'");
  });

  afterAll(async () => {
    await pool.end();
  });

  it('set then get round-trips a string', async () => {
    await service.set('test_api_key', 'tok-123');
    expect(await service.get('test_api_key')).toBe('tok-123');
  });

  it('stores ciphertext, not plaintext', async () => {
    await service.set('test_api_key', 'tok-123');
    const { rows } = await pool.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM secrets WHERE name = $1', ['test_api_key']);
    expect(rows[0]!.encrypted_value).not.toContain('tok-123');
  });

  it('get returns null for a missing secret', async () => {
    expect(await service.get('test_absent')).toBeNull();
  });

  it('setJSON then getJSON round-trips an OAuth-shaped object', async () => {
    const tokens = { access_token: 'a', refresh_token: 'r', expiry: 123, scope: 's' };
    await service.setJSON('test_oauth', tokens);
    expect(await service.getJSON('test_oauth')).toEqual(tokens);
  });

  it('setJSON then getJSON round-trips a browser-session-shaped object', async () => {
    const state = { cookies: [{ name: 'sid', value: 'x' }], origins: [] };
    await service.setJSON('test_session', state);
    expect(await service.getJSON('test_session')).toEqual(state);
  });

  it('get on a json row returns the serialized text', async () => {
    await service.setJSON('test_json', { a: 1 });
    expect(await service.get('test_json')).toBe('{"a":1}');
  });

  it('getJSON on a string row throws a format mismatch', async () => {
    await service.set('test_str', 'plain');
    await expect(service.getJSON('test_str')).rejects.toThrow(/expected 'json'/);
  });

  it('set overwrites an existing secret (upsert) with a fresh IV', async () => {
    await service.set('test_rot', 'v1');
    const first = await pool.query<{ iv: string }>('SELECT iv FROM secrets WHERE name = $1', ['test_rot']);
    await service.set('test_rot', 'v2');
    const second = await pool.query<{ iv: string }>('SELECT iv FROM secrets WHERE name = $1', ['test_rot']);
    expect(await service.get('test_rot')).toBe('v2');
    expect(second.rows[0]!.iv).not.toBe(first.rows[0]!.iv);
  });

  it('delete removes the row', async () => {
    await service.set('test_del', 'x');
    await service.delete('test_del');
    expect(await service.get('test_del')).toBeNull();
  });

  it('list returns configured key names only (no values)', async () => {
    await service.set('test_list_a', 'secret-a');
    await service.setJSON('test_list_b', { token: 'secret-b' });
    const names = await service.list();
    expect(names).toContain('test_list_a');
    expect(names).toContain('test_list_b');
    // Values must never appear — list() returns names only.
    expect(names).not.toContain('secret-a');
    expect(JSON.stringify(names)).not.toContain('secret-b');
  });

  it('upsertUserDetails stores sign-in details and merges later partial updates (#2201)', async () => {
    await service.upsertUserDetails('user.test_insurer', { loginUrl: 'https://id.example.com/', username: 'someone' });
    await service.upsertUserDetails('user.test_insurer', { username: 'someone-else' });
    const details = await service.listUserDetails();
    expect(details.get('user.test_insurer')).toEqual({ loginUrl: 'https://id.example.com/', username: 'someone-else' });
  });

  it('upsertUserDetails refuses a non-user key, and the table enforces it too (#2201)', async () => {
    await expect(service.upsertUserDetails('test_api_key', { username: 'x' })).rejects.toThrow(/user\.\*/);
    await expect(pool.query("INSERT INTO user_secret_details (name) VALUES ('test_api_key')")).rejects.toThrow();
  });

  it('listUserNames returns only user.* keys, never values or system/channel names', async () => {
    await service.set('user.test_listed', 'user-secret-value');
    await service.set('test_anthropic_standin', 'sys-secret-value');
    await service.set('channel.test_listed', 'channel-secret-value');
    const names = await service.listUserNames();
    expect(names).toContain('user.test_listed');
    expect(names).not.toContain('test_anthropic_standin');
    expect(names).not.toContain('channel.test_listed');
    expect(names.every(n => n.startsWith('user.'))).toBe(true);
    expect(JSON.stringify(names)).not.toContain('user-secret-value');
    expect(JSON.stringify(names)).not.toContain('sys-secret-value');
  });
  describe('metadata and detail edits', () => {
    const P = 'user.svc_meta_';
    beforeEach(async () => {
      await pool.query("DELETE FROM secrets WHERE name LIKE 'user.svc_meta_%'");
      await pool.query("DELETE FROM user_secret_details WHERE name LIKE 'user.svc_meta_%'");
    });
    afterEach(async () => {
      await pool.query("DELETE FROM secrets WHERE name LIKE 'user.svc_meta_%'");
      await pool.query("DELETE FROM user_secret_details WHERE name LIKE 'user.svc_meta_%'");
    });

    it('listMetadata returns format and dates without values', async () => {
      await service.set(`${P}a`, 'v1');
      await service.setJSON(`${P}b`, { x: 1 });
      const rows = (await service.listMetadata()).filter(r => r.name.startsWith(P));
      const a = rows.find(r => r.name === `${P}a`)!;
      const b = rows.find(r => r.name === `${P}b`)!;
      expect(a.valueFormat).toBe('string');
      expect(b.valueFormat).toBe('json');
      expect(a.createdAt).toBeInstanceOf(Date);
      expect(a.updatedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(rows)).not.toContain('v1');
    });

    it('updated_at moves on set, created_at does not', async () => {
      const n = `${P}ts`;
      await service.set(n, 'one');
      const first = (await service.listMetadata()).find(r => r.name === n)!;
      await new Promise(r => setTimeout(r, 10));
      await service.set(n, 'two');
      const second = (await service.listMetadata()).find(r => r.name === n)!;
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    });

    it('patchUserDetails keeps omitted and clears null', async () => {
      const n = `${P}patch`;
      await service.upsertUserDetails(n, { loginUrl: 'https://a.com/', username: 'u' });
      await service.patchUserDetails(n, { username: null });
      expect((await service.listUserDetails()).get(n)).toEqual({ loginUrl: 'https://a.com/' });
      await service.patchUserDetails(n, { loginUrl: 'https://b.com/' });
      expect((await service.listUserDetails()).get(n)).toEqual({ loginUrl: 'https://b.com/' });
    });

    it('patchUserDetails inserts when no row exists and refuses a non-user key', async () => {
      const n = `${P}fresh`;
      await service.patchUserDetails(n, { username: 'newbie' });
      expect((await service.listUserDetails()).get(n)).toEqual({ username: 'newbie' });
      await expect(service.patchUserDetails('test_api_key', { username: 'x' })).rejects.toThrow(/user\.\*/);
    });

    it('deleteUserDetails removes the row and is idempotent', async () => {
      const n = `${P}del`;
      await service.upsertUserDetails(n, { username: 'u' });
      await service.deleteUserDetails(n);
      expect((await service.listUserDetails()).has(n)).toBe(false);
      await expect(service.deleteUserDetails(n)).resolves.toBeUndefined();
    });
  });

  describe('credit cards', () => {
    const P = 'user.test_card_';
    const SECRET: CreditCardSecretDoc = { _schema: 'credit_card', number: '4111111111111111', cvv: '123' };
    const PUB: CreditCardPublicFields = {
      brand: 'visa', last4: '1111', expiry_month: '09', expiry_year: '2031', cardholder_name: 'Pat Doe',
    };
    const wipe = async (): Promise<void> => {
      await pool.query("DELETE FROM secrets WHERE name LIKE 'user.test_card_%'");
      await pool.query("DELETE FROM user_secret_details WHERE name LIKE 'user.test_card_%'");
    };
    beforeEach(wipe);
    afterEach(wipe);

    it('setCard writes both halves', async () => {
      const n = `${P}both`;
      await service.upsertUserDetails(n, { loginUrl: 'https://shop.example/', username: 'pat' });
      await service.setCard(n, SECRET, PUB, 'Personal');
      expect(await service.getCardPublic(n)).toEqual({ label: 'Personal', publicFields: PUB });
      expect(await service.getCardSecret(n)).toEqual(SECRET);
      expect(await service.getStructuredSchema(n)).toBe('credit_card');
      const raw = await service.get(n);
      expect(raw).not.toContain('expiry');
      expect(raw).not.toContain('Pat Doe');
      // Existing sign-in details survive, and listUserDetails returns the card fields.
      const d = (await service.listUserDetails()).get(n)!;
      expect(d).toEqual({
        loginUrl: 'https://shop.example/', username: 'pat',
        schema: 'credit_card', label: 'Personal', publicFields: PUB,
      });
    });

    it('setCard is atomic', async () => {
      const n = `${P}atomic`;
      const realConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
      const failing = {
        connect: async () => {
          const client = await realConnect();
          const realQuery = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
          // Pooled clients are reused: put the real query back when this one is released.
          const realRelease = client.release.bind(client);
          client.release = ((err?: Error | boolean) => {
            client.query = realQuery as unknown as typeof client.query;
            client.release = realRelease;
            realRelease(err);
          }) as typeof client.release;
          client.query = ((...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : '';
            if (text.includes('user_secret_details') && text.includes('INSERT')) {
              return Promise.reject(new Error('forced details failure'));
            }
            return realQuery(...args);
          }) as typeof client.query;
          return client;
        },
        query: pool.query.bind(pool),
      } as unknown as pg.Pool;
      const svc = new SecretsService(failing, KEY, logger);
      await expect(svc.setCard(n, SECRET, PUB, null)).rejects.toThrow('forced details failure');
      const { rows } = await pool.query('SELECT 1 FROM secrets WHERE name = $1', [n]);
      expect(rows).toHaveLength(0);
    });

    it('patchCardPublic leaves secrets.updated_at unchanged', async () => {
      const n = `${P}patch`;
      await service.setCard(n, SECRET, PUB, 'Old');
      const before = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM secrets WHERE name = $1', [n]);
      await new Promise(r => setTimeout(r, 10));
      await service.patchCardPublic(n, { label: 'New', publicFields: { ...PUB, cardholder_name: 'Sam Roe' } });
      const after = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM secrets WHERE name = $1', [n]);
      expect(after.rows[0]!.updated_at.getTime()).toBe(before.rows[0]!.updated_at.getTime());
      const pub = await service.getCardPublic(n);
      expect(pub?.label).toBe('New');
      expect(pub?.publicFields.cardholder_name).toBe('Sam Roe');
      await service.patchCardPublic(n, { label: null });
      expect((await service.getCardPublic(n))?.label).toBeNull();
    });

    it('replaceCardSecret cvv keeps number', async () => {
      const n = `${P}cvv`;
      await service.setCard(n, SECRET, PUB, null);
      await service.replaceCardSecret(n, { cvv: '999' });
      expect(await service.getCardSecret(n)).toEqual({ ...SECRET, cvv: '999' });
    });

    it('replaceCardSecret with a full doc replaces both halves', async () => {
      const n = `${P}full`;
      await service.setCard(n, SECRET, PUB, 'Keep');
      const next: CreditCardSecretDoc = { _schema: 'credit_card', number: '5555555555554444', cvv: '321' };
      const nextPub: CreditCardPublicFields = { ...PUB, brand: 'mastercard', last4: '4444' };
      await service.replaceCardSecret(n, { secret: next, publicFields: nextPub });
      expect(await service.getCardSecret(n)).toEqual(next);
      expect(await service.getCardPublic(n)).toEqual({ label: 'Keep', publicFields: nextPub });
    });

    it('getCardSecret refuses a non-card secret', async () => {
      const n = `${P}notcard`;
      await service.setJSON(n, { hello: 'world' });
      await expect(service.getCardSecret(n)).rejects.toThrow(/credit_card/);
    });

    it('getCardPublic and getStructuredSchema do not decrypt', async () => {
      const n = `${P}nodecrypt`;
      await service.setCard(n, SECRET, PUB, null);
      const g = vi.spyOn(service, 'get');
      const gj = vi.spyOn(service, 'getJSON');
      await service.getCardPublic(n);
      await service.getStructuredSchema(n);
      expect(g).not.toHaveBeenCalled();
      expect(gj).not.toHaveBeenCalled();
      expect(await service.getCardPublic(`${P}missing`)).toBeNull();
      expect(await service.getStructuredSchema(`${P}missing`)).toBeNull();
    });
  });
});
