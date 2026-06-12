// src/registry/channel-registry-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelRegistryService } from './channel-registry-service.js';
import { ChannelGuardError } from './channel-registry-types.js';
import type { IChannelRegistryRepo, ChannelRegistryRow } from './channel-registry-types.js';
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { ChannelCredentialStatus } from '../channels/credential-resolver.js';

class FakeRepo implements IChannelRegistryRepo {
  rows = new Map<string, ChannelRegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(n: string) { return this.rows.get(n) ?? null; }
  async install(name: string, actor: string, isToggleable: boolean) {
    const existing = this.rows.get(name);
    if (existing) return existing;
    const row: ChannelRegistryRow = { name, enabled: false, isToggleable, installedAt: 't0', installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: 't0' };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) {
    const row = this.rows.get(name); if (!row) throw new Error('no row');
    const next = { ...row, enabled: true, enabledAt: 't1', enabledBy: actor }; this.rows.set(name, next); return next;
  }
  async disable(name: string, _actor: string) {
    const row = this.rows.get(name); if (!row) throw new Error('no row');
    const next = { ...row, enabled: false, enabledAt: null, enabledBy: null }; this.rows.set(name, next); return next;
  }
  async uninstall(name: string) { this.rows.delete(name); }
}

const CATALOG: ChannelDescriptor[] = [
  { name: 'signal', description: 'sig', isToggleable: true,
    credentialFields: [{ key: 'phone_number', label: 'Phone', secret: false }], requiredSecretKeys: ['phone_number'] },
  { name: 'http', description: 'http', isToggleable: false, credentialFields: [], requiredSecretKeys: [] },
];

// Credential status fn: signal resolvable iff `signalReady`, http always resolvable.
const statusFn = (signalReady: boolean) =>
  async (d: ChannelDescriptor): Promise<ChannelCredentialStatus> => {
    if (d.name === 'signal') {
      return { requiredResolvable: signalReady, fields: [{ key: 'phone_number', label: 'Phone', secret: false, configured: signalReady, source: signalReady ? 'vault' : 'missing' }] };
    }
    return { requiredResolvable: true, fields: [] };
  };

describe('ChannelRegistryService', () => {
  let repo: FakeRepo;
  beforeEach(() => { repo = new FakeRepo(); });

  it('list derives state: no row → uninstalled, row+disabled → installed, row+enabled → enabled', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    let entries = await svc.list();
    expect(entries.find(e => e.name === 'signal')!.state).toBe('uninstalled');
    await svc.install('signal', 'a');
    entries = await svc.list();
    expect(entries.find(e => e.name === 'signal')!.state).toBe('installed');
    await svc.enable('signal', 'a');
    entries = await svc.list();
    expect(entries.find(e => e.name === 'signal')!.state).toBe('enabled');
  });

  it('list surfaces isToggleable and credential field status from the catalog + resolver', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(false));
    const entries = await svc.list();
    const http = entries.find(e => e.name === 'http')!;
    expect(http.isToggleable).toBe(false);
    const signal = entries.find(e => e.name === 'signal')!;
    expect(signal.requiredResolvable).toBe(false);
    expect(signal.credentialFields[0]!.source).toBe('missing');
  });

  it('enable is rejected when required credentials do not resolve', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(false));
    await svc.install('signal', 'a');
    await expect(svc.enable('signal', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('enable of a not-installed channel is rejected', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    await expect(svc.enable('signal', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('install/enable/disable of an unknown channel is rejected', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    await expect(svc.install('telegram', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('disable and uninstall of a non-toggleable channel are rejected', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    await repo.install('http', 'system', false);
    await repo.enable('http', 'system');
    await expect(svc.disable('http', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
    await expect(svc.uninstall('http', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('uninstall clears the channel vault keys and removes the row', async () => {
    const deleted: string[] = [];
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true), { delete: async (n: string) => { deleted.push(n); } });
    await svc.install('signal', 'a');
    await svc.uninstall('signal', 'a');
    expect(deleted).toContain('channel.signal.phone_number');
    expect(await repo.getRow('signal')).toBeNull();
  });
});
