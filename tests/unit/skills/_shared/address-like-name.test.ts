// A display name that looks like an address or a number is never quoted to an agent (#2041).

import { describe, it, expect } from 'vitest';
import { isAddressLikeName } from '../../../../src/skills/_shared/address-like-name.js';

describe('isAddressLikeName', () => {
  it.each([
    ['14165550100', 'a number, as a gateway-made SMS contact is named'],
    ['+1 (416) 555-0100', 'a number with separators'],
    ['1 (416) 555-0100', 'the same number after sanitizeDisplayName strips the +'],
    ['sam.riveravendor.example', 'an address after sanitizeDisplayName strips the @'],
    ['pat@home.example', 'an address'],
    ['Pat <pat@home.example>', 'a name carrying an address'],
    ['U012ABCDEF', 'a Slack user id'],
    ['W012ABCDEF', 'an Enterprise Grid Slack id'],
  ])('is true for %s (%s)', (name) => {
    expect(isAddressLikeName(name)).toBe(true);
  });

  it.each([
    'Priya Natarajan',
    "Mary-Jane O'Neil",
    'J. Smith', // has a space, so it is not a single dotted token
    'Agent 47',
    'Dana',
    'Uma',
    'Room 4B, 555 West',
  ])('is false for the name %s', (name) => {
    expect(isAddressLikeName(name)).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(isAddressLikeName('  U012ABCDEF  ')).toBe(true);
    expect(isAddressLikeName('  Priya Natarajan  ')).toBe(false);
  });
});
