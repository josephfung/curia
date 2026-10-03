import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileRegistries } from '../../../src/registry/reconcile.js';
import type { IRegistryRepo, RegistryRow } from '../../../src/registry/types.js';
import { createLogger } from '../../../src/logger.js';

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
  /** Names passed to the conditional delete — lets tests assert which path was taken. */
  conditionalDeletes: string[] = [];
  async uninstallIfDisabled(name: string) {
    this.conditionalDeletes.push(name);
    const row = this.rows.get(name);
    if (!row || row.enabled) return false;
    return this.rows.delete(name);
  }
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
    onDisk: {
      tools: string[];
      agents: string[];
      skills?: string[];
      /** bundle → member tools (SKILL.md tools:) */
      members?: Record<string, string[]>;
      /** tool → install.requires_secrets */
      requires?: Record<string, string[]>;
      /** tool → declared capabilities */
      caps?: Record<string, string[]>;
      /** tools whose manifest failed to parse */
      broken?: string[];
      /** bundles whose SKILL.md failed to parse */
      brokenBundles?: string[];
    },
    // Vault keys; `undefined` = no vault at all.
    vault: string[] | undefined = [],
    unavailableCapabilities: string[] = [],
  ) =>
    reconcileRegistries({
      toolRepo,
      agentRepo,
      skillRepo,
      toolManifests: new Map(onDisk.tools.map(t => [
        t,
        onDisk.broken?.includes(t)
          ? null
          : { requiresSecrets: onDisk.requires?.[t] ?? [], capabilities: onDisk.caps?.[t] ?? [] },
      ])),
      agentDiscoveryNames: new Set(onDisk.agents),
      skillDiscoveryNames: new Set(onDisk.skills ?? []),
      bundleMembers: new Map<string, string[] | null>([
        ...Object.entries(onDisk.members ?? {}),
        ...(onDisk.brokenBundles ?? []).map((b): [string, null] => [b, null]),
      ]),
      secrets: vault === undefined ? undefined : { list: async () => { vaultLists++; return vault; } },
      unavailableCapabilities: new Set(unavailableCapabilities),
      defaults,
      logger,
    });
  let vaultLists = 0;
  beforeEach(() => { vaultLists = 0; });

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
  describe('bundle expansion (#1974)', () => {
    const disk = {
      tools: ['doc-read', 'doc-place', 'web-fetch', 'web-search', 'inbox-list'],
      agents: [],
      skills: ['documents', 'web', 'inbox'],
      members: {
        documents: ['doc-read', 'doc-place'],
        web: ['web-fetch', 'web-search'],
        inbox: ['inbox-list'],
      },
      requires: { 'web-search': ['tavily_api_key'] },
    };

    it('enrolls every member of a default bundle without listing it under tools:', async () => {
      await run({ tools: [], agents: [], skills: ['documents'] }, disk);
      expect((await toolRepo.getRow('doc-read'))?.enabled).toBe(true);
      expect((await toolRepo.getRow('doc-place'))?.enabledBy).toBe('reconciliation');
      // Members of a bundle with no row stay uninstalled.
      expect(await toolRepo.getRow('inbox-list')).toBeNull();
    });

    it('expands an admin-enabled bundle that is not a default', async () => {
      await skillRepo.install('inbox', 'web-app');
      await skillRepo.enable('inbox', 'web-app');
      await run({ tools: [], agents: [], skills: [] }, disk);
      expect((await toolRepo.getRow('inbox-list'))?.enabled).toBe(true);
    });

    it('does not expand a bundle an admin disabled, even a default one', async () => {
      await skillRepo.install('documents', 'web-app'); // row present, enabled=false
      await run({ tools: [], agents: [], skills: ['documents'] }, disk);
      expect(await toolRepo.getRow('doc-place')).toBeNull();
    });

    it('never changes an existing member row', async () => {
      await toolRepo.install('doc-place', 'web-app'); // admin left it disabled
      await run({ tools: [], agents: [], skills: ['documents'] }, disk);
      expect((await toolRepo.getRow('doc-place'))?.enabled).toBe(false);
      expect((await toolRepo.getRow('doc-read'))?.enabled).toBe(true);
    });

    it('skips a member that is not on disk without throwing', async () => {
      await run(
        { tools: [], agents: [], skills: ['documents'] },
        { ...disk, members: { documents: ['doc-read', 'doc-gone'] } },
      );
      expect((await toolRepo.getRow('doc-read'))?.enabled).toBe(true);
      expect(await toolRepo.getRow('doc-gone')).toBeNull();
    });

    it('skips a bundle whose members are unknown (ghost or unparsable SKILL.md)', async () => {
      await run({ tools: [], agents: [], skills: ['documents'] }, { ...disk, members: {} });
      expect((await skillRepo.getRow('documents'))?.enabled).toBe(true);
      expect(await toolRepo.listRows()).toEqual([]);
      await run({ tools: [], agents: [], skills: ['documents'] }, { ...disk, members: {}, brokenBundles: ['documents'] });
      expect(await toolRepo.listRows()).toEqual([]);
    });

    it('refuses a member whose tool.json failed to parse — no row, so boot does not crash-loop', async () => {
      await run({ tools: [], agents: [], skills: ['documents'] }, { ...disk, broken: ['doc-place'] });
      expect((await toolRepo.getRow('doc-read'))?.enabled).toBe(true);
      expect(await toolRepo.getRow('doc-place')).toBeNull();
      // Once the manifest is fixed, the next boot enrolls it.
      await run({ tools: [], agents: [], skills: ['documents'] }, disk);
      expect((await toolRepo.getRow('doc-place'))?.enabled).toBe(true);
    });

    it('refuses an unparsable standalone default too', async () => {
      await run({ tools: ['doc-place'], agents: [] }, { ...disk, broken: ['doc-place'] });
      expect(await toolRepo.getRow('doc-place')).toBeNull();
    });

    it('is idempotent', async () => {
      await run({ tools: [], agents: [], skills: ['documents', 'web'] }, disk, ['tavily_api_key']);
      const first = await toolRepo.listRows();
      await run({ tools: [], agents: [], skills: ['documents', 'web'] }, disk, ['tavily_api_key']);
      expect(await toolRepo.listRows()).toEqual(first);
    });
  });

  describe('requires_secrets gate (#1974)', () => {
    const disk = {
      tools: ['web-fetch', 'web-search'],
      agents: [],
      skills: ['web'],
      members: { web: ['web-fetch', 'web-search'] },
      requires: { 'web-search': ['tavily_api_key'] },
    };

    it('holds back a gated member while its secret is missing, leaving no row', async () => {
      await run({ tools: [], agents: [], skills: ['web'] }, disk, ['other_key']);
      expect((await toolRepo.getRow('web-fetch'))?.enabled).toBe(true);
      // No row, not a disabled row — so a later boot can still enroll it.
      expect(await toolRepo.getRow('web-search')).toBeNull();
    });

    it('enrolls the gated member on a later boot once the secret is configured', async () => {
      await run({ tools: [], agents: [], skills: ['web'] }, disk, []);
      expect(await toolRepo.getRow('web-search')).toBeNull();
      await run({ tools: [], agents: [], skills: ['web'] }, disk, ['tavily_api_key']);
      expect((await toolRepo.getRow('web-search'))?.enabled).toBe(true);
    });

    it('fails closed with no vault at all', async () => {
      await run({ tools: [], agents: [], skills: ['web'] }, disk, undefined);
      expect((await toolRepo.getRow('web-fetch'))?.enabled).toBe(true);
      expect(await toolRepo.getRow('web-search')).toBeNull();
    });

    it('requires every declared secret, not just one', async () => {
      await run(
        { tools: [], agents: [], skills: ['web'] },
        { ...disk, requires: { 'web-search': ['tavily_api_key', 'second_key'] } },
        ['tavily_api_key'],
      );
      expect(await toolRepo.getRow('web-search')).toBeNull();
    });

    it('applies to standalone tools listed under tools: too', async () => {
      await run({ tools: ['web-search'], agents: [] }, disk, []);
      expect(await toolRepo.getRow('web-search')).toBeNull();
      await run({ tools: ['web-search'], agents: [] }, disk, ['tavily_api_key']);
      expect((await toolRepo.getRow('web-search'))?.enabled).toBe(true);
    });

    it('does not read the vault when nothing is gated', async () => {
      await run({ tools: [], agents: [], skills: ['web'] }, { ...disk, requires: {} });
      expect(vaultLists).toBe(0);
    });

    it('reads the vault at most once per pass', async () => {
      await run(
        { tools: ['web-search'], agents: [], skills: ['web'] },
        { ...disk, requires: { 'web-search': ['k'], 'web-fetch': ['k'] } },
        [],
      );
      expect(vaultLists).toBe(1);
    });
  });
  describe('unavailable-capability gate (#1974)', () => {
    const disk = {
      tools: ['calendar-list-events', 'calendar-register'],
      agents: [],
      skills: ['calendar'],
      members: { calendar: ['calendar-list-events', 'calendar-register'] },
      caps: { 'calendar-list-events': ['nylasCalendarClient'], 'calendar-register': ['entityMemory'] },
    };

    it('holds back a member whose declared capability this boot did not build', async () => {
      await run({ tools: [], agents: [], skills: ['calendar'] }, disk, [], ['nylasCalendarClient']);
      expect(await toolRepo.getRow('calendar-list-events')).toBeNull();
      // A capability that IS available doesn't hold anything back.
      expect((await toolRepo.getRow('calendar-register'))?.enabled).toBe(true);
    });

    it('enrolls it on a later boot once the integration is configured', async () => {
      await run({ tools: [], agents: [], skills: ['calendar'] }, disk, [], ['nylasCalendarClient']);
      await run({ tools: [], agents: [], skills: ['calendar'] }, disk, [], []);
      expect((await toolRepo.getRow('calendar-list-events'))?.enabled).toBe(true);
    });
  });
});
