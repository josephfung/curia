import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Config } from '../config.js';
import type { SecretsService } from './secrets-service.js';
import { applyVaultSecrets } from './apply-vault-secrets.js';

const logger = pino({ level: 'silent' });

// Minimal config with only the fields applyVaultSecrets touches (plus required others).
function baseConfig(): Config {
  return {
    databaseUrl: 'postgres://x',
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openrouterApiKey: undefined,
    logLevel: 'info',
    httpPort: 3000,
    apiToken: undefined,
    webAppBootstrapSecret: undefined,
    appOrigin: undefined,
    timezone: 'UTC',
    nylasApiKey: undefined,
    nylasGrantId: undefined,
    nylasPollingIntervalMs: 30000,
    nylasSelfEmail: '',
    ceoPrimaryEmail: undefined,
    ceoSignalNumber: undefined,
    signalSocketPath: undefined,
    signalPhoneNumber: undefined,
  };
}

function fakeSecrets(values: Record<string, string>): SecretsService {
  return { get: vi.fn(async (name: string) => values[name] ?? null) } as unknown as SecretsService;
}

describe('applyVaultSecrets', () => {
  it('overwrites config secret fields from the vault', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({
      anthropic_api_key: 'sk-ant-vault',
      api_token: 'tok-vault',
      nylas_grant_id: 'grant-vault',
      nylas_self_email: 'curia@vault.test',
    });

    await applyVaultSecrets(config, secrets, logger);

    expect(config.anthropicApiKey).toBe('sk-ant-vault');
    expect(config.apiToken).toBe('tok-vault');
    expect(config.nylasGrantId).toBe('grant-vault');
    expect(config.nylasSelfEmail).toBe('curia@vault.test');
  });

  it('sets undefined for absent secrets (no env fallback)', async () => {
    const config = baseConfig();
    // Even if process.env had a value, applyVaultSecrets must NOT read it.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-should-be-ignored';
    const secrets = fakeSecrets({}); // vault empty

    await applyVaultSecrets(config, secrets, logger);

    expect(config.anthropicApiKey).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('defaults nylasSelfEmail to empty string when absent (type is string, not undefined)', async () => {
    const config = baseConfig();
    await applyVaultSecrets(config, fakeSecrets({}), logger);
    expect(config.nylasSelfEmail).toBe('');
  });
});
