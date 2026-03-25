import { describe, it, expect } from 'vitest';
import { validateBearerToken } from '../../../../src/channels/http/auth.js';

describe('validateBearerToken', () => {
  it('returns true for a valid token', () => {
    expect(validateBearerToken('Bearer my-secret-token', 'my-secret-token')).toBe(true);
  });

  it('returns false for an invalid token', () => {
    expect(validateBearerToken('Bearer wrong-token', 'my-secret-token')).toBe(false);
  });

  it('returns false for missing Bearer prefix', () => {
    expect(validateBearerToken('my-secret-token', 'my-secret-token')).toBe(false);
  });

  it('returns false for empty authorization header', () => {
    expect(validateBearerToken('', 'my-secret-token')).toBe(false);
  });

  it('returns false for undefined authorization header', () => {
    expect(validateBearerToken(undefined, 'my-secret-token')).toBe(false);
  });

  it('returns true when no API token is configured (auth disabled)', () => {
    expect(validateBearerToken(undefined, undefined)).toBe(true);
  });

  it('returns true for any header when no API token is configured', () => {
    expect(validateBearerToken('Bearer anything', undefined)).toBe(true);
  });
});
