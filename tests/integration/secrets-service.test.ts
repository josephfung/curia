// Integration tests — require a live Postgres with migrations applied.
// Skips automatically when DATABASE_URL is unset (CI without Postgres).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { SecretsService } from '../../src/secrets/secrets-service.js';

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
    await pool.query("DELETE FROM secrets WHERE name LIKE 'test_%'");
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
});
