import { describe, it, expect } from 'vitest';
import {
  extractIdentifierTokens,
  hasConflictingIdentifiers,
} from '../../../src/memory/identifier-guard.js';

// All strings are invented; none comes from real data.
describe('extractIdentifierTokens', () => {
  it('joins digit groups split by in-number separators', () => {
    expect(extractIdentifierTokens('Order #418-5530217-6094412')).toContain('41855302176094412');
  });

  it('normalises phone formatting', () => {
    expect(extractIdentifierTokens('(905) 555-0176')).toEqual(
      extractIdentifierTokens('905-555-0176'),
    );
  });

  it('captures alphanumeric ids of 8+ chars containing a digit, lower-cased', () => {
    expect(extractIdentifierTokens('Message ID 7C2E90AF41B3D586')).toContain('7c2e90af41b3d586');
  });

  it('ignores plain names and short digit runs', () => {
    expect(extractIdentifierTokens('Robert Lindqvist').size).toBe(0);
    expect(extractIdentifierTokens('Q3 board meeting').size).toBe(0);
  });
});

describe('hasConflictingIdentifiers', () => {
  it('flags order numbers that differ by one digit', () => {
    expect(
      hasConflictingIdentifiers('Order #418-5530217-6094412', 'Order #418-5530217-6094512'),
    ).toBe(true);
  });

  it('flags UUIDs that differ only in a middle group, and keeps the same UUID with prose compatible', () => {
    const uuid = '7c2e90af-41b3-4d58-a6e9-12c34d56e78f';
    expect(hasConflictingIdentifiers(`Message ${uuid}`, 'Message 7c2e90af-41b4-4d58-a6e9-12c34d56e78f')).toBe(true);
    expect(hasConflictingIdentifiers(`Message ${uuid}`, `Message ${uuid}, from the board thread`)).toBe(false);
    expect(hasConflictingIdentifiers(`Message ${uuid}`, `Message ${uuid.replace(/-/g, '')}`)).toBe(false);
  });

  it('treats a superset of identifiers as compatible', () => {
    expect(
      hasConflictingIdentifiers('tax: $1,204.50', 'tax: $1,204.50 (no change since 2030)'),
    ).toBe(false);
  });

  it('ignores differing key names with the same value', () => {
    expect(hasConflictingIdentifiers('cell_phone: 226-555-0193', 'phone: 226-555-0193')).toBe(false);
  });

  it('flags different timestamps on the same date', () => {
    expect(
      hasConflictingIdentifiers('start_time: 2031-08-09T14:15:00', 'end_time: 2031-08-09T16:45:00'),
    ).toBe(true);
  });

  it('does not flag labels without identifiers', () => {
    expect(hasConflictingIdentifiers('Acme Corp', 'Acme Corporation')).toBe(false);
  });

  // Calibration on the maintainer's labelled set (#2023) found three shapes of "same"
  // pair that the first rule blocked. These are invented equivalents.
  it('accepts an email address written without its @', () => {
    expect(hasConflictingIdentifiers('pennyharlow7@mailbox.test', 'pennyharlow7mailbox.test')).toBe(false);
  });

  it('lets a year in one label not veto a match on a stronger identifier', () => {
    expect(
      hasConflictingIdentifiers('property_tax_2031: $3,118.42', 'property_tax: $3,118.42 (same as 2030)'),
    ).toBe(false);
  });

  it('accepts a shared identifier when one side adds a date and the other only a year', () => {
    expect(
      hasConflictingIdentifiers('lease_4471_note: signed 2031-03-12', 'lease_4471_summary: runs until 2033'),
    ).toBe(false);
  });

  it('still lets years decide when neither label has a stronger identifier', () => {
    expect(hasConflictingIdentifiers('Q2 2031 board meeting', 'Q2 2032 board meeting')).toBe(true);
  });

  it('does not read a clock time as a year', () => {
    expect(
      hasConflictingIdentifiers('start_time: 2031-05-14 19:30', 'end_time: 2031-05-14 20:30'),
    ).toBe(true);
  });

  it('keeps digit identifiers exact: a longer number is a different one', () => {
    expect(hasConflictingIdentifiers('Order 52817', 'Order 528170')).toBe(true);
  });

  it('flags alphanumeric ids that differ by one character', () => {
    expect(hasConflictingIdentifiers('Message <msg-7f3a9c21e4@mail.test>', 'Message <msg-7f3a9c21e5@mail.test>')).toBe(true);
  });

  // The dropped-@ tolerance must not reach an id that merely starts like another one.
  it.each([
    ['known_email: pennyharlow7@mailbox.test', 'known_email: pennyharlow72@mailbox.test'],
    ['Booking ref QX4417HB', 'Booking ref QX4417HBC'],
    ['Message <msg-7f3a9c21e4@mail.test>', 'Message <msg-7f3a9c21e4a@mail.test>'],
    ['abc12345', 'xabc12345'],
  ])('keeps a prefix-extended id apart: %s / %s', (a, b) => {
    expect(hasConflictingIdentifiers(a, b)).toBe(true);
  });
});
