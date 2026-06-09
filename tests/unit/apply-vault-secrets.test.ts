import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { Config } from '../../src/config.js';
import type { SecretsService } from '../../src/secrets/secrets-service.js';
import { applyVaultSecrets } from '../../src/secrets/apply-vault-secrets.js';

const logger = pino({ level: 'silent' });

// Minimal SecretsService stub: applyVaultSecrets only calls get(name).
function stubSecrets(values: Record<string, string | null>): SecretsService {
  return {
    get: async (name: string) => (name in values ? values[name] : null),
  } as unknown as SecretsService;
}

// Bare config carrying just the fields applyVaultSecrets writes.
function blankConfig(): Config {
  return {
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openrouterApiKey: undefined,
    apiToken: undefined,
    webAppBootstrapSecret: undefined,
    nylasApiKey: undefined,
    nylasGrantId: undefined,
    nylasSelfEmail: '',
    signalPhoneNumber: undefined,
  } as unknown as Config;
}

describe('applyVaultSecrets', () => {
  it('writes present vault values onto config and leaves absent ones undefined', async () => {
    const config = blankConfig();
    await applyVaultSecrets(
      config,
      stubSecrets({ anthropic_api_key: 'sk-ant-x', api_token: 'tok-x' }),
      logger,
    );
    expect(config.anthropicApiKey).toBe('sk-ant-x');
    expect(config.apiToken).toBe('tok-x');
    expect(config.signalPhoneNumber).toBeUndefined();
    expect(config.nylasApiKey).toBeUndefined();
  });

  it('trims surrounding whitespace from vault values', async () => {
    const config = blankConfig();
    await applyVaultSecrets(
      config,
      stubSecrets({ anthropic_api_key: '  sk-ant-x\n', signal_phone_number: ' +12223334444 ' }),
      logger,
    );
    expect(config.anthropicApiKey).toBe('sk-ant-x');
    expect(config.signalPhoneNumber).toBe('+12223334444');
  });

  it('collapses a whitespace-only value to undefined so feature/boot guards stay honest', async () => {
    const config = blankConfig();
    await applyVaultSecrets(
      config,
      // A blank signal_phone_number must NOT wire up the Signal channel; a blank
      // api_token must trip the !config.apiToken boot guard rather than read as present.
      stubSecrets({ signal_phone_number: '   ', api_token: ' ' }),
      logger,
    );
    expect(config.signalPhoneNumber).toBeUndefined();
    expect(config.apiToken).toBeUndefined();
  });

  it('defaults nylasSelfEmail to an empty string, never undefined', async () => {
    const config = blankConfig();
    await applyVaultSecrets(config, stubSecrets({}), logger);
    expect(config.nylasSelfEmail).toBe('');
  });
});
