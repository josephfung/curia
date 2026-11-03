import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { migrateLegacyTavilyKey } from '../../../src/secrets/migrate-legacy-tavily-key.js';

const logger = pino({ level: 'silent' });

function fakeVault(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (name: string) => store.get(name) ?? null),
    set: vi.fn(async (name: string, value: string) => { store.set(name, value); }),
    delete: vi.fn(async (name: string) => { store.delete(name); }),
  };
}

describe('migrateLegacyTavilyKey', () => {
  it('moves user.tavily_api_key to tavily_api_key when only the user key is set', async () => {
    const vault = fakeVault({ 'user.tavily_api_key': 'tvly-abc' });
    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('moved');
    expect(Object.fromEntries(vault.store)).toEqual({ tavily_api_key: 'tvly-abc' });
  });

  // #2449 review: deleting tavily_api_key (to revoke it, or to go back to keyless search,
  // #2445) must survive the next boot. The move leaves no user.* copy to restore from.
  it('does not restore tavily_api_key on the next boot after the operator deletes it', async () => {
    const vault = fakeVault({ 'user.tavily_api_key': 'tvly-abc' });
    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('moved');

    vault.store.delete('tavily_api_key'); // the operator removes the key
    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('nothing_to_move');
    expect(vault.store.get('tavily_api_key')).toBeUndefined();
    expect(vault.set).toHaveBeenCalledTimes(1);
  });

  it('leaves both keys alone when tavily_api_key is already set', async () => {
    const vault = fakeVault({ 'user.tavily_api_key': 'tvly-old', tavily_api_key: 'tvly-new' });
    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('kept_existing');
    expect(Object.fromEntries(vault.store)).toEqual({ 'user.tavily_api_key': 'tvly-old', tavily_api_key: 'tvly-new' });
    expect(vault.set).not.toHaveBeenCalled();
  });

  it('does nothing when there is no user key, or it is blank', async () => {
    const cases: Array<Record<string, string>> = [{}, { 'user.tavily_api_key': '  ' }];
    for (const initial of cases) {
      const vault = fakeVault(initial);
      await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('nothing_to_move');
      expect(vault.set).not.toHaveBeenCalled();
      expect(vault.delete).not.toHaveBeenCalled();
    }
  });

  it('keeps the user key when the copy fails', async () => {
    const vault = fakeVault({ 'user.tavily_api_key': 'tvly-abc' });
    vault.set.mockRejectedValueOnce(new Error('vault down'));
    await expect(migrateLegacyTavilyKey(vault, logger)).rejects.toThrow('vault down');
    expect(vault.store.get('user.tavily_api_key')).toBe('tvly-abc');
    expect(vault.delete).not.toHaveBeenCalled();
  });

  // The copy landed, so web-search can read tavily_api_key this boot; a failed cleanup
  // must not surface as a migration failure (the boot warning would say search stays off).
  it('reports moved, not a failure, when only the delete of the user key fails', async () => {
    const vault = fakeVault({ 'user.tavily_api_key': 'tvly-abc' });
    vault.delete.mockRejectedValueOnce(new Error('vault down'));
    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('moved');
    expect(vault.store.get('tavily_api_key')).toBe('tvly-abc');
    expect(vault.store.get('user.tavily_api_key')).toBe('tvly-abc');
  });

  // The stale copy left by a failed cleanup must go on a later boot, or removing
  // tavily_api_key would see it moved back and web-search turned on again.
  it('retries the cleanup when both keys hold the same value, so a removal sticks', async () => {
    const vault = fakeVault({ 'user.tavily_api_key': 'tvly-abc' });
    vault.delete.mockRejectedValueOnce(new Error('vault down'));
    await migrateLegacyTavilyKey(vault, logger);

    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('kept_existing');
    expect(Object.fromEntries(vault.store)).toEqual({ tavily_api_key: 'tvly-abc' });

    vault.store.delete('tavily_api_key'); // the operator removes the key
    await expect(migrateLegacyTavilyKey(vault, logger)).resolves.toBe('nothing_to_move');
    expect(vault.store.size).toBe(0);
  });
});
