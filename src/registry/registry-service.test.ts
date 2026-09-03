import { describe, it, expect, beforeEach } from 'vitest';
import { RegistryService } from './registry-service.js';
import type { IRegistryRepo, RegistryRow, Discovery, SecretsLister, IBundleCascadeRepo } from './types.js';

// In-memory fake vault — returns whatever key names it was seeded with.
class FakeSecrets implements SecretsLister {
  constructor(private names: string[] = []) {}
  async list() { return [...this.names]; }
}

// In-memory fake repo — exercises RegistryService logic without a database.
class FakeRepo implements IRegistryRepo {
  rows = new Map<string, RegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(name: string) { return this.rows.get(name) ?? null; }
  async install(name: string, actor: string) {
    const existing = this.rows.get(name);
    if (existing) return existing;
    const row: RegistryRow = {
      name, enabled: false, installedAt: 't0', installedBy: actor,
      enabledAt: null, enabledBy: null, updatedAt: 't0',
    };
    this.rows.set(name, row); return row;
  }
  async installAndEnable(name: string, actor: string) {
    if (this.rows.has(name)) return null;
    const row: RegistryRow = {
      name, enabled: true, installedAt: 't0', installedBy: actor,
      enabledAt: 't0', enabledBy: actor, updatedAt: 't0',
    };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) {
    const row = this.rows.get(name);
    if (!row) throw new Error(`no row ${name}`);
    const next = { ...row, enabled: true, enabledAt: 't1', enabledBy: actor, updatedAt: 't1' };
    this.rows.set(name, next); return next;
  }
  async disable(name: string, _actor: string) {
    const row = this.rows.get(name);
    if (!row) throw new Error(`no row ${name}`);
    const next = { ...row, enabled: false, enabledAt: null, enabledBy: null, updatedAt: 't1' };
    this.rows.set(name, next); return next;
  }
  async uninstall(name: string) { return this.rows.delete(name); }
}

const disc = (name: string, extra: Partial<Discovery> = {}): Discovery => ({
  name, metadata: { name, description: `${name} desc`, version: '1.0.0' }, ...extra,
});

describe('RegistryService.list — derived state', () => {
  let skillRepo: FakeRepo;
  let svc: RegistryService;
  beforeEach(() => {
    skillRepo = new FakeRepo();
    svc = new RegistryService(skillRepo, new FakeRepo(), [], []);
  });

  it('on disk, no row → uninstalled', async () => {
    svc.setDiscovery('tool', [disc('a')]);
    const [entry] = await svc.list('tool');
    expect(entry!.state).toBe('uninstalled');
  });

  it('row + disabled → installed', async () => {
    svc.setDiscovery('tool', [disc('a')]);
    await skillRepo.install('a', 'web-app');
    const [entry] = await svc.list('tool');
    expect(entry!.state).toBe('installed');
  });

  it('row + enabled → enabled', async () => {
    svc.setDiscovery('tool', [disc('a')]);
    await skillRepo.install('a', 'web-app');
    await skillRepo.enable('a', 'web-app');
    const [entry] = await svc.list('tool');
    expect(entry!.state).toBe('enabled');
  });

  it('row + no files → ghost (metadata null)', async () => {
    svc.setDiscovery('tool', []);
    await skillRepo.install('gone', 'web-app');
    const [entry] = await svc.list('tool');
    expect(entry!.state).toBe('ghost');
    expect(entry!.metadata).toBeNull();
  });

  it('bad manifest → entry carries manifestError', async () => {
    svc.setDiscovery('tool', [{ name: 'b', metadata: null, error: 'bad json' }]);
    const [entry] = await svc.list('tool');
    expect(entry!.manifestError).toBe('bad json');
  });
});

describe('RegistryService lifecycle guards', () => {
  let skillRepo: FakeRepo;
  let svc: RegistryService;
  beforeEach(() => {
    skillRepo = new FakeRepo();
    svc = new RegistryService(skillRepo, new FakeRepo(), [], []);
  });

  it('install rejects a ghost (not on disk)', async () => {
    svc.setDiscovery('tool', []);
    await expect(svc.install('tool', 'ghost', 'web-app')).rejects.toThrow(/not on disk/);
  });

  it('install rejects an item with a manifest error', async () => {
    svc.setDiscovery('tool', [{ name: 'b', metadata: null, error: 'bad json' }]);
    await expect(svc.install('tool', 'b', 'web-app')).rejects.toThrow(/manifest/i);
  });

  it('enable requires an installed row', async () => {
    svc.setDiscovery('tool', [disc('a')]);
    await expect(svc.enable('tool', 'a', 'web-app')).rejects.toThrow(/not installed/);
  });

  it('installAndEnable installs then enables', async () => {
    svc.setDiscovery('tool', [disc('a')]);
    const entry = await svc.installAndEnable('tool', 'a', 'web-app');
    expect(entry.state).toBe('enabled');
  });

  it('uninstall clears a ghost row', async () => {
    svc.setDiscovery('tool', []);
    await skillRepo.install('gone', 'web-app');
    await svc.uninstall('tool', 'gone', 'web-app');
    expect(await skillRepo.getRow('gone')).toBeNull();
  });

  it('uninstall rejects when there is no registry row to delete', async () => {
    // Finding #2: the routing bug (finding #1) sent bundle deletes to the tools table,
    // which matched zero rows — and the old signature had no way to notice. A delete
    // that removes nothing must fail loudly, naming the item, so the console never
    // reports success while the item is still there.
    svc.setDiscovery('tool', [disc('never-installed')]);
    await expect(svc.uninstall('tool', 'never-installed', 'web-app'))
      .rejects.toThrow(/never-installed/);
  });
});

// ── PR2 (#939): install/enable secrets gate ──────────────────────────────────

// Discovery helper that attaches install.requires_secrets to a skill's metadata.
const discWithSecrets = (name: string, requiresSecrets: string[]): Discovery => ({
  name,
  metadata: { name, description: `${name} desc`, version: '1.0.0', requiresSecrets },
});

describe('RegistryService secrets gate', () => {
  let skillRepo: FakeRepo;

  beforeEach(() => {
    skillRepo = new FakeRepo();
  });

  it('blocks install when a required secret is missing', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('tool', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await expect(svc.install('tool', 'web-search', 'web-app'))
      .rejects.toThrow(/tavily_api_key/);
    // Nothing was written — the gate runs before repo.install.
    expect(await skillRepo.getRow('web-search')).toBeNull();
  });

  it('lists every missing secret in the error', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets(['have']));
    svc.setDiscovery('tool', [discWithSecrets('s', ['have', 'missing_a', 'missing_b'])]);
    await expect(svc.install('tool', 's', 'web-app'))
      .rejects.toThrow(/missing_a, missing_b/);
  });

  it('allows install when all required secrets are present', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets(['tavily_api_key']));
    svc.setDiscovery('tool', [discWithSecrets('web-search', ['tavily_api_key'])]);
    const entry = await svc.install('tool', 'web-search', 'web-app');
    expect(entry.state).toBe('installed');
  });

  it('installAndEnable is gated the same way', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('tool', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await expect(svc.installAndEnable('tool', 'web-search', 'web-app'))
      .rejects.toThrow(/tavily_api_key/);
  });

  it('blocks enable when a required secret was removed after install', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('tool', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await skillRepo.install('web-search', 'web-app'); // row exists (installed directly)
    await expect(svc.enable('tool', 'web-search', 'web-app'))
      .rejects.toThrow(/tavily_api_key/);
  });

  it('leaves skills with no requires_secrets unaffected', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('tool', [disc('plain')]); // no requiresSecrets in metadata
    const entry = await svc.installAndEnable('tool', 'plain', 'web-app');
    expect(entry.state).toBe('enabled');
  });

  it('treats an empty requires_secrets array as no requirement', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('tool', [discWithSecrets('s', [])]);
    const entry = await svc.install('tool', 's', 'web-app');
    expect(entry.state).toBe('installed');
  });

  it('fails closed when a skill requires secrets but no vault is wired', async () => {
    // No SecretsLister passed — a skill that needs secrets must not slip through.
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], []);
    svc.setDiscovery('tool', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await expect(svc.install('tool', 'web-search', 'web-app'))
      .rejects.toThrow(/vault is unavailable/);
  });
});

describe('RegistryService.list — skill bundle metadata', () => {
  it('surfaces member tools and pin consumers for a bundle', async () => {
    const skillRepo = new FakeRepo();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo,
      [{
        name: 'ceo-inbox',
        metadata: {
          name: 'ceo-inbox',
          description: 'CEO inbox tools',
          version: '0.1.0',
          tools: ['ceo-inbox-list', 'ceo-inbox-read'],
          pinnedBy: ['ceo-inbox'],
        },
      }],
    );

    const entries = await svc.list('skill');
    const bundle = entries.find(e => e.name === 'ceo-inbox');

    expect(bundle?.metadata?.tools).toEqual(['ceo-inbox-list', 'ceo-inbox-read']);
    expect(bundle?.metadata?.pinnedBy).toEqual(['ceo-inbox']);
  });

  it('reports members for a bundle that is not installed', async () => {
    // The whole point: a disabled bundle is never in SkillRegistry, so membership
    // must come from on-disk discovery. An empty skillRepo = uninstalled.
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, new FakeRepo(),
      [{
        name: 'ceo-inbox',
        metadata: {
          name: 'ceo-inbox', description: 'd', version: '0.1.0',
          tools: ['ceo-inbox-list'], pinnedBy: [],
        },
      }],
    );

    const bundle = (await svc.list('skill')).find(e => e.name === 'ceo-inbox');
    expect(bundle?.state).toBe('uninstalled');
    expect(bundle?.metadata?.tools).toEqual(['ceo-inbox-list']);
  });
});

class FakeCascade implements IBundleCascadeRepo {
  enabled: Array<{ bundle: string; tools: string[] }> = [];
  disabled: Array<{ bundle: string; tools: string[] }> = [];
  async enableBundle(bundle: string, tools: string[]) { this.enabled.push({ bundle, tools }); }
  async disableBundle(bundle: string, tools: string[]) { this.disabled.push({ bundle, tools }); }
}

describe('RegistryService — bundle cascade', () => {
  const bundleDisc = [{
    name: 'ceo-inbox',
    metadata: {
      name: 'ceo-inbox', description: 'd', version: '0.1.0',
      tools: ['ceo-inbox-list', 'ceo-inbox-read'], pinnedBy: ['ceo-inbox'],
    },
  }];

  it('enable cascades the bundle and its member tools', async () => {
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc, cascade,
    );

    await svc.enable('skill', 'ceo-inbox', 'web-app');

    expect(cascade.enabled).toEqual([
      { bundle: 'ceo-inbox', tools: ['ceo-inbox-list', 'ceo-inbox-read'] },
    ]);
  });

  it('disable cascades the bundle and its member tools', async () => {
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc, cascade,
    );

    await svc.disable('skill', 'ceo-inbox', 'web-app');

    expect(cascade.disabled).toEqual([
      { bundle: 'ceo-inbox', tools: ['ceo-inbox-list', 'ceo-inbox-read'] },
    ]);
  });

  it('refuses a bundle enable when no cascade repo is wired', async () => {
    // Fail loudly rather than silently writing only skill_registry and leaving the
    // member tools untouched — a partial enable is the bug this feature exists to stop.
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc,
    );

    await expect(svc.enable('skill', 'ceo-inbox', 'web-app'))
      .rejects.toThrow(/cascade repo not configured/i);
  });

  it('leaves tool and agent enable on the single-table path', async () => {
    const toolRepo = new FakeRepo();
    await toolRepo.install('bullpen', 'test');
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      toolRepo, new FakeRepo(), [disc('bullpen')], [], undefined, new FakeRepo(), [], cascade,
    );

    await svc.enable('tool', 'bullpen', 'web-app');

    expect(cascade.enabled).toEqual([]);
    expect((await toolRepo.getRow('bullpen'))?.enabled).toBe(true);
  });

  it('installAndEnable cascades the bundle and its member tools without a separate install() call', async () => {
    // Starts from an empty skillRepo so this genuinely installs then enables —
    // this is the /api/registry/skills/:name/install-enable route an operator
    // actually uses to enrol a bundle for the first time (#1724).
    //
    // Finding #4: a separate repo.install() before the cascade would commit outside
    // the cascade's own transaction — if enableBundle() then failed, the bundle would
    // be left installed with zero member tools touched. Spy on skillRepo.install to
    // prove that never happens: the bundle must reach "enabled" through the cascade's
    // upsert alone.
    const skillRepo = new FakeRepo();
    let installCalls = 0;
    const originalInstall = skillRepo.install.bind(skillRepo);
    skillRepo.install = async (name: string, actor: string) => {
      installCalls++;
      return originalInstall(name, actor);
    };
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc, cascade,
    );

    await svc.installAndEnable('skill', 'ceo-inbox', 'web-app');

    expect(cascade.enabled).toEqual([
      { bundle: 'ceo-inbox', tools: ['ceo-inbox-list', 'ceo-inbox-read'] },
    ]);
    expect(installCalls).toBe(0);
  });

  it('refuses installAndEnable on a bundle when no cascade repo is wired', async () => {
    const skillRepo = new FakeRepo();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc,
    );

    await expect(svc.installAndEnable('skill', 'ceo-inbox', 'web-app'))
      .rejects.toThrow(/cascade repo not configured/i);
  });

  it('refuses a bundle disable when no cascade repo is wired', async () => {
    // Symmetry with the enable-side guard: cheap to assert, and its absence is what
    // would let a future refactor silently reintroduce the single-table fallback on
    // disable while enable stays guarded.
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc,
    );

    await expect(svc.disable('skill', 'ceo-inbox', 'web-app'))
      .rejects.toThrow(/cascade repo not configured/i);
  });
});
