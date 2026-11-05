// Integration tests for card capture links (#1358, Task 10) — real Postgres, real vault.
// Skips automatically when DATABASE_URL is unset (CI without Postgres).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { SecretCaptureService } from '../../src/secrets/secret-capture-service.js';
import type { CreditCardPublicFields, CreditCardSecretDoc } from '../../src/secrets/structured-secret-schema.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });
const KEY = randomBytes(32);

const NEXT_YEAR = String(new Date().getUTCFullYear() + 1);
const LATER_YEAR = String(new Date().getUTCFullYear() + 3);
const LAST_YEAR = String(new Date().getUTCFullYear() - 1);

const validCard = {
  number: '4111 1111 1111 1111',
  cvv: '123',
  expiry_month: '12',
  expiry_year: NEXT_YEAR,
  cardholder_name: 'Test Person',
  billing_zip: 'M5V 2T6',
};

const storedSecret: CreditCardSecretDoc = { _schema: 'credit_card', number: '4111111111111111', cvv: '123' };
const storedPublic: CreditCardPublicFields = {
  brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: NEXT_YEAR, cardholder_name: 'Test Person',
};

describeIf('card capture links', () => {
  let pool: pg.Pool;
  let secrets: SecretsService;
  let capture: SecretCaptureService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    await pool.query('SELECT capture_template FROM secret_capture_tokens LIMIT 0'); // sanity: migration 119 applied
    secrets = new SecretsService(pool, KEY, logger);
    capture = new SecretCaptureService(pool, secrets, { getAllowedSystemNames: () => new Set(), logger });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM secret_capture_tokens WHERE secret_name LIKE 'user.cardcap%'");
    await pool.query("DELETE FROM secrets WHERE name LIKE 'user.cardcap%'");
    await pool.query("DELETE FROM user_secret_details WHERE name LIKE 'user.cardcap%'");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function tokenRow(secretName: string) {
    const { rows } = await pool.query<{ value_format: string; capture_template: string | null; consumed_at: Date | null; label: string | null }>(
      'SELECT value_format, capture_template, consumed_at, label FROM secret_capture_tokens WHERE secret_name = $1',
      [secretName],
    );
    return rows;
  }

  async function saveCard(name: string): Promise<void> {
    await secrets.setCard(name, storedSecret, storedPublic, 'Personal');
  }

  it('credit_card token forces json', async () => {
    const minted = await capture.mintUserSecret({ rawName: 'cardcap1 visa card', template: 'credit_card', valueFormat: 'string', label: 'Personal' });
    const rows = await tokenRow(minted.secretName);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value_format: 'json', capture_template: 'credit_card', label: 'Personal' });
  });

  it('valid card redeems via setCard with _schema stamped', async () => {
    const minted = await capture.mintUserSecret({ rawName: 'cardcap2 visa card', template: 'credit_card', label: 'Personal' });
    const out = await capture.redeemCard(minted.rawToken, validCard);
    expect(out.status).toBe('ok');

    expect(await secrets.getCardSecret(minted.secretName)).toEqual({ _schema: 'credit_card', number: '4111111111111111', cvv: '123' });
    const pub = await secrets.getCardPublic(minted.secretName);
    expect(pub?.label).toBe('Personal');
    expect(pub?.publicFields).toMatchObject({ brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: NEXT_YEAR, cardholder_name: 'Test Person', billing_zip: 'M5V 2T6' });
  });

  it('Luhn failure → invalid_shape, token re-redeemable', async () => {
    const minted = await capture.mintUserSecret({ rawName: 'cardcap3 visa card', template: 'credit_card' });
    const bad = await capture.redeemCard(minted.rawToken, { ...validCard, number: '4111111111111112' });
    expect(bad).toEqual({ status: 'invalid_shape', reason: 'number_checksum' });
    expect((await tokenRow(minted.secretName))[0]!.consumed_at).toBeNull();
    expect(await secrets.getCardPublic(minted.secretName)).toBeNull();

    const good = await capture.redeemCard(minted.rawToken, validCard);
    expect(good.status).toBe('ok');
  });

  it('expired card → invalid_shape', async () => {
    const minted = await capture.mintUserSecret({ rawName: 'cardcap4 visa card', template: 'credit_card' });
    const out = await capture.redeemCard(minted.rawToken, { ...validCard, expiry_year: LAST_YEAR });
    expect(out).toEqual({ status: 'invalid_shape', reason: 'expired' });
    expect((await tokenRow(minted.secretName))[0]!.consumed_at).toBeNull();
  });

  it('concurrent valid redeems: exactly one ok', async () => {
    const minted = await capture.mintUserSecret({ rawName: 'cardcap5 visa card', template: 'credit_card' });
    const outs = await Promise.all(Array.from({ length: 5 }, () => capture.redeemCard(minted.rawToken, validCard)));
    expect(outs.filter(o => o.status === 'ok')).toHaveLength(1);
    expect(outs.filter(o => o.status === 'expired')).toHaveLength(4);
  });

  it('a plain value cannot be redeemed on a card token, and a card cannot be redeemed on a plain token', async () => {
    const cardTok = await capture.mintUserSecret({ rawName: 'cardcap6 visa card', template: 'credit_card' });
    expect(await capture.redeem(cardTok.rawToken, '{"_schema":"credit_card","number":"1","cvv":"2"}')).toEqual({ status: 'invalid_shape' });
    expect((await tokenRow(cardTok.secretName))[0]!.consumed_at).toBeNull();
    expect(await secrets.get(cardTok.secretName)).toBeNull();

    const plainTok = await capture.mintUserSecret({ rawName: 'cardcap6 other password' });
    expect(await capture.redeemCard(plainTok.rawToken, validCard)).toEqual({ status: 'invalid_shape' });
    expect((await tokenRow(plainTok.secretName))[0]!.consumed_at).toBeNull();
  });

  it('renewal keeps the number, updates expiry and cvv', async () => {
    await saveCard('user.cardcap7_visa_card');
    const minted = await capture.mintUserSecret({ rawName: 'user.cardcap7_visa_card', template: 'credit_card_renewal' });
    expect(minted.secretName).toBe('user.cardcap7_visa_card');
    expect((await tokenRow(minted.secretName))[0]).toMatchObject({ value_format: 'json', capture_template: 'credit_card_renewal', label: 'Personal' });

    const meta = await capture.getMetadata(minted.rawToken);
    expect(meta).toMatchObject({ captureTemplate: 'credit_card_renewal', card: { brand: 'visa', last4: '1111', label: 'Personal' } });

    const out = await capture.redeemCard(minted.rawToken, { cvv: '987', expiry_month: '3', expiry_year: LATER_YEAR });
    expect(out.status).toBe('ok');
    expect(await secrets.getCardSecret(minted.secretName)).toEqual({ _schema: 'credit_card', number: '4111111111111111', cvv: '987' });
    const pub = await secrets.getCardPublic(minted.secretName);
    expect(pub?.publicFields).toMatchObject({ expiry_month: '03', expiry_year: LATER_YEAR, last4: '1111', cardholder_name: 'Test Person' });
    expect(pub?.label).toBe('Personal');
  });

  it('renewal with a bad cvv or an expired date is refused and leaves the token unspent', async () => {
    await saveCard('user.cardcap8_visa_card');
    const minted = await capture.mintUserSecret({ rawName: 'user.cardcap8_visa_card', template: 'credit_card_renewal' });
    expect(await capture.redeemCard(minted.rawToken, { cvv: '12345', expiry_month: '1', expiry_year: LATER_YEAR }))
      .toEqual({ status: 'invalid_shape', reason: 'cvv_format' });
    expect(await capture.redeemCard(minted.rawToken, { cvv: '123', expiry_month: '1', expiry_year: LAST_YEAR }))
      .toEqual({ status: 'invalid_shape', reason: 'expired' });
    expect(await capture.redeemCard(minted.rawToken, { cvv: '123' }))
      .toEqual({ status: 'invalid_shape', reason: 'expiry_format' });
    expect((await tokenRow(minted.secretName))[0]!.consumed_at).toBeNull();
    expect((await secrets.getCardSecret(minted.secretName)).cvv).toBe('123');
  });

  it('renewal whose card was removed is refused as card_missing, not not_found', async () => {
    await saveCard('user.cardcap10_visa_card');
    const minted = await capture.mintUserSecret({ rawName: 'user.cardcap10_visa_card', template: 'credit_card_renewal' });
    await secrets.delete('user.cardcap10_visa_card');
    expect(await capture.redeemCard(minted.rawToken, { cvv: '123', expiry_month: '1', expiry_year: LATER_YEAR }))
      .toEqual({ status: 'invalid_shape', reason: 'card_missing' });
  });

  it('renewal on a non-card key errors at mint', async () => {
    await secrets.set('user.cardcap9_other_password', 'hunter2');
    await expect(capture.mintUserSecret({ rawName: 'user.cardcap9_other_password', template: 'credit_card_renewal' }))
      .rejects.toThrow(/No saved card named/);
    await expect(capture.mintUserSecret({ rawName: 'cardcap9 missing visa card', template: 'credit_card_renewal' }))
      .rejects.toThrow(/No saved card named/);
    expect(await tokenRow('user.cardcap9_other_password')).toHaveLength(0);
  });

  it('details_only updates card label and expiry with no link and no secrets.updated_at change', async () => {
    await saveCard('user.cardcap10_visa_card');
    const before = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM secrets WHERE name = $1', ['user.cardcap10_visa_card']);

    const { secretName } = await capture.setUserCardPublic('user.cardcap10_visa_card', { label: 'Work', expiry_month: '6', expiry_year: LATER_YEAR });
    expect(secretName).toBe('user.cardcap10_visa_card');

    const pub = await secrets.getCardPublic(secretName);
    expect(pub?.label).toBe('Work');
    expect(pub?.publicFields).toMatchObject({ expiry_month: '06', expiry_year: LATER_YEAR });
    const after = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM secrets WHERE name = $1', [secretName]);
    expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at);
    expect(await tokenRow(secretName)).toHaveLength(0);
  });

  it('details_only past expiry is refused', async () => {
    await saveCard('user.cardcap11_visa_card');
    await expect(capture.setUserCardPublic('user.cardcap11_visa_card', { expiry_month: '1', expiry_year: LAST_YEAR }))
      .rejects.toThrow('This card has expired.');
    expect((await secrets.getCardPublic('user.cardcap11_visa_card'))?.publicFields.expiry_year).toBe(NEXT_YEAR);
  });

  it('details_only on a key that is not a saved card is refused', async () => {
    await secrets.set('user.cardcap12_other_password', 'hunter2');
    await expect(capture.setUserCardPublic('user.cardcap12_other_password', { label: 'x' })).rejects.toThrow(/No saved card named/);
  });

  it('re-capturing a saved card keeps its label unless card_label is explicit', async () => {
    await secrets.setCard('user.cardcap13_visa_card', storedSecret, storedPublic, 'Work');
    const derived = await capture.mintUserSecret({ rawName: 'cardcap13 visa card', template: 'credit_card', label: 'Cardcap13', labelDerived: true });
    expect(derived.secretName).toBe('user.cardcap13_visa_card');
    expect((await capture.redeemCard(derived.rawToken, validCard)).status).toBe('ok');
    expect((await secrets.getCardPublic(derived.secretName))?.label).toBe('Work');

    const unlabelled = await capture.mintUserSecret({ rawName: 'cardcap13 visa card', template: 'credit_card' });
    expect((await capture.redeemCard(unlabelled.rawToken, validCard)).status).toBe('ok');
    expect((await secrets.getCardPublic(derived.secretName))?.label).toBe('Work');

    const explicit = await capture.mintUserSecret({ rawName: 'cardcap13 visa card', template: 'credit_card', label: 'Travel' });
    expect((await capture.redeemCard(explicit.rawToken, validCard)).status).toBe('ok');
    expect((await secrets.getCardPublic(derived.secretName))?.label).toBe('Travel');
  });

  it('refuses a card capture over a stored secret that is not a card', async () => {
    await secrets.set('user.cardcap14_visa_card', 'hunter2');
    await expect(capture.mintUserSecret({ rawName: 'user.cardcap14_visa_card', template: 'credit_card' }))
      .rejects.toThrow(/user\.cardcap14_visa_card.*not a saved card/);
    expect(await tokenRow('user.cardcap14_visa_card')).toHaveLength(0);
    expect(await secrets.get('user.cardcap14_visa_card')).toBe('hunter2');
  });
});
