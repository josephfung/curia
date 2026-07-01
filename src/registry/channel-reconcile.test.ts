// src/registry/channel-reconcile.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileChannelRegistry } from './channel-reconcile.js';
import type { IChannelRegistryRepo, ChannelRegistryRow } from './channel-registry-types.js';
import type { ChannelDescriptor } from '../channels/catalog.js';
import { createLogger } from '../logger.js';

class FakeRepo implements IChannelRegistryRepo {
  rows = new Map<string, ChannelRegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(n: string) { return this.rows.get(n) ?? null; }
  async install(name: string, actor: string, isToggleable: boolean) {
    const e = this.rows.get(name); if (e) return e;
    const row: ChannelRegistryRow = { name, enabled: false, isToggleable, installedAt: 't0', installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: 't0' };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) { const r = this.rows.get(name)!; const n = { ...r, enabled: true, enabledAt: 't1', enabledBy: actor }; this.rows.set(name, n); return n; }
  async disable(name: string, _a: string) { const r = this.rows.get(name)!; const n = { ...r, enabled: false, enabledAt: null, enabledBy: null }; this.rows.set(name, n); return n; }
  async uninstall(name: string) { this.rows.delete(name); }
}

const silentLogger = createLogger('silent');

const CATALOG: ChannelDescriptor[] = [
  { name: 'email', description: '', isToggleable: true, credentialFields: [], requiredSecretKeys: ['x'] },
  { name: 'signal', description: '', isToggleable: true, credentialFields: [], requiredSecretKeys: ['y'] },
  { name: 'http', description: '', isToggleable: false, credentialFields: [], requiredSecretKeys: [] },
  { name: 'cli', description: '', isToggleable: false, credentialFields: [], requiredSecretKeys: [] },
];

describe('reconcileChannelRegistry', () => {
  let repo: FakeRepo;
  beforeEach(() => { repo = new FakeRepo(); });

  it('always enrolls http and cli as enabled + non-toggleable', async () => {
    await reconcileChannelRegistry({ repo, catalog: CATALOG, logger: silentLogger });
    for (const name of ['http', 'cli']) {
      const row = repo.rows.get(name)!;
      expect(row.enabled).toBe(true);
      expect(row.isToggleable).toBe(false);
    }
  });

  it('leaves toggleable channels uninstalled on a fresh boot even when credentials would resolve', async () => {
    await reconcileChannelRegistry({ repo, catalog: CATALOG, logger: silentLogger });
    expect(repo.rows.get('email')).toBeUndefined();
    expect(repo.rows.get('signal')).toBeUndefined();
  });

  it('respects existing admin state and does not overwrite it', async () => {
    await repo.install('email', 'admin', true); // installed but deliberately left disabled
    await reconcileChannelRegistry({ repo, catalog: CATALOG, logger: silentLogger });
    expect(repo.rows.get('email')!.enabled).toBe(false);   // left as-is
  });

  it('keeps a disabled toggleable channel disabled across restarts', async () => {
    await repo.install('email', 'admin', true);
    await repo.enable('email', 'admin');
    await repo.disable('email', 'admin');
    await reconcileChannelRegistry({ repo, catalog: CATALOG, logger: silentLogger });
    expect(repo.rows.get('email')!.enabled).toBe(false);
  });

  it('does not re-install a toggleable channel after operator uninstall', async () => {
    await repo.install('email', 'admin', true);
    await repo.enable('email', 'admin');
    await repo.uninstall('email');
    await reconcileChannelRegistry({ repo, catalog: CATALOG, logger: silentLogger });
    expect(repo.rows.get('email')).toBeUndefined();
  });

  it('re-enables http/cli if a prior run left them disabled (safeguard)', async () => {
    await repo.install('http', 'system', false); // disabled row exists
    await reconcileChannelRegistry({ repo, catalog: CATALOG, logger: silentLogger });
    expect(repo.rows.get('http')!.enabled).toBe(true);
  });
});
