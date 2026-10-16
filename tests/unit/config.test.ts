import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

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
  describe('AWS Bedrock settings', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
      delete process.env.AWS_REGION;
      delete process.env.AWS_BEDROCK_TIMEOUT;
    });

    it('defaults the timeout to 120 seconds, expressed in milliseconds, with no region', () => {
      const config = loadConfig();
      expect(config.awsBedrockTimeoutMs).toBe(120_000);
      expect(config.awsRegion).toBeUndefined();
    });

    it('reads AWS_BEDROCK_TIMEOUT as seconds and trims AWS_REGION', () => {
      process.env.AWS_BEDROCK_TIMEOUT = '45';
      process.env.AWS_REGION = '  ca-central-1 ';
      const config = loadConfig();
      expect(config.awsBedrockTimeoutMs).toBe(45_000);
      expect(config.awsRegion).toBe('ca-central-1');
    });

    it('treats a blank AWS_REGION as unset', () => {
      process.env.AWS_REGION = '   ';
      expect(loadConfig().awsRegion).toBeUndefined();
    });

    it.each(['0', '-5', 'abc', ''])('rejects AWS_BEDROCK_TIMEOUT=%j', (value) => {
      process.env.AWS_BEDROCK_TIMEOUT = value;
      expect(() => loadConfig()).toThrow(/AWS_BEDROCK_TIMEOUT must be a positive number of seconds/);
    });

    it('accepts the largest timeout that fits a Node timer', () => {
      process.env.AWS_BEDROCK_TIMEOUT = String(Math.floor(2_147_483_647 / 1000));
      expect(loadConfig().awsBedrockTimeoutMs).toBe(2_147_483_000);
    });

    it('rejects a timeout past the Node timer limit, which would make every call abort at once', () => {
      process.env.AWS_BEDROCK_TIMEOUT = String(Math.floor(2_147_483_647 / 1000) + 1);
      expect(() => loadConfig()).toThrow(/AWS_BEDROCK_TIMEOUT exceeds the Node.js timer limit \(2147483 seconds\)/);
    });

    it('does not read AWS credentials from the environment (vault-only)', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIA-env';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret-env';
      const config = loadConfig();
      expect(config.awsAccessKeyId).toBeUndefined();
      expect(config.awsSecretAccessKey).toBeUndefined();
    });
  });
});
