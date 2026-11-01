import { describe, expect, it } from 'vitest';
import { readFragmentToken } from './fragment-token.js';

describe('readFragmentToken', () => {
  it('reads c from the hash and rejects anything else', () => {
    expect(readFragmentToken('#c=abcDEF1234567890_-token')).toBe('abcDEF1234567890_-token');
    expect(readFragmentToken('#c=short')).toBeNull();
    expect(readFragmentToken('')).toBeNull();
  });
});
