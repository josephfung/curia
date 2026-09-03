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
  async installAndEnable(name: string, actor: string) {
    if (this.rows.has(name)) return null;
    const row: RegistryRow = { name, enabled: true, installedAt: 't0', installedBy: actor, enabledAt: 't0', enabledBy: actor, updatedAt: 't0' };
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
  async uninstall(name: string) { return this.rows.delete(name); }
}

const logger = createLogger('silent');

describe('reconcileRegistries', () => {
  let toolRepo: FakeRepo;
  let agentRepo: FakeRepo;
  let skillRepo: FakeRepo;
  beforeEach(() => {
    toolRepo = new FakeRepo();
    agentRepo = new FakeRepo();
    skillRepo = new FakeRepo();
  });

  const run = (
    defaults: { tools: string[]; agents: string[]; skills?: string[] },
    onDisk: { tools: string[]; agents: string[]; skills?: string[] },
  ) =>
    reconcileRegistries({
      toolRepo,
      agentRepo,
      skillRepo,
      toolDiscoveryNames: new Set(onDisk.tools),
      agentDiscoveryNames: new Set(onDisk.agents),
      skillDiscoveryNames: new Set(onDisk.skills ?? []),
      defaults,
      logger,
    });

  it('enrolls a core item with no row as enabled', async () => {
    await run({ tools: ['core-skill'], agents: [] }, { tools: ['core-skill', 'other'], agents: [] });
    const row = await toolRepo.getRow('core-skill');
    expect(row?.enabled).toBe(true);
    expect(row?.enabledBy).toBe('reconciliation');
    // Non-core stays uninstalled (no row).
    expect(await toolRepo.getRow('other')).toBeNull();
  });

  it('is idempotent — second run changes nothing', async () => {
    const defaults = { tools: ['core-skill'], agents: [] };
    const onDisk = { tools: ['core-skill'], agents: [] };
    await run(defaults, onDisk);
    const first = await toolRepo.getRow('core-skill');
    await run(defaults, onDisk);
    const second = await toolRepo.getRow('core-skill');
    expect(second).toEqual(first);
  });

  it('respects an admin-disabled core item (row present, disabled)', async () => {
    await toolRepo.install('core-skill', 'web-app'); // row exists, enabled=false
    await run({ tools: ['core-skill'], agents: [] }, { tools: ['core-skill'], agents: [] });
    expect((await toolRepo.getRow('core-skill'))?.enabled).toBe(false);
  });

  it('respects an admin-enabled core item (row present, enabled)', async () => {
    await toolRepo.install('core-skill', 'web-app');
    await toolRepo.enable('core-skill', 'web-app');
    const before = await toolRepo.getRow('core-skill');
    await run({ tools: ['core-skill'], agents: [] }, { tools: ['core-skill'], agents: [] });
    expect(await toolRepo.getRow('core-skill')).toEqual(before);
  });

  it('warns (no throw) when a core default is not on disk', async () => {
    await expect(run({ tools: ['missing'], agents: [] }, { tools: [], agents: [] })).resolves.toBeUndefined();
    expect(await toolRepo.getRow('missing')).toBeNull();
  });

  it('enrolls core skill bundles into skill_registry', async () => {
    await run(
      { tools: [], agents: [], skills: ['tasks'] },
      { tools: [], agents: [], skills: ['tasks', 'other-bundle'] },
    );
    expect((await skillRepo.getRow('tasks'))?.enabled).toBe(true);
    expect(await skillRepo.getRow('other-bundle')).toBeNull();
  });
});
