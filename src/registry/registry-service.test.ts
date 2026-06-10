import { describe, it, expect, beforeEach } from 'vitest';
import { RegistryService } from './registry-service.js';
import type { IRegistryRepo, RegistryRow, Discovery, SecretsLister } from './types.js';

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
  async uninstall(name: string) { this.rows.delete(name); }
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
    svc.setDiscovery('skill', [disc('a')]);
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('uninstalled');
  });

  it('row + disabled → installed', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    await skillRepo.install('a', 'web-app');
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('installed');
  });

  it('row + enabled → enabled', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    await skillRepo.install('a', 'web-app');
    await skillRepo.enable('a', 'web-app');
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('enabled');
  });

  it('row + no files → ghost (metadata null)', async () => {
    svc.setDiscovery('skill', []);
    await skillRepo.install('gone', 'web-app');
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('ghost');
    expect(entry!.metadata).toBeNull();
  });

  it('bad manifest → entry carries manifestError', async () => {
    svc.setDiscovery('skill', [{ name: 'b', metadata: null, error: 'bad json' }]);
    const [entry] = await svc.list('skill');
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
    svc.setDiscovery('skill', []);
    await expect(svc.install('skill', 'ghost', 'web-app')).rejects.toThrow(/not on disk/);
  });

  it('install rejects an item with a manifest error', async () => {
    svc.setDiscovery('skill', [{ name: 'b', metadata: null, error: 'bad json' }]);
    await expect(svc.install('skill', 'b', 'web-app')).rejects.toThrow(/manifest/i);
  });

  it('enable requires an installed row', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    await expect(svc.enable('skill', 'a', 'web-app')).rejects.toThrow(/not installed/);
  });

  it('installAndEnable installs then enables', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    const entry = await svc.installAndEnable('skill', 'a', 'web-app');
    expect(entry.state).toBe('enabled');
  });

  it('uninstall clears a ghost row', async () => {
    svc.setDiscovery('skill', []);
    await skillRepo.install('gone', 'web-app');
    await svc.uninstall('skill', 'gone', 'web-app');
    expect(await skillRepo.getRow('gone')).toBeNull();
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
    svc.setDiscovery('skill', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await expect(svc.install('skill', 'web-search', 'web-app'))
      .rejects.toThrow(/tavily_api_key/);
    // Nothing was written — the gate runs before repo.install.
    expect(await skillRepo.getRow('web-search')).toBeNull();
  });

  it('lists every missing secret in the error', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets(['have']));
    svc.setDiscovery('skill', [discWithSecrets('s', ['have', 'missing_a', 'missing_b'])]);
    await expect(svc.install('skill', 's', 'web-app'))
      .rejects.toThrow(/missing_a, missing_b/);
  });

  it('allows install when all required secrets are present', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets(['tavily_api_key']));
    svc.setDiscovery('skill', [discWithSecrets('web-search', ['tavily_api_key'])]);
    const entry = await svc.install('skill', 'web-search', 'web-app');
    expect(entry.state).toBe('installed');
  });

  it('installAndEnable is gated the same way', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('skill', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await expect(svc.installAndEnable('skill', 'web-search', 'web-app'))
      .rejects.toThrow(/tavily_api_key/);
  });

  it('blocks enable when a required secret was removed after install', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('skill', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await skillRepo.install('web-search', 'web-app'); // row exists (installed directly)
    await expect(svc.enable('skill', 'web-search', 'web-app'))
      .rejects.toThrow(/tavily_api_key/);
  });

  it('leaves skills with no requires_secrets unaffected', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('skill', [disc('plain')]); // no requiresSecrets in metadata
    const entry = await svc.installAndEnable('skill', 'plain', 'web-app');
    expect(entry.state).toBe('enabled');
  });

  it('treats an empty requires_secrets array as no requirement', async () => {
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], [], new FakeSecrets([]));
    svc.setDiscovery('skill', [discWithSecrets('s', [])]);
    const entry = await svc.install('skill', 's', 'web-app');
    expect(entry.state).toBe('installed');
  });

  it('fails closed when a skill requires secrets but no vault is wired', async () => {
    // No SecretsLister passed — a skill that needs secrets must not slip through.
    const svc = new RegistryService(skillRepo, new FakeRepo(), [], []);
    svc.setDiscovery('skill', [discWithSecrets('web-search', ['tavily_api_key'])]);
    await expect(svc.install('skill', 'web-search', 'web-app'))
      .rejects.toThrow(/vault is unavailable/);
  });
});
