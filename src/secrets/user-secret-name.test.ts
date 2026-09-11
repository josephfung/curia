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

  it('preserves first-seen identity order on new keys', () => {
    expect(canonicalizeUserSecretName('Foo Bar')).toBe('user.foo_bar');
    expect(canonicalizeUserSecretName('Bar Foo')).toBe('user.bar_foo');
  });

  it('folds X/Twitter synonyms and TLDs into one canonical key', () => {
    expect(canonicalizeUserSecretName('X.com password')).toBe('user.twitter_password');
    expect(canonicalizeUserSecretName('my Twitter/X password')).toBe('user.twitter_password');
    expect(canonicalizeUserSecretName('twitter password')).toBe('user.twitter_password');
  });

  it('does not rewrite a non-Twitter standalone x token', () => {
    expect(canonicalizeUserSecretName('Mac OS X password')).toBe('user.mac_os_x_password');
    expect(canonicalizeUserSecretName('x.example.com login')).toBe('user.x_example_login');
  });

  it('keeps the service token after for instead of swallowing it', () => {
    expect(canonicalizeUserSecretName('password for work gmail')).toBe('user.work_gmail_password');
    expect(canonicalizeUserSecretName('password for aeroplan')).toBe('user.aeroplan_password');
    expect(canonicalizeUserSecretName('password for gmail')).toBe('user.gmail_password');
  });

  it('keeps a trailing qualifier after for rather than dropping it as an owner name', () => {
    expect(canonicalizeUserSecretName('gmail password for work')).toBe('user.gmail_work_password');
    expect(canonicalizeUserSecretName('gmail password for personal')).toBe('user.gmail_personal_password');
    expect(canonicalizeUserSecretName('X Twitter password for josephfung')).toBe(
      'user.twitter_josephfung_password',
    );
  });

  it('falls back to the raw slug for a trailing for with no successor', () => {
    expect(canonicalizeUserSecretName('password for')).toBe('user.password_for');
  });

  it('strips English possessives instead of treating leftover s as identity', () => {
    expect(canonicalizeUserSecretName("my account's password")).toBe('user.my_account_password');
    expect(canonicalizeUserSecretName("the website's password")).toBe('user.the_website_password');
    expect(canonicalizeUserSecretName("our site's password")).toBe('user.our_site_password');
    expect(canonicalizeUserSecretName("the user's password")).toBe('user.the_user_password');
    expect(canonicalizeUserSecretName("my bank's login")).toBe('user.bank_login');
    expect(canonicalizeUserSecretName('my bank login')).toBe('user.bank_login');
    expect(canonicalizeUserSecretName('the website\u2019s password')).toBe('user.the_website_password');
  });

  it('falls back to the raw slug instead of a type-only key when identity is empty', () => {
    expect(canonicalizeUserSecretName('my account password')).toBe('user.my_account_password');
    expect(canonicalizeUserSecretName('the website password')).toBe('user.the_website_password');
    expect(canonicalizeUserSecretName('me.com password')).toBe('user.me_com_password');
    expect(canonicalizeUserSecretName('my account')).toBe('user.my_account');
  });

  it('does not collapse distinct typed secrets for the same service', () => {
    expect(canonicalizeUserSecretName('gmail password')).toBe('user.gmail_password');
    expect(canonicalizeUserSecretName('gmail app password')).toBe('user.gmail_app_password');
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
    expect(() => resolveUserSecretName('   ')).toThrow(/empty/);
    expect(() => resolveUserSecretName('!!!')).toThrow(/no usable alphanumeric characters/);
    expect(() => resolveUserSecretName('x'.repeat(200))).toThrow(/exceeds/);
  });

  it('does not throw a false alphanumeric error for filler-only input', () => {
    expect(resolveUserSecretName('my account')).toBe('user.my_account');
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

  it('does not overwrite gmail with a "password for work gmail" capture', () => {
    const existing = ['user.gmail_password'];
    expect(resolveUserSecretName('password for work gmail', existing)).toBe('user.work_gmail_password');
  });

  it('does not overwrite gmail with a trailing-for qualifier', () => {
    const existing = ['user.gmail_password'];
    expect(resolveUserSecretName('gmail password for work', existing)).toBe('user.gmail_work_password');
    expect(resolveUserSecretName('gmail password for personal', existing)).toBe(
      'user.gmail_personal_password',
    );
  });

  it('does not collapse two possessive filler-noun names onto one key', () => {
    const first = resolveUserSecretName("my account's password");
    expect(first).toBe('user.my_account_password');
    expect(resolveUserSecretName("the website's password", [first])).toBe(
      'user.the_website_password',
    );
  });

  it('matches a possessive description to the non-possessive canonical key', () => {
    expect(resolveUserSecretName("my bank's login", ['user.bank_login'])).toBe('user.bank_login');
  });

  it('does not collapse identity-less captures onto user.password or user.my_password', () => {
    const existing = ['user.my_password', 'user.gmail_password'];
    expect(resolveUserSecretName('my account password', existing)).toBe('user.my_account_password');
    expect(resolveUserSecretName('the website password', existing)).toBe('user.the_website_password');
    expect(resolveUserSecretName('me.com password', existing)).toBe('user.me_com_password');
  });

  it('reuses an existing key when identity tokens are the same in a different order', () => {
    expect(resolveUserSecretName('Bar Foo', ['user.foo_bar'])).toBe('user.foo_bar');
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
  it('gives the two prod X-password slugs the same fingerprint', () => {
    expect(fingerprintKey(fingerprintUserSecret('user.x_com_password'))).toBe('twitter|password');
    expect(fingerprintKey(fingerprintUserSecret('user.my_twitter_x_password'))).toBe(
      'twitter|password',
    );
  });

  it('keeps an owner suffix on the fingerprint so it does not collide with the service key', () => {
    expect(fingerprintKey(fingerprintUserSecret('user.x_twitter_password_for_josephfung'))).toBe(
      'josephfung_twitter|password',
    );
  });
});
