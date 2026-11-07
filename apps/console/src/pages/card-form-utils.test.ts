import { describe, it, expect } from 'vitest';
import {
  buildCardPayload,
  validateCardForm,
  detectBrandForDisplay,
  EMPTY_CARD_FORM,
  type CardFormState,
} from './card-form-utils.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const good: CardFormState = {
  ...EMPTY_CARD_FORM,
  number: '4111 1111 1111 1111',
  expiryMonth: '3',
  expiryYear: '2030',
  cvv: '123',
  cardholderName: 'Ada Lovelace',
};

describe('buildCardPayload', () => {
  it('pads month and keeps 4-digit year', () => {
    const p = buildCardPayload(good, 'full');
    expect(p).toEqual({
      number: '4111111111111111',
      cvv: '123',
      expiry_month: '03',
      expiry_year: '2030',
      cardholder_name: 'Ada Lovelace',
    });
  });

  it('includes billing_zip only when given', () => {
    expect(buildCardPayload({ ...good, billingZip: ' N2L 3G1 ' }, 'full')['billing_zip']).toBe('N2L 3G1');
  });

  it('renewal mode sends only expiry and cvv', () => {
    expect(buildCardPayload(good, 'renewal')).toEqual({ cvv: '123', expiry_month: '03', expiry_year: '2030' });
  });

  it('edit-public never sends number or cvv', () => {
    const p = buildCardPayload({ ...good, label: 'Work' }, 'edit-public');
    expect(p).not.toHaveProperty('number');
    expect(p).not.toHaveProperty('cvv');
    expect(p['label']).toBe('Work');
  });
});

describe('validateCardForm', () => {
  it('accepts a good full card', () => {
    expect(validateCardForm(good, 'full', NOW)).toEqual({});
  });

  it('flags Luhn and past expiry', () => {
    const e = validateCardForm({ ...good, number: '4111111111111112', expiryMonth: '10', expiryYear: '2026' }, 'full', NOW);
    expect(e.number).toMatch(/doesn't look right/);
    expect(e.expiryMonth).toMatch(/expired/);
  });

  it('allows the current month', () => {
    expect(validateCardForm({ ...good, expiryMonth: '11', expiryYear: '2026' }, 'full', NOW)).toEqual({});
  });

  it('requires 4 digit CVV for amex and 3 otherwise', () => {
    const amex = { ...good, number: '378282246310005' };
    expect(validateCardForm(amex, 'full', NOW).cvv).toBeDefined();
    expect(validateCardForm({ ...amex, cvv: '1234' }, 'full', NOW)).toEqual({});
    expect(validateCardForm({ ...good, cvv: '1234' }, 'full', NOW).cvv).toBeDefined();
  });

  it('renewal only checks expiry and cvv', () => {
    const e = validateCardForm({ ...EMPTY_CARD_FORM, expiryMonth: '1', expiryYear: '2030', cvv: '123' }, 'renewal', NOW);
    expect(e).toEqual({});
  });

  it('edit-public requires label and cardholder, checks zip', () => {
    const e = validateCardForm({ ...EMPTY_CARD_FORM, expiryMonth: '1', expiryYear: '2030', billingZip: '!!' }, 'edit-public', NOW);
    expect(Object.keys(e).sort()).toEqual(['billingZip', 'cardholderName', 'label']);
  });
});

describe('detectBrandForDisplay', () => {
  it('names brands', () => {
    expect(detectBrandForDisplay('4111')).toBe('Visa');
    expect(detectBrandForDisplay('5555 5555')).toBe('Mastercard');
    expect(detectBrandForDisplay('3782')).toBe('Amex');
    expect(detectBrandForDisplay('6011')).toBe('Discover');
    expect(detectBrandForDisplay('')).toBe('');
  });
});
