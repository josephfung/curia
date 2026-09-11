// user-secret-name.test.ts — deterministic user.* naming + fingerprint dedup (#1497).

import { describe, it, expect } from 'vitest';
import {
  canonicalizeUserSecretName,
  fingerprintKey,
  fingerprintUserSecret,
  resolveUserSecretName,
  USER_SECRET_PREFIX,
} from './user-secret-name.js';

describe('canonicalizeUserSecretName', () => {
  it('slugifies, strips filler, and appends a type suffix', () => {
    expect(canonicalizeUserSecretName('My Flight Site Password')).toBe('user.flight_password');
    expect(canonicalizeUserSecretName('Flight Site Password')).toBe('user.flight_password');
    expect(canonicalizeUserSecretName('  Foo--Bar!! ')).toBe('user.foo_bar');
  });

  it('folds X/Twitter synonyms and TLDs into one canonical key', () => {
    expect(canonicalizeUserSecretName('X.com password')).toBe('user.twitter_password');
    expect(canonicalizeUserSecretName('X Twitter password for josephfung')).toBe('user.twitter_password');
    expect(canonicalizeUserSecretName('my Twitter/X password')).toBe('user.twitter_password');
    expect(canonicalizeUserSecretName('twitter password')).toBe('user.twitter_password');
  });

  it('does not collapse distinct typed secrets for the same service', () => {
    expect(canonicalizeUserSecretName('gmail password')).toBe('user.gmail_password');
    expect(canonicalizeUserSecretName('gmail app password')).toBe('user.app_gmail_password');
  });

  it('structurally cannot produce a protected system or channel name', () => {
    const asUser = canonicalizeUserSecretName('anthropic_api_key');
    expect(asUser.startsWith(USER_SECRET_PREFIX)).toBe(true);
    expect(asUser).not.toBe('anthropic_api_key');

    const asChannel = canonicalizeUserSecretName('channel.email.nylas_api_key');
    expect(asChannel.startsWith(USER_SECRET_PREFIX)).toBe(true);
    expect(asChannel).not.toBe('channel.email.nylas_api_key');
    expect(asChannel.startsWith('channel.')).toBe(false);
  });
});

describe('resolveUserSecretName', () => {
  it('returns the canonical key when the vault is empty', () => {
    expect(resolveUserSecretName('My Flight Site Password')).toBe('user.flight_password');
  });

  it('rejects empty / whitespace / non-alphanumeric / over-long input', () => {
    expect(() => resolveUserSecretName('   ')).toThrow();
    expect(() => resolveUserSecretName('!!!')).toThrow();
    expect(() => resolveUserSecretName('x'.repeat(200))).toThrow();
  });

  it('reuses an exact existing user.* key the agent passed through', () => {
    const existing = ['user.x_com_password', 'user.aeroplan_password'];
    expect(resolveUserSecretName('user.x_com_password', existing)).toBe('user.x_com_password');
  });

  it('reuses the oldest fingerprint match instead of minting a new slug', () => {
    // Prod incident: three X/Twitter password captures. Oldest first (created_at ASC).
    const existing = [
      'user.x_com_password',
      'user.x_twitter_password_for_josephfung',
      'user.my_twitter_x_password',
    ];
    expect(resolveUserSecretName('twitter password', existing)).toBe('user.x_com_password');
    expect(resolveUserSecretName('X.com password', existing)).toBe('user.x_com_password');
    expect(resolveUserSecretName('my Twitter/X password', existing)).toBe('user.x_com_password');
  });

  it('does not reuse a fingerprint-unrelated existing key', () => {
    const existing = ['user.aeroplan_password'];
    expect(resolveUserSecretName('twitter password', existing)).toBe('user.twitter_password');
  });

  it('two captures of the same description mint the same key (deterministic)', () => {
    const first = resolveUserSecretName('Aeroplan password');
    const second = resolveUserSecretName('my Aeroplan login', [first]);
    expect(first).toBe('user.aeroplan_password');
    // login vs password are different types — this documents that type tokens distinguish.
    // "Aeroplan password" recaptured as "Aeroplan password" reuses:
    expect(resolveUserSecretName('the Aeroplan password', [first])).toBe(first);
    expect(second).toBe('user.aeroplan_login');
  });
});

describe('fingerprintUserSecret', () => {
  it('gives the three prod X-password slugs the same fingerprint', () => {
    const keys = [
      'user.x_com_password',
      'user.x_twitter_password_for_josephfung',
      'user.my_twitter_x_password',
    ];
    const fps = keys.map(k => fingerprintKey(fingerprintUserSecret(k)));
    expect(new Set(fps).size).toBe(1);
    expect(fps[0]).toBe('twitter|password');
  });
});
