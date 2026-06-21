// mcp-loader.test.ts — tests for fixed_inputs schema stripping and call-time injection.
//
// These test the pure helper functions extracted from loadMcpServers. The full
// integration path (YAML -> connect -> register) is covered by startup smoke tests;
// these unit tests verify the mechanical correctness of schema manipulation and
// argument merging.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  stripFixedInputsFromSchema,
  mergeFixedInputs,
  resolveStdioEnvFromVault,
  resolveFixedInputFromVault,
  resolveSecretsBlock,
  loadSkillsConfig,
} from './mcp-loader.js';
import type { McpSecretDeclaration } from './mcp-config-types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvValue } from '../config.js';
import type { SecretsService } from '../secrets/secrets-service.js';

// Minimal SecretsService stub: only get() is exercised by the resolvers under
// test. Backed by a plain map of vault key -> value; unknown keys return null
// (the vault-absent signal).
function fakeSecrets(values: Record<string, string | null>): SecretsService {
  return {
    get: async (name: string): Promise<string | null> => values[name] ?? null,
  } as unknown as SecretsService;
}

// ---------------------------------------------------------------------------
// stripFixedInputsFromSchema
// ---------------------------------------------------------------------------

describe('stripFixedInputsFromSchema', () => {
  it('removes fixed keys from properties and required', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string', description: 'The user email' },
        query: { type: 'string', description: 'Search query' },
      },
      required: ['user_google_email', 'query'],
    };

    const result = stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(result.properties).toEqual({
      query: { type: 'string', description: 'Search query' },
    });
    expect(result.required).toEqual(['query']);
  });

  it('does not mutate the original schema', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['user_google_email', 'query'],
    };

    stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(schema.properties).toHaveProperty('user_google_email');
    expect(schema.required).toContain('user_google_email');
  });

  it('returns schema unchanged when fixedKeys is empty', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };

    const result = stripFixedInputsFromSchema(schema, []);

    expect(result).toBe(schema);
  });

  it('handles schema with no required array', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string' },
        query: { type: 'string' },
      },
    };

    const result = stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(result.properties).toEqual({ query: { type: 'string' } });
    expect(result.required).toBeUndefined();
  });

  it('handles stripping a key not present in schema (no-op)', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };

    const result = stripFixedInputsFromSchema(schema, ['nonexistent_key']);

    expect(result.properties).toEqual({ query: { type: 'string' } });
    expect(result.required).toEqual(['query']);
  });
});

// ---------------------------------------------------------------------------
// mergeFixedInputs
// ---------------------------------------------------------------------------

describe('mergeFixedInputs', () => {
  it('merges fixed values into agent input', () => {
    const agentInput = { query: 'quarterly report' };
    const fixedInputs = { user_google_email: 'curia@example.com' };

    const result = mergeFixedInputs(agentInput, fixedInputs);

    expect(result).toEqual({
      query: 'quarterly report',
      user_google_email: 'curia@example.com',
    });
  });

  it('fixed values override agent-supplied values', () => {
    const agentInput = {
      query: 'quarterly report',
      user_google_email: 'attacker@evil.com',
    };
    const fixedInputs = { user_google_email: 'curia@example.com' };

    const result = mergeFixedInputs(agentInput, fixedInputs);

    expect(result.user_google_email).toBe('curia@example.com');
  });

  it('returns original reference when fixedInputs is empty', () => {
    const agentInput = { query: 'test' };

    const result = mergeFixedInputs(agentInput, {});

    expect(result).toBe(agentInput);
  });
});

// ---------------------------------------------------------------------------
// resolveEnvValue — generic config helper (imported from config.ts). NOTE: as of
// #913 fixed_inputs no longer routes through this; secrets resolve from the vault
// (see resolveFixedInputFromVault below). These tests still pin the config helper,
// which remains in use for channel-account env resolution in config.ts.
// ---------------------------------------------------------------------------

describe('resolveEnvValue (config helper, process.env)', () => {
  it('resolves env:VAR_NAME from process.env', () => {
    const original = process.env.TEST_FIXED_INPUT_EMAIL;
    try {
      process.env.TEST_FIXED_INPUT_EMAIL = 'curia@example.com';
      const result = resolveEnvValue('env:TEST_FIXED_INPUT_EMAIL', 'test context');
      expect(result).toBe('curia@example.com');
    } finally {
      if (original === undefined) {
        delete process.env.TEST_FIXED_INPUT_EMAIL;
      } else {
        process.env.TEST_FIXED_INPUT_EMAIL = original;
      }
    }
  });

  it('throws with a clear message when env var is not set', () => {
    delete process.env.DEFINITELY_NOT_SET_VAR;
    expect(() =>
      resolveEnvValue('env:DEFINITELY_NOT_SET_VAR', "MCP server 'google-workspace' fixed_inputs.user_google_email"),
    ).toThrow(/env var "DEFINITELY_NOT_SET_VAR" is not set/);
  });

  it('passes through literal strings unchanged', () => {
    const result = resolveEnvValue('literal@example.com', 'test context');
    expect(result).toBe('literal@example.com');
  });
});

// ---------------------------------------------------------------------------
// resolveStdioEnvFromVault — vault-only resolution of the stdio env: block (#913)
// ---------------------------------------------------------------------------

describe('resolveStdioEnvFromVault', () => {
  it('resolves an empty-string sentinel from the vault by the lowercased key name', async () => {
    const secrets = fakeSecrets({
      google_oauth_client_id: 'client-id-from-vault',
      google_oauth_client_secret: 'client-secret-from-vault',
    });
    const resolved = await resolveStdioEnvFromVault(
      { GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' },
      secrets,
      'google-workspace',
    );
    expect(resolved).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: 'client-id-from-vault',
      GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-from-vault',
    });
  });

  it('passes non-empty literal values through unchanged (e.g. ALLOWED_FILE_DIRS)', async () => {
    const secrets = fakeSecrets({ google_oauth_client_id: 'x' });
    const resolved = await resolveStdioEnvFromVault(
      { GOOGLE_OAUTH_CLIENT_ID: '', ALLOWED_FILE_DIRS: '/run/curia-tempfiles' },
      secrets,
      'google-workspace',
    );
    expect(resolved.ALLOWED_FILE_DIRS).toBe('/run/curia-tempfiles');
  });

  it('throws (vault-only, no env fallback) when the secret is absent from the vault', async () => {
    const secrets = fakeSecrets({}); // empty vault
    await expect(
      resolveStdioEnvFromVault({ GOOGLE_OAUTH_CLIENT_ID: '' }, secrets, 'google-workspace'),
    ).rejects.toThrow(/secret "google_oauth_client_id" is not set in the vault/);
  });

  it('treats a blank/whitespace-only vault value as absent and throws', async () => {
    const secrets = fakeSecrets({ google_oauth_client_id: '   ' });
    await expect(
      resolveStdioEnvFromVault({ GOOGLE_OAUTH_CLIENT_ID: '' }, secrets, 'google-workspace'),
    ).rejects.toThrow(/is not set in the vault/);
  });

  it('does not fall back to process.env for an empty sentinel', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'leaked-from-process-env';
    try {
      const secrets = fakeSecrets({}); // empty vault
      await expect(
        resolveStdioEnvFromVault({ GOOGLE_OAUTH_CLIENT_ID: '' }, secrets, 'google-workspace'),
      ).rejects.toThrow(/is not set in the vault/);
    } finally {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveFixedInputFromVault — vault-only resolution of "env:VAR" fixed_inputs (#913)
// ---------------------------------------------------------------------------

describe('resolveFixedInputFromVault', () => {
  it('resolves "env:VAR" from the vault by VAR lowercased', async () => {
    const secrets = fakeSecrets({ curia_google_email: 'curia@example.com' });
    const result = await resolveFixedInputFromVault('env:CURIA_GOOGLE_EMAIL', secrets, 'ctx');
    expect(result).toBe('curia@example.com');
  });

  it('passes literal strings through unchanged', async () => {
    const secrets = fakeSecrets({});
    const result = await resolveFixedInputFromVault('literal@example.com', secrets, 'ctx');
    expect(result).toBe('literal@example.com');
  });

  it('throws when the referenced secret is absent from the vault', async () => {
    const secrets = fakeSecrets({});
    await expect(
      resolveFixedInputFromVault(
        'env:CURIA_GOOGLE_EMAIL',
        secrets,
        "MCP server 'google-workspace' fixed_inputs.user_google_email",
      ),
    ).rejects.toThrow(/secret "curia_google_email" is not set in the vault/);
  });
});

// ---------------------------------------------------------------------------
// loadSkillsConfig — YAML parsing including the secrets: block
// ---------------------------------------------------------------------------

describe('loadSkillsConfig', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-')); });
  // Best-effort: a teardown failure must not mask the real assertion.
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ } });

  it('parses a server entry with a secrets: block', () => {
    fs.writeFileSync(path.join(tmpDir, 'skills.yaml'), `
servers:
  - name: atproto-mcp
    transport: stdio
    command: ./node_modules/.bin/atproto-mcp
    action_risk: medium
    secrets:
      - key: atproto_identifier
        label: "Bluesky handle"
        required: true
        secret: false
        inject:
          env: ATPROTO_IDENTIFIER
      - key: atproto_password
        label: "Bluesky app password"
        required: true
        secret: true
        inject:
          env: ATPROTO_PASSWORD
`);
    const config = loadSkillsConfig(tmpDir);
    const server = config.servers![0]! as import('./mcp-config-types.js').McpStdioServerEntry;
    expect(server.secrets).toHaveLength(2);
    expect(server.secrets![0]!.key).toBe('atproto_identifier');
    expect(server.secrets![0]!.inject).toEqual({ env: 'ATPROTO_IDENTIFIER' });
    expect(server.secrets![1]!.secret).toBe(true);
  });

  it('returns empty config when secrets: block is absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'skills.yaml'), `
servers:
  - name: legacy-server
    transport: stdio
    command: ./cmd
    action_risk: low
    env:
      SOME_KEY: ""
`);
    const config = loadSkillsConfig(tmpDir);
    const server = config.servers![0]! as import('./mcp-config-types.js').McpStdioServerEntry;
    expect(server.secrets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveSecretsBlock — declarative credential resolution from the vault
// ---------------------------------------------------------------------------

describe('resolveSecretsBlock', () => {
  // Minimal stub backed by a plain map. Cast through unknown because SecretsService
  // has additional methods (pool, set, getJSON, etc.) not exercised here.
  const makeSecrets = (map: Record<string, string | null>): SecretsService => ({
    get: async (key: string) => map[key] ?? null,
  }) as unknown as SecretsService;

  it('injects resolved value into env when inject.env is set', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'atproto_identifier', label: 'Handle', required: true, secret: false,
      inject: { env: 'ATPROTO_IDENTIFIER' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({ atproto_identifier: 'user.bsky.social' }), 'test-server');
    expect(result.env).toEqual({ ATPROTO_IDENTIFIER: 'user.bsky.social' });
    expect(result.fixedInputs).toEqual({});
  });

  it('injects resolved value into fixedInputs when inject.fixed_input is set', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'curia_google_email', label: 'Email', required: true, secret: false,
      inject: { fixed_input: 'user_google_email' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({ curia_google_email: 'me@example.com' }), 'test-server');
    expect(result.fixedInputs).toEqual({ user_google_email: 'me@example.com' });
    expect(result.env).toEqual({});
  });

  it('throws when a required secret is missing from the vault', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'atproto_password', label: 'Password', required: true, secret: true,
      inject: { env: 'ATPROTO_PASSWORD' },
    }];
    await expect(resolveSecretsBlock(decls, makeSecrets({}), 'atproto-mcp'))
      .rejects.toThrow('atproto-mcp');
  });

  it('silently skips optional secrets that are absent', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'optional_key', label: 'Optional', required: false, secret: false,
      inject: { env: 'OPTIONAL_VAR' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({}), 'test-server');
    expect(result.env).toEqual({});
  });

  it('returns empty maps when declarations array is empty', async () => {
    const result = await resolveSecretsBlock([], makeSecrets({}), 'test-server');
    expect(result).toEqual({ env: {}, fixedInputs: {} });
  });

  it('does not fall back to process.env', async () => {
    const prior = process.env['SHOULD_NOT_READ'];
    process.env['SHOULD_NOT_READ'] = 'leaked';
    try {
      const decls: McpSecretDeclaration[] = [{
        key: 'should_not_read', label: 'Test', required: false, secret: false,
        inject: { env: 'SHOULD_NOT_READ' },
      }];
      const result = await resolveSecretsBlock(decls, makeSecrets({}), 'test-server');
      expect(result.env['SHOULD_NOT_READ']).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env['SHOULD_NOT_READ'];
      else process.env['SHOULD_NOT_READ'] = prior;
    }
  });
});
