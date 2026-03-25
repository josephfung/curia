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

  it('loads ANTHROPIC_API_KEY from environment', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-test');
  });

  it('defaults LOG_LEVEL to info', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    // Explicitly remove LOG_LEVEL to test the default — CI sets LOG_LEVEL=error
    delete process.env.LOG_LEVEL;
    const config = loadConfig();
    expect(config.logLevel).toBe('info');
  });
});
