import { describe, it, expect } from 'vitest';
import { containsIban, hasFinancialDetails } from '../../../../src/skills/principal-send/financial-details.js';
import { detectPii } from '../../../../src/pii/scrubber.js';

// Final fixes A3 (security review M3 backstop): an autonomous reply never carries bank or card details.
describe('containsIban', () => {
  it('finds a checksum-valid IBAN, spaced, compact or followed by more text', () => {
    expect(containsIban('Updated remittance details: IBAN DE89 3704 0044 0532 0130 00, please confirm.')).toBe(true);
    expect(containsIban('GB82WEST12345698765432')).toBe(true);
    expect(containsIban('<p>DE89 3704 0044 0532 0130 00 THANKS</p>')).toBe(true);
  });

  it('ignores a string of the same shape whose checksum fails, and ordinary text', () => {
    expect(containsIban('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(containsIban('Order AB12 3456 7890 1234 ships Friday.')).toBe(false);
    expect(containsIban('Does Friday at 10 work?')).toBe(false);
  });
});

describe('hasFinancialDetails', () => {
  it('is true for a card number the redactor detects, under the label it emits', () => {
    const items = detectPii('Card 4111 1111 1111 1111 exp 12/29');
    expect(items.map((i) => i.label)).toContain('credit_card');
    expect(hasFinancialDetails(items, [])).toBe(true);
    expect(hasFinancialDetails([{ label: 'CREDIT_CARD' }], [])).toBe(true);
  });

  it('is true for an IBAN in any of the texts, whatever the detected items', () => {
    expect(hasFinancialDetails([], ['Thanks!', 'IBAN DE89 3704 0044 0532 0130 00'])).toBe(true);
  });

  it('is false for other personal data', () => {
    expect(hasFinancialDetails([{ label: 'email' }, { label: 'phone_us' }], ['Call 416-555-0199'])).toBe(false);
  });
});
