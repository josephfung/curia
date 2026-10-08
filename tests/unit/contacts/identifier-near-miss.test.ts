import { describe, it, expect } from 'vitest';
import {
  comparableChannels,
  identifierFamily,
  isNearMiss,
  osaDistance,
  sameIdentifier,
} from '../../../src/contacts/identifier-near-miss.js';

describe('osaDistance', () => {
  it('counts substitutions, insertions, deletions and adjacent swaps', () => {
    expect(osaDistance('abc', 'abc', 2)).toBe(0);
    expect(osaDistance('abc', 'abd', 2)).toBe(1);
    expect(osaDistance('abc', 'abcd', 2)).toBe(1);
    expect(osaDistance('abc', 'acb', 2)).toBe(1);
    expect(osaDistance('kitten', 'sitting', 3)).toBe(3);
  });

  it('returns max + 1 when the lengths alone rule it out', () => {
    expect(osaDistance('a', 'abcd', 2)).toBe(3);
  });

  it('never reports more than max + 1', () => {
    expect(osaDistance('abcdef', 'uvwxyz', 2)).toBe(3);
  });
});

describe('identifierFamily / comparableChannels', () => {
  it('groups the phone channels and keeps the others apart', () => {
    expect(identifierFamily('email')).toBe('email');
    expect(identifierFamily('sms')).toBe('phone');
    expect(identifierFamily('slack')).toBe('opaque');
    expect(comparableChannels('signal').sort()).toEqual(['phone', 'signal', 'sms']);
    expect(comparableChannels('email')).toEqual(['email']);
    expect(comparableChannels('slack')).toEqual(['slack']);
  });
});

describe('isNearMiss', () => {
  it('catches both ADR-047 email incidents', () => {
    // .com for .ca: distance 2 on a 20-character address.
    expect(isNearMiss('email', 'joseph@josephfung.com', 'joseph@josephfung.ca')).toBe(true);
    // A dot inserted into the domain: distance 1.
    expect(isNearMiss('email', 'joseph@joseph.fung.ca', 'joseph@josephfung.ca')).toBe(true);
  });

  it('is case-insensitive for email and never matches an identical address', () => {
    expect(isNearMiss('email', 'Joseph@JosephFung.ca', 'joseph@josephfung.ca')).toBe(false);
  });

  it('allows only one edit when the shorter address has fewer than 12 characters', () => {
    expect(isNearMiss('email', 'el@x.io', 'al@x.io')).toBe(true);
    expect(isNearMiss('email', 'ed@x.io', 'al@x.io')).toBe(false);
  });

  it('allows two edits from 12 characters: 11 is one edit, 12 is two', () => {
    // Two substitutions each time; only the length of the shorter address changes.
    expect('ab@xyz.test'.length).toBe(11);
    expect(osaDistance('ab@xyz.test', 'cd@xyz.test', 3)).toBe(2);
    expect(isNearMiss('email', 'ab@xyz.test', 'cd@xyz.test')).toBe(false);
    expect('abc@xyz.test'.length).toBe(12);
    expect(osaDistance('abc@xyz.test', 'cdc@xyz.test', 3)).toBe(2);
    expect(isNearMiss('email', 'abc@xyz.test', 'cdc@xyz.test')).toBe(true);
  });

  it('does not match addresses three edits apart, however long', () => {
    expect(osaDistance('dana@newco.example', 'dina@nowco.exampel', 4)).toBe(3);
    expect(isNearMiss('email', 'dana@newco.example', 'dina@nowco.exampel')).toBe(false);
  });

  it('does not match addresses four edits apart', () => {
    expect(osaDistance('pat@example.test', 'priya@example.test', 5)).toBe(4);
    expect(isNearMiss('email', 'pat@example.test', 'priya@example.test')).toBe(false);
  });

  it('catches a one-digit number slip across the phone channels, and ignores formatting', () => {
    expect(isNearMiss('sms', '+14165550101', '+14165550100')).toBe(true);
    expect(isNearMiss('signal', '+14165550010', '+14165550100')).toBe(true); // adjacent swap
    expect(isNearMiss('sms', '+1 (416) 555-0100', '+14165550100')).toBe(false); // same number
    expect(isNearMiss('sms', '+14165559999', '+14165550100')).toBe(false);
  });

  it('never flags opaque ids', () => {
    expect(isNearMiss('slack', 'U012ABCDEG', 'U012ABCDEF')).toBe(false);
    expect(isNearMiss('telegram', 'patp', 'pat')).toBe(false);
  });
});

describe('sameIdentifier', () => {
  it('compares email case-insensitively, numbers by digits, and other ids exactly', () => {
    expect(sameIdentifier('email', 'Pat@Example.test', 'pat@example.test')).toBe(true);
    expect(sameIdentifier('sms', '+1 (416) 555-0100', '+14165550100')).toBe(true);
    expect(sameIdentifier('slack', 'U012ABCDEF', 'u012abcdef')).toBe(false);
    expect(sameIdentifier('sms', '', '')).toBe(false);
  });
});
