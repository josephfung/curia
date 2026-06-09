import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileRegistries } from './reconcile.js';
import type { IRegistryRepo, RegistryRow } from './types.js';
import { createLogger } from '../logger.js';

class FakeRepo implements IRegistryRepo {
  rows = new Map<string, RegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(n: string) { return this.rows.get(n) ?? null; }
  async install(name: string, actor: string) {
    const e = this.rows.get(name); if (e) return e;
    const row: RegistryRow = { name, enabled: false, installedAt: 't0', installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: 't0' };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) {
    const r = this.rows.get(name)!; const n = { ...r, enabled: true, enabledAt: 't1', enabledBy: actor, updatedAt: 't1' };
    this.rows.set(name, n); return n;
  }
  async disable(name: string, _actor: string) {
    const r = this.rows.get(name)!; const n = { ...r, enabled: false, enabledAt: null, enabledBy: null, updatedAt: 't1' };
    this.rows.set(name, n); return n;
  }
  async uninstall(name: string) { this.rows.delete(name); }
}

const logger = createLogger('silent');

describe('reconcileRegistries', () => {
  let skillRepo: FakeRepo;
  let agentRepo: FakeRepo;
  beforeEach(() => { skillRepo = new FakeRepo(); agentRepo = new FakeRepo(); });

  const run = (defaults: { skills: string[]; agents: string[] }, onDisk: { skills: string[]; agents: string[] }) =>
    reconcileRegistries({
      skillRepo, agentRepo,
      skillDiscoveryNames: new Set(onDisk.skills),
      agentDiscoveryNames: new Set(onDisk.agents),
      defaults, logger,
    });

  it('enrolls a core item with no row as enabled', async () => {
    await run({ skills: ['core-skill'], agents: [] }, { skills: ['core-skill', 'other'], agents: [] });
    const row = await skillRepo.getRow('core-skill');
    expect(row?.enabled).toBe(true);
    expect(row?.enabledBy).toBe('reconciliation');
    // Non-core stays uninstalled (no row).
    expect(await skillRepo.getRow('other')).toBeNull();
  });

  it('is idempotent — second run changes nothing', async () => {
    const defaults = { skills: ['core-skill'], agents: [] };
    const onDisk = { skills: ['core-skill'], agents: [] };
    await run(defaults, onDisk);
    const first = await skillRepo.getRow('core-skill');
    await run(defaults, onDisk);
    const second = await skillRepo.getRow('core-skill');
    expect(second).toEqual(first);
  });

  it('respects an admin-disabled core item (row present, disabled)', async () => {
    await skillRepo.install('core-skill', 'web-app'); // row exists, enabled=false
    await run({ skills: ['core-skill'], agents: [] }, { skills: ['core-skill'], agents: [] });
    expect((await skillRepo.getRow('core-skill'))?.enabled).toBe(false);
  });

  it('warns (no throw) when a core default is not on disk', async () => {
    await expect(run({ skills: ['missing'], agents: [] }, { skills: [], agents: [] })).resolves.toBeUndefined();
    expect(await skillRepo.getRow('missing')).toBeNull();
  });
});
