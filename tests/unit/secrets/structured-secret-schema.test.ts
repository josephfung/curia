import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_FIELDS,
  CARD_SECRET_FIELDS,
  CARD_VALIDATION_MESSAGES,
  describeCard,
  detectCardBrand,
  isCardExpired,
  isCardSecretField,
  isStructuredSchemaTag,
  parseSecretRef,
  projectCardField,
  validateCardPublicPatch,
  validateCreditCard,
  validateCvv,
  type CreditCardPublicFields,
} from '../../../src/secrets/structured-secret-schema.js';

describe('validateCreditCard', () => {
  const now = new Date(Date.UTC(2026, 10, 4));
  const ok = { number: '4111 1111 1111 1111', cvv: '123', expiry_month: '3', expiry_year: '2028', cardholder_name: 'Pat Doe' };

  it('accepts a valid card and splits secret from public fields', () => {
    expect(validateCreditCard(ok, now)).toEqual({
      ok: true,
      secret: { _schema: 'credit_card', number: '4111111111111111', cvv: '123' },
      publicFields: { brand: 'visa', last4: '1111', expiry_month: '03', expiry_year: '2028', cardholder_name: 'Pat Doe' },
    });
  });
  it('accepts dashes in the number and keeps an optional billing zip', () => {
    const r = validateCreditCard({ ...ok, number: '4111-1111-1111-1111', billing_zip: 'N2L 3G1' }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.publicFields.billing_zip).toBe('N2L 3G1');
  });
  it('rejects a Luhn failure', () =>
    expect(validateCreditCard({ ...ok, number: '4111111111111112' }, now)).toEqual({ ok: false, reason: 'number_checksum' }));
  it('rejects a malformed number', () => {
    expect(validateCreditCard({ ...ok, number: '4111 abcd' }, now)).toEqual({ ok: false, reason: 'number_format' });
    expect(validateCreditCard({ ...ok, number: '41111111111' }, now)).toEqual({ ok: false, reason: 'number_format' });
    expect(validateCreditCard({ ...ok, number: 4111111111111111 }, now)).toEqual({ ok: false, reason: 'number_format' });
  });
  it('rejects last month, accepts this month', () => {
    expect(validateCreditCard({ ...ok, expiry_month: '10', expiry_year: '2026' }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(validateCreditCard({ ...ok, expiry_month: '11', expiry_year: '2026' }, now).ok).toBe(true);
  });
  it('rejects bad expiry formats', () => {
    expect(validateCreditCard({ ...ok, expiry_month: '13' }, now)).toEqual({ ok: false, reason: 'expiry_format' });
    expect(validateCreditCard({ ...ok, expiry_month: '0' }, now)).toEqual({ ok: false, reason: 'expiry_format' });
    expect(validateCreditCard({ ...ok, expiry_year: '28' }, now)).toEqual({ ok: false, reason: 'expiry_format' });
  });
  it('needs a 4-digit CVV for amex', () =>
    expect(validateCreditCard({ ...ok, number: '378282246310005', cvv: '123' }, now)).toEqual({ ok: false, reason: 'cvv_format' }));
  it('accepts a 4-digit CVV for amex and rejects 4 digits for visa', () => {
    expect(validateCreditCard({ ...ok, number: '378282246310005', cvv: '1234' }, now).ok).toBe(true);
    expect(validateCreditCard({ ...ok, cvv: '1234' }, now)).toEqual({ ok: false, reason: 'cvv_format' });
  });
  it('requires a cardholder name of at most 100 characters', () => {
    expect(validateCreditCard({ ...ok, cardholder_name: '  ' }, now)).toEqual({ ok: false, reason: 'cardholder_missing' });
    expect(validateCreditCard({ ...ok, cardholder_name: 'x'.repeat(101) }, now)).toEqual({ ok: false, reason: 'cardholder_missing' });
  });
  it('validates billing zip', () => {
    expect(validateCreditCard({ ...ok, billing_zip: 'bad!zip' }, now)).toEqual({ ok: false, reason: 'billing_zip_format' });
    expect(validateCreditCard({ ...ok, billing_zip: '1'.repeat(13) }, now)).toEqual({ ok: false, reason: 'billing_zip_format' });
  });
  it('has user-facing copy for every reason', () => {
    expect(CARD_VALIDATION_MESSAGES.number_checksum).toBe("That card number doesn't look right. Check it and try again.");
    expect(CARD_VALIDATION_MESSAGES.expired).toBe('This card has expired.');
  });
});

describe('validateCardPublicPatch', () => {
  const now = new Date(Date.UTC(2026, 10, 4));
  const current: CreditCardPublicFields = {
    brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: '2027', cardholder_name: 'Pat Doe', billing_zip: 'N2L',
  };
  it('applies a valid expiry pair and normalizes the month', () => {
    expect(validateCardPublicPatch({ expiry_month: '3', expiry_year: '2029' }, current, now)).toEqual({
      ok: true, publicFields: { ...current, expiry_month: '03', expiry_year: '2029' },
    });
  });
  it('validates month and year as a pair against current', () => {
    // Month alone, combined with the current year 2027, is fine; year alone 2026 with month 12 is fine too.
    expect(validateCardPublicPatch({ expiry_year: '2026' }, { ...current, expiry_month: '10' }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(validateCardPublicPatch({ expiry_month: '10' }, { ...current, expiry_year: '2026' }, now)).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects bad expiry formats', () =>
    expect(validateCardPublicPatch({ expiry_month: '14' }, current, now)).toEqual({ ok: false, reason: 'expiry_format' }));
  it('clears billing_zip with null and updates cardholder_name', () => {
    const r = validateCardPublicPatch({ billing_zip: null, cardholder_name: ' Sam Roe ' }, current, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.publicFields.billing_zip).toBeUndefined();
      expect(r.publicFields.cardholder_name).toBe('Sam Roe');
    }
  });
  it('rejects a bad zip and an empty name', () => {
    expect(validateCardPublicPatch({ billing_zip: '??' }, current, now)).toEqual({ ok: false, reason: 'billing_zip_format' });
    expect(validateCardPublicPatch({ cardholder_name: '' }, current, now)).toEqual({ ok: false, reason: 'cardholder_missing' });
  });
  it('leaves an already-expired card alone when the patch does not touch expiry', () => {
    const expired = { ...current, expiry_month: '01', expiry_year: '2026' };
    expect(validateCardPublicPatch({ cardholder_name: 'New Name' }, expired, now).ok).toBe(true);
  });
});

describe('validateCvv / isCardExpired / describeCard', () => {
  it('checks cvv length by brand', () => {
    expect(validateCvv('123', 'visa')).toBe(true);
    expect(validateCvv('1234', 'visa')).toBe(false);
    expect(validateCvv('1234', 'amex')).toBe(true);
    expect(validateCvv('123', 'amex')).toBe(false);
    expect(validateCvv(123, 'visa')).toBe(false);
  });
  it('isCardExpired is true only before the current UTC month', () => {
    const now = new Date(Date.UTC(2026, 10, 4));
    const base: CreditCardPublicFields = { brand: 'visa', last4: '1111', expiry_month: '11', expiry_year: '2026', cardholder_name: 'P' };
    expect(isCardExpired(base, now)).toBe(false);
    expect(isCardExpired({ ...base, expiry_month: '10' }, now)).toBe(true);
  });
  it('describes a card with and without a label', () => {
    const pub: CreditCardPublicFields = { brand: 'visa', last4: '1111', expiry_month: '11', expiry_year: '2026', cardholder_name: 'P' };
    expect(describeCard(pub, 'Personal')).toBe('Visa ••1111 (Personal)');
    expect(describeCard({ ...pub, brand: 'amex', last4: '0005' }, null)).toBe('Amex ••0005');
  });
});

describe('projectCardField', () => {
  const pub = { brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: '2027', cardholder_name: 'Pat Doe' } as const;
  afterEach(() => vi.restoreAllMocks());

  it.each([['expiry_mm', '12'], ['expiry_m', '12'], ['expiry_yy', '27'], ['expiry_yyyy', '2027'], ['expiry_mm_yy', '12/27'],
    ['expiry_mm_yyyy', '12/2027'], ['expiry_month_name', 'December'], ['expiry_month_short', 'Dec'],
    ['expiry_month', '12'], ['expiry_year', '2027'], ['cardholder_name', 'Pat Doe'], ['brand', 'visa']])('%s → %s', (f, v) =>
    expect(projectCardField(f, pub, null)).toBe(v));
  it('expiry_m is unpadded', () => expect(projectCardField('expiry_m', { ...pub, expiry_month: '03' }, null)).toBe('3'));
  it('billing_zip projects the stored value', () => expect(projectCardField('billing_zip', { ...pub, billing_zip: 'N2L 3G1' }, null)).toBe('N2L 3G1'));
  it('secret fields read the secret doc', () => {
    const secret = { _schema: 'credit_card', number: '4111111111111111', cvv: '123' } as const;
    expect(projectCardField('number', pub, secret)).toBe('4111111111111111');
    expect(projectCardField('cvv', pub, secret)).toBe('123');
  });
  it('month name ignores ambient locale', () => {
    const origLang = process.env['LANG'];
    const origAll = process.env['LC_ALL'];
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      process.env['LANG'] = 'fr_FR.UTF-8';
      process.env['LC_ALL'] = 'fr_FR.UTF-8';
      expect(projectCardField('expiry_month_name', pub, null)).toBe('December');
      expect(projectCardField('expiry_month_short', pub, null)).toBe('Dec');
      expect(spy).toHaveBeenCalledWith('en-US', expect.objectContaining({ timeZone: 'UTC' }));
    } finally {
      if (origLang === undefined) delete process.env['LANG']; else process.env['LANG'] = origLang;
      if (origAll === undefined) delete process.env['LC_ALL']; else process.env['LC_ALL'] = origAll;
    }
  });
  it('secret field without secret doc throws', () => expect(() => projectCardField('number', pub, null)).toThrow());
  it('unknown field lists fields', () => expect(() => projectCardField('pin', pub, null)).toThrow(/Fields: number, cvv/));
  it('every listed field projects', () => {
    const secret = { _schema: 'credit_card', number: '4111111111111111', cvv: '123' } as const;
    expect(CARD_FIELDS).toHaveLength(15);
    for (const f of CARD_FIELDS) expect(() => projectCardField(f, { ...pub, billing_zip: 'Z1' }, secret)).not.toThrow();
  });
  it('knows which fields are secret', () => {
    expect(CARD_SECRET_FIELDS).toEqual(['number', 'cvv']);
    expect(isCardSecretField('cvv')).toBe(true);
    expect(isCardSecretField('brand')).toBe(false);
  });
});

describe('parseSecretRef', () => {
  it('splits', () => expect(parseSecretRef('user.visa_card#cvv')).toEqual({ name: 'user.visa_card', field: 'cvv' }));
  it('no field', () => expect(parseSecretRef('user.x')).toEqual({ name: 'user.x', field: null }));
  it('two #', () => expect(() => parseSecretRef('user.x#a#b')).toThrow());
  it('empty field', () => expect(() => parseSecretRef('user.x#')).toThrow());
});

describe('isStructuredSchemaTag', () => {
  it('recognizes credit_card only', () => {
    expect(isStructuredSchemaTag('credit_card')).toBe(true);
    expect(isStructuredSchemaTag('address')).toBe(false);
    expect(isStructuredSchemaTag(null)).toBe(false);
  });
});

it.each([['4111111111111111', 'visa'], ['5555555555554444', 'mastercard'], ['2223003122003222', 'mastercard'],
  ['378282246310005', 'amex'], ['6011111111111117', 'discover'], ['3530111333300000', 'other'],
  ['2221000000000009', 'mastercard'], ['2720999999999996', 'mastercard'], ['2721000000000000', 'other'],
  ['6450000000000000', 'discover'], ['6500000000000002', 'discover'], ['3400000000000000', 'amex']])('brand %s', (n, b) =>
  expect(detectCardBrand(n)).toBe(b));
