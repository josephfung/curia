import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { Config } from '../../../src/config.js';
import type { SecretsService } from '../../../src/secrets/secrets-service.js';
import { applyVaultSecrets } from '../../../src/secrets/apply-vault-secrets.js';
import { VAPID_SECRET_NAME } from '../../../src/channels/web/vapid.js';
import { isPlatformVaultKey, platformKeyLabel } from '../../../src/secrets/platform-keys.js';

const logger = pino({ level: 'silent' });

describe('platform vault keys', () => {
  it('every key applyVaultSecrets reads is a platform key', async () => {
    const recorded: string[] = [];
    const fake = {
      get: async (name: string) => {
        recorded.push(name);
        return null;
      },
    } as unknown as SecretsService;
    // applyVaultSecrets only assigns onto config, so an empty object is enough here.
    await applyVaultSecrets({} as Config, fake, logger);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.filter((name) => !isPlatformVaultKey(name))).toEqual([]);
  });

  it('the VAPID key is a platform key', () => {
    expect(isPlatformVaultKey(VAPID_SECRET_NAME)).toBe(true);
  });

  it('declared and personal keys are not platform keys', () => {
    expect(isPlatformVaultKey('tavily_api_key')).toBe(false);
    expect(isPlatformVaultKey('user.rogers_password')).toBe(false);
    expect(isPlatformVaultKey('channel.telegram.bot_token')).toBe(false);
  });

  it('labels', () => {
    expect(platformKeyLabel('web_app_bootstrap_secret')).toBe('Console sign-in');
    expect(platformKeyLabel('tavily_api_key')).toBeUndefined();
  });
});
