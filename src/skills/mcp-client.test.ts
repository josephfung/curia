// mcp-client.test.ts — unit tests for buildChildEnv, the least-privilege env
// builder for stdio MCP subprocesses. Secret resolution happens upstream in
// mcp-loader (vault-only, #913); these tests pin the post-resolution contract:
// minimal safe base + literal overrides only, with no process.env leakage.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildChildEnv } from './mcp-client.js';

describe('buildChildEnv', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Deterministic base + a sensitive var that must never reach the child.
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/curia';
    process.env.DB_PASSWORD = 'super-secret-db-pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  });

  afterEach(() => {
    // Restore the original environment so tests stay isolated.
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it('includes only the minimal safe base from process.env', () => {
    const env = buildChildEnv({});
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/curia');
  });

  it('never leaks unrelated parent-env secrets (parent-env stripping holds)', () => {
    const env = buildChildEnv({});
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('applies non-empty declared keys as literal overrides', () => {
    const env = buildChildEnv({
      GOOGLE_OAUTH_CLIENT_ID: 'resolved-from-vault',
      ALLOWED_FILE_DIRS: '/run/curia-tempfiles',
    });
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe('resolved-from-vault');
    expect(env.ALLOWED_FILE_DIRS).toBe('/run/curia-tempfiles');
  });

  it('drops empty (unresolved) keys instead of inheriting them from process.env', () => {
    // An empty value used to mean "inherit from process.env"; post-#913 it means
    // "unresolved" and must be dropped so a secret cannot leak from the parent env.
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'leaked-from-env';
    const env = buildChildEnv({ GOOGLE_OAUTH_CLIENT_ID: '' });
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
  });
});
