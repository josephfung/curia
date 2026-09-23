// uuid.test.ts — pins the loose-vs-strict decision documented in uuid.ts.
//
// The point of these cases is that the choice is enforced by a test rather
// than inferred from whichever regex a future reader happens to copy.

import { describe, it, expect } from 'vitest';
import { isUuid, UUID_PATTERN } from './uuid.js';

describe('isUuid', () => {
  it('accepts a v4 UUID (what gen_random_uuid() emits)', () => {
    expect(isUuid('9f8c6d2e-4b1a-4c3f-9a7e-2d5b8c1f0a34')).toBe(true);
  });

  it('accepts the nil UUID — shape-valid, so Postgres will cast it', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('accepts a v7 UUID — loose on purpose, so v7 ids are not locked out', () => {
    expect(isUuid('018f3a9c-7b21-7d4e-8f6a-1c2b3d4e5f60')).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isUuid('9F8C6D2E-4B1A-4C3F-9A7E-2D5B8C1F0A34')).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
  });

  it('rejects a bare name that could be confused for an id', () => {
    expect(isUuid('Joseph Fung')).toBe(false);
  });

  it('rejects a UUID with surrounding whitespace', () => {
    expect(isUuid(' 9f8c6d2e-4b1a-4c3f-9a7e-2d5b8c1f0a34 ')).toBe(false);
  });

  it('rejects a UUID embedded in a longer string (anchored match)', () => {
    expect(isUuid('id=9f8c6d2e-4b1a-4c3f-9a7e-2d5b8c1f0a34;')).toBe(false);
  });

  it('rejects a UUID missing a group', () => {
    expect(isUuid('9f8c6d2e-4b1a-4c3f-2d5b8c1f0a34')).toBe(false);
  });

  it('rejects non-hex characters in an otherwise UUID-shaped string', () => {
    expect(isUuid('9f8c6d2g-4b1a-4c3f-9a7e-2d5b8c1f0a34')).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid({})).toBe(false);
  });

  it('is not stateful across calls (no /g flag lastIndex carry-over)', () => {
    const id = '9f8c6d2e-4b1a-4c3f-9a7e-2d5b8c1f0a34';
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id)).toBe(true);
  });
});

describe('UUID_PATTERN', () => {
  it('composes into a larger regex without anchors of its own', () => {
    const pairKey = new RegExp(`^(${UUID_PATTERN}):(${UUID_PATTERN})$`, 'i');
    expect(
      pairKey.test(
        '9f8c6d2e-4b1a-4c3f-9a7e-2d5b8c1f0a34:018f3a9c-7b21-7d4e-8f6a-1c2b3d4e5f60',
      ),
    ).toBe(true);
    expect(pairKey.test('9f8c6d2e-4b1a-4c3f-9a7e-2d5b8c1f0a34')).toBe(false);
  });
});
