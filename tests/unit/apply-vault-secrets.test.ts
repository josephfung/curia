import { describe, it, expect, vi } from 'vitest';
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
    signalPhoneNumber: undefined,
    slackBotToken: undefined,
    slackAppToken: undefined,
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
      stubSecrets({ anthropic_api_key: '  sk-ant-x\n', api_token: '  tok-x \n' }),
      logger,
    );
    expect(config.anthropicApiKey).toBe('sk-ant-x');
    expect(config.apiToken).toBe('tok-x');
  });

  it('collapses a whitespace-only value to undefined so feature/boot guards stay honest', async () => {
    const config = blankConfig();
    await applyVaultSecrets(
      config,
      // A blank api_token must trip the !config.apiToken boot guard rather than read as present.
      stubSecrets({ api_token: ' ' }),
      logger,
    );
    expect(config.apiToken).toBeUndefined();
  });

  it('does not read or write signalPhoneNumber — that key is owned by applyChannelVaultSecrets', async () => {
    const config = blankConfig();
    // Even with a legacy flat signal_phone_number present in the vault, applyVaultSecrets
    // must leave config.signalPhoneNumber untouched (#1140 consolidation).
    await applyVaultSecrets(
      config,
      stubSecrets({ signal_phone_number: '+12223334444' }),
      logger,
    );
    expect(config.signalPhoneNumber).toBeUndefined();
  });

  it('ignores the retired flat Nylas keys — the API key is owned by applyChannelVaultSecrets (#2522)', async () => {
    const config = blankConfig();
    const secrets = stubSecrets({ nylas_api_key: 'nyk_legacy', nylas_grant_id: 'g', nylas_self_email: 'c@x.test' });
    const get = vi.spyOn(secrets, 'get');
    await applyVaultSecrets(config, secrets, logger);
    expect(config.nylasApiKey).toBeUndefined();
    expect(get.mock.calls.map(([name]) => name).filter(n => n.startsWith('nylas_'))).toEqual([]);
  });
});
