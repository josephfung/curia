import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { SecretsService } from '../../../src/secrets/secrets-service.js';
import { migrateLegacyTavilyKey } from '../../../src/secrets/migrate-legacy-tavily-key.js';

const logger = pino({ level: 'silent' });

function fakeVault(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const set = vi.fn(async (name: string, value: string) => { store.set(name, value); });
  const secrets = {
    get: vi.fn(async (name: string) => store.get(name) ?? null),
    set,
  } as unknown as SecretsService;
  return { secrets, store, set };
}

describe('migrateLegacyTavilyKey (#2409 item 2, #2445)', () => {
  it('copies user.tavily_api_key to tavily_api_key and leaves the legacy entry', async () => {
    const { secrets, store } = fakeVault({ 'user.tavily_api_key': 'tvly-legacy' });
    expect(await migrateLegacyTavilyKey(secrets, logger)).toBe(true);
    expect(store.get('tavily_api_key')).toBe('tvly-legacy');
    expect(store.get('user.tavily_api_key')).toBe('tvly-legacy');
  });

  it('never overwrites an existing tavily_api_key', async () => {
    const { secrets, store, set } = fakeVault({ tavily_api_key: 'tvly-current', 'user.tavily_api_key': 'tvly-legacy' });
    expect(await migrateLegacyTavilyKey(secrets, logger)).toBe(false);
    expect(store.get('tavily_api_key')).toBe('tvly-current');
    expect(set).not.toHaveBeenCalled();
  });

  it('does nothing when there is no legacy key', async () => {
    const { secrets, set } = fakeVault({});
    expect(await migrateLegacyTavilyKey(secrets, logger)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('propagates vault errors', async () => {
    const secrets = { get: vi.fn().mockRejectedValue(new Error('decrypt failed')), set: vi.fn() } as unknown as SecretsService;
    await expect(migrateLegacyTavilyKey(secrets, logger)).rejects.toThrow('decrypt failed');
  });
});
