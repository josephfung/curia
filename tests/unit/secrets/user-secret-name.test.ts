// user-secret-name.test.ts — deterministic user.* naming + fingerprint dedup (#1497).

import { describe, it, expect } from 'vitest';
import {
  canonicalizeUserSecretName,
  consoleSecretNameInput,
  fingerprintKey,
  fingerprintUserSecret,
  resolveUserSecretName,
  siteIdentityFromUrl,
  USER_SECRET_PREFIX,
} from '../../../src/secrets/user-secret-name.js';

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

  it('keeps single-letter brand initials instead of dropping every 1-char token', () => {
    expect(canonicalizeUserSecretName('T-Mobile password')).toBe('user.t_mobile_password');
    expect(canonicalizeUserSecretName('mobile password')).toBe('user.mobile_password');
    expect(canonicalizeUserSecretName('E*TRADE password')).toBe('user.e_trade_password');
    expect(canonicalizeUserSecretName('H&R Block login')).toBe('user.h_r_block_login');
    expect(canonicalizeUserSecretName('Q password')).toBe('user.q_password');
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

  it('does not collapse T-Mobile onto a generic mobile key', () => {
    expect(resolveUserSecretName('mobile password', ['user.t_mobile_password'])).toBe(
      'user.mobile_password',
    );
    expect(resolveUserSecretName('T-Mobile password', ['user.mobile_password'])).toBe(
      'user.t_mobile_password',
    );
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

describe('siteIdentityFromUrl', () => {
  it.each([
    ['https://www.rogers.com/signin', 'rogers'],
    ['https://secure.rbc.com/x', 'rbc'],
    ['https://aircanada.com/aeroplan', 'aircanada'],
    ['https://www.amazon.co.uk/', 'amazon'],
    ['http://localhost:8080', 'localhost'],
    ['https://192.168.1.10/login', '192.168.1.10'],
  ])('%s -> %s', (url, expected) => {
    expect(siteIdentityFromUrl(url)).toBe(expected);
  });

  it.each(['ftp://x.com', 'not a url'])('throws on %s', (url) => {
    expect(() => siteIdentityFromUrl(url)).toThrow();
  });
});

describe('consoleSecretNameInput + resolveUserSecretName', () => {
  const rogers = { type: 'website_login' as const, loginUrl: 'https://www.rogers.com/signin' };

  it('names a website login from the site', () => {
    expect(resolveUserSecretName(consoleSecretNameInput(rogers), [])).toBe('user.rogers_password');
  });

  it('reuses the existing key for the same site', () => {
    expect(resolveUserSecretName(consoleSecretNameInput(rogers), ['user.rogers_password'])).toBe('user.rogers_password');
  });

  it('does not collapse an IP login to a type-only key', () => {
    const name = resolveUserSecretName(
      consoleSecretNameInput({ type: 'website_login', loginUrl: 'https://192.168.1.10/login' }),
      [],
    );
    expect(name).not.toBe('user.password');
    expect(name.startsWith('user.192')).toBe(true);
  });

  it('names an other secret from its label', () => {
    expect(resolveUserSecretName(consoleSecretNameInput({ type: 'other', label: 'Bank PIN' }), [])).toBe('user.bank_pin');
  });

  it('throws when the required field is missing or blank', () => {
    expect(() => consoleSecretNameInput({ type: 'website_login' })).toThrow();
    expect(() => consoleSecretNameInput({ type: 'other', label: '   ' })).toThrow();
    expect(() => consoleSecretNameInput({ type: 'other' })).toThrow();
  });
});

describe('card type token', () => {
  it('fingerprints card as the type, not identity', () => {
    expect(fingerprintUserSecret('personal visa card')).toEqual({ identity: ['personal', 'visa'], type: 'card' });
  });

  it('names cards by owner and brand', () => {
    expect(resolveUserSecretName('personal visa card', [])).toBe('user.personal_visa_card');
    expect(resolveUserSecretName('work visa card', [])).toBe('user.work_visa_card');
  });

  it('keeps distinct cards distinct', () => {
    const existing = ['user.personal_visa_card'];
    expect(resolveUserSecretName('work visa card', existing)).toBe('user.work_visa_card');
    expect(resolveUserSecretName('Personal Visa card', existing)).toBe('user.personal_visa_card');
  });
});

describe('consoleSecretNameInput for a credit card', () => {
  it('names the card from its label and the brand of its number', () => {
    const name = (label: string, number: string) =>
      resolveUserSecretName(consoleSecretNameInput({ type: 'credit_card', label, number }), []);
    expect(name('Personal', '4111 1111 1111 1111')).toBe('user.personal_visa_card');
    expect(name('Work', '5555-5555-5555-4444')).toBe('user.work_mastercard_card');
    expect(name('Work', '378282246310005')).toBe('user.work_amex_card');
  });

  it('leaves an unknown brand out of the name', () => {
    expect(consoleSecretNameInput({ type: 'credit_card', label: 'Travel', number: '9999999999999995' })).toBe('Travel card');
  });

  it('reuses the existing key for the same label and brand', () => {
    const input = consoleSecretNameInput({ type: 'credit_card', label: 'Personal', number: '4111111111111111' });
    expect(resolveUserSecretName(input, ['user.personal_visa_card'])).toBe('user.personal_visa_card');
  });

  it('requires a label and a number, and never puts the number in the error', () => {
    expect(() => consoleSecretNameInput({ type: 'credit_card', number: '4111111111111111' })).toThrow('label is required');
    expect(() => consoleSecretNameInput({ type: 'credit_card', label: 'x' })).toThrow('number is required');
  });
});
