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

  it('rejects account segments that violate the account-name slug policy', () => {
    // The matcher must enforce the same charset as EMAIL_ACCOUNT_NAME_RE so the vault
    // scope-guard cannot accept keys for identities the console could never create.
    expect(isPerAccountEmailGrantKey('channel.email.Curia.nylas_grant_id')).toBe(false);   // uppercase
    expect(isPerAccountEmailGrantKey('channel.email.-lead.nylas_grant_id')).toBe(false);   // leading dash
    expect(isPerAccountEmailGrantKey('channel.email.bad name.nylas_grant_id')).toBe(false); // space
    expect(isPerAccountEmailGrantKey('channel.email.x!.nylas_grant_id')).toBe(false);       // punctuation
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
