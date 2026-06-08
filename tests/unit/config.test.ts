import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ceoPrimaryEmailIsPlaceholder, loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads DATABASE_URL from environment', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    const config = loadConfig();
    expect(config.databaseUrl).toBe('postgres://test:test@localhost:5432/test');
  });

  it('throws if DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow('DATABASE_URL');
  });

  it('does not read ANTHROPIC_API_KEY from environment (vault-only, resolved by applyVaultSecrets)', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = loadConfig();
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it('defaults LOG_LEVEL to info', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    // Explicitly remove LOG_LEVEL to test the default — CI sets LOG_LEVEL=error
    delete process.env.LOG_LEVEL;
    const config = loadConfig();
    expect(config.logLevel).toBe('info');
  });

  describe('CEO_PRIMARY_EMAIL placeholder handling', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    });

    it('normalizes a real email to lowercase trimmed value', () => {
      process.env.CEO_PRIMARY_EMAIL = '  Joe@Example.COM  ';
      expect(loadConfig().ceoPrimaryEmail).toBe('joe@example.com');
    });

    it('treats the literal .env.example placeholder as unset', () => {
      process.env.CEO_PRIMARY_EMAIL = 'you@yourdomain.com';
      expect(loadConfig().ceoPrimaryEmail).toBeUndefined();
    });

    it('treats a case-and-whitespace variant of the placeholder as unset', () => {
      process.env.CEO_PRIMARY_EMAIL = '  YOU@YourDomain.com  ';
      expect(loadConfig().ceoPrimaryEmail).toBeUndefined();
    });

    it('treats an empty string env var as unset', () => {
      process.env.CEO_PRIMARY_EMAIL = '';
      expect(loadConfig().ceoPrimaryEmail).toBeUndefined();
    });

    it('ceoPrimaryEmailIsPlaceholder() returns true only for the literal placeholder', () => {
      process.env.CEO_PRIMARY_EMAIL = 'you@yourdomain.com';
      expect(ceoPrimaryEmailIsPlaceholder()).toBe(true);

      process.env.CEO_PRIMARY_EMAIL = '  YOU@YourDomain.com  ';
      expect(ceoPrimaryEmailIsPlaceholder()).toBe(true);

      process.env.CEO_PRIMARY_EMAIL = 'joe@example.com';
      expect(ceoPrimaryEmailIsPlaceholder()).toBe(false);

      delete process.env.CEO_PRIMARY_EMAIL;
      expect(ceoPrimaryEmailIsPlaceholder()).toBe(false);
    });
  });
});
