import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Config } from '../config.js';
import { applyChannelVaultSecrets } from './apply-channel-vault-secrets.js';

const logger = pino({ level: 'silent' });

// Minimal config covering every field the overlay touches (mirrors apply-vault-secrets.test.ts).
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
    ceoSignalNumber: undefined,
    signalSocketPath: undefined,
    signalPhoneNumber: undefined,
    slackBotToken: undefined,
    slackAppToken: undefined,
    smsApiKey: undefined,
    smsFromNumber: undefined,
    smsWebhookPublicKey: undefined,
  } as Config;
}

// A vault fake whose get() is a spy, so tests can assert exactly which keys were read.
function fakeSecrets(values: Record<string, string>) {
  return { get: vi.fn(async (name: string) => values[name] ?? null) };
}

describe('applyChannelVaultSecrets', () => {
  it('populates config from vault-only channel.email.* / channel.signal.* / channel.slack.* / channel.sms.* keys', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({
      'channel.email.nylas_api_key': 'nyk_vault',
      'channel.email.nylas_grant_id': 'grant_vault',
      'channel.email.nylas_self_email': 'curia@vault.test',
      'channel.signal.phone_number': '+15550001111',
      'channel.signal.socket_path': '/run/signal/socket',
      'channel.slack.bot_token': 'xoxb-vault',
      'channel.slack.app_token': 'xapp-vault',
      'channel.sms.api_key': 'KEY_vault',
      'channel.sms.from_number': '+15550002222',
      'channel.sms.webhook_public_key': 'pubkey_vault',
    });

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    expect(config.nylasApiKey).toBe('nyk_vault');
    expect(config.nylasGrantId).toBe('grant_vault');
    expect(config.nylasSelfEmail).toBe('curia@vault.test');
    expect(config.signalPhoneNumber).toBe('+15550001111');
    expect(config.signalSocketPath).toBe('/run/signal/socket');
    expect(config.slackBotToken).toBe('xoxb-vault');
    expect(config.slackAppToken).toBe('xapp-vault');
    expect(config.smsApiKey).toBe('KEY_vault');
    expect(config.smsFromNumber).toBe('+15550002222');
    expect(config.smsWebhookPublicKey).toBe('pubkey_vault');
  });

  it('activates Signal from a console-only entry — channel.signal.phone_number alone, no flat bootstrap, no env', async () => {
    // baseConfig().signalPhoneNumber is undefined: there is no flat-key bootstrap value to
    // fall back on, so this proves the console-written key alone populates config (#1140).
    const config = baseConfig();
    const secrets = fakeSecrets({
      'channel.signal.phone_number': '+15550009999',
      'channel.signal.socket_path': '/run/signal/socket',
    });

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    expect(config.signalPhoneNumber).toBe('+15550009999');
    expect(config.signalSocketPath).toBe('/run/signal/socket');
  });

  it('falls back to env when the vault is empty', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({});
    const env = {
      NYLAS_API_KEY: 'nyk_env',
      NYLAS_GRANT_ID: 'grant_env',
      NYLAS_SELF_EMAIL: 'curia@env.test',
      SIGNAL_PHONE_NUMBER: '+15550002222',
      SIGNAL_SOCKET_PATH: '/env/signal/socket',
    };

    await applyChannelVaultSecrets(config, secrets, env, logger);

    expect(config.nylasApiKey).toBe('nyk_env');
    expect(config.signalSocketPath).toBe('/env/signal/socket');
  });

  it('channel vault wins over env when both are present', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({ 'channel.email.nylas_api_key': 'nyk_vault' });
    const env = { NYLAS_API_KEY: 'nyk_env' };

    await applyChannelVaultSecrets(config, secrets, env, logger);

    expect(config.nylasApiKey).toBe('nyk_vault');
  });

  it('keeps the current config value when neither vault nor env supplies one', async () => {
    const config = baseConfig();
    config.nylasApiKey = 'nyk_bootstrap'; // e.g. already set by applyVaultSecrets
    const secrets = fakeSecrets({});

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    expect(config.nylasApiKey).toBe('nyk_bootstrap');
    expect(config.nylasGrantId).toBeUndefined();
    expect(config.nylasSelfEmail).toBe(''); // string-typed field stays ''
    expect(config.signalSocketPath).toBeUndefined();
  });

  it('treats a whitespace-only vault value as absent and falls through', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({ 'channel.email.nylas_api_key': '   ' });
    const env = { NYLAS_API_KEY: 'nyk_env' };

    await applyChannelVaultSecrets(config, secrets, env, logger);

    expect(config.nylasApiKey).toBe('nyk_env');
  });

  it('treats a vault read error as absent (no throw)', async () => {
    const config = baseConfig();
    const secrets = {
      get: vi.fn(async (name: string) => {
        if (name === 'channel.email.nylas_api_key') throw new Error('vault down');
        return null;
      }),
    };
    const env = { NYLAS_API_KEY: 'nyk_env' };

    await expect(applyChannelVaultSecrets(config, secrets, env, logger)).resolves.toBeUndefined();
    expect(config.nylasApiKey).toBe('nyk_env');
  });

  it('reads ONLY the named channel.* keys — never list(), never user.* / dot-free keys', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({});

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    const readKeys = secrets.get.mock.calls.map(c => c[0]).sort();
    expect(readKeys).toEqual([
      'channel.email.nylas_api_key',
      'channel.email.nylas_grant_id',
      'channel.email.nylas_self_email',
      'channel.signal.phone_number',
      'channel.signal.socket_path',
      'channel.slack.app_token',
      'channel.slack.bot_token',
      'channel.sms.api_key',
      'channel.sms.from_number',
      'channel.sms.webhook_public_key',
    ]);
    // No list() method should even be invoked (the fake doesn't have one).
    expect('list' in secrets).toBe(false);
  });
});

// The AC1 gate/adapter agreement coverage (formerly here, using the deleted resolveChannelAccounts
// YAML/env resolver) was rebuilt for the per-account table+vault model in
// ./email/resolve-email-accounts.agreement.test.ts (#1101 Task 7).
