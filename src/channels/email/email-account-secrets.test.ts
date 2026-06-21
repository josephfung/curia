import { describe, it, expect } from 'vitest';
import {
  emailAccountGrantSecretName,
  isPerAccountEmailGrantKey,
  isValidEmailAccountName,
} from './email-account-secrets.js';

describe('email-account-secrets', () => {
  it('builds the per-account grant vault key', () => {
    expect(emailAccountGrantSecretName('curia')).toBe('channel.email.curia.nylas_grant_id');
  });

  it('recognizes per-account grant keys', () => {
    expect(isPerAccountEmailGrantKey('channel.email.curia.nylas_grant_id')).toBe(true);
    expect(isPerAccountEmailGrantKey('channel.email.sales-eu.nylas_grant_id')).toBe(true);
  });

  it('rejects the shared/single-account and unrelated keys', () => {
    expect(isPerAccountEmailGrantKey('channel.email.nylas_grant_id')).toBe(false);
    expect(isPerAccountEmailGrantKey('channel.email.nylas_api_key')).toBe(false);
    expect(isPerAccountEmailGrantKey('channel.email.curia.nylas_api_key')).toBe(false);
    expect(isPerAccountEmailGrantKey('channel.email.a.b.nylas_grant_id')).toBe(false);
    expect(isPerAccountEmailGrantKey('user.foo')).toBe(false);
  });

  it('validates account names', () => {
    expect(isValidEmailAccountName('curia')).toBe(true);
    expect(isValidEmailAccountName('sales-eu_2')).toBe(true);
    expect(isValidEmailAccountName('Curia')).toBe(false);   // uppercase
    expect(isValidEmailAccountName('a.b')).toBe(false);      // dot
    expect(isValidEmailAccountName('-lead')).toBe(false);    // leading dash
    expect(isValidEmailAccountName('')).toBe(false);
  });
});
