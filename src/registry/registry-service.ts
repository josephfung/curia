// registry-service.ts — merges on-disk manifest discovery with registry rows to
// compute derived state, and exposes the install/enable/disable/uninstall lifecycle
// the /api/registry routes call. State changes touch the DB only; the live in-memory
// SkillRegistry/AgentRegistry are NOT mutated — enforcement is restart-based (spec §6).

import type {
  IRegistryRepo, RegistryKind, RegistryEntry, Discovery,
} from './types.js';

export class RegistryService {
  // Discovery is captured once at startup and held here. setDiscovery exists so the
  // bootstrap (and tests) can inject the lenient discovery results after construction.
  constructor(
    private readonly skillRepo: IRegistryRepo,
    private readonly agentRepo: IRegistryRepo,
    private skillDiscovery: Discovery[],
    private agentDiscovery: Discovery[],
  ) {}

  setDiscovery(kind: RegistryKind, discovery: Discovery[]): void {
    if (kind === 'skill') this.skillDiscovery = discovery;
    else this.agentDiscovery = discovery;
  }

  private repo(kind: RegistryKind): IRegistryRepo {
    return kind === 'skill' ? this.skillRepo : this.agentRepo;
  }

  private discovery(kind: RegistryKind): Discovery[] {
    return kind === 'skill' ? this.skillDiscovery : this.agentDiscovery;
  }

  /** Every known item (on disk and/or in DB) with its derived state. */
  async list(kind: RegistryKind): Promise<RegistryEntry[]> {
    const rows = await this.repo(kind).listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const discovery = this.discovery(kind);
    const discByName = new Map(discovery.map(d => [d.name, d]));

    const names = new Set<string>([...discByName.keys(), ...rowByName.keys()]);
    const entries: RegistryEntry[] = [];

    for (const name of names) {
      const disc = discByName.get(name);
      const row = rowByName.get(name);
      const onDisk = disc !== undefined;

      let state: RegistryEntry['state'];
      if (!onDisk) state = 'ghost';
      else if (!row) state = 'uninstalled';
      else state = row.enabled ? 'enabled' : 'installed';

      entries.push({
        name,
        kind,
        state,
        metadata: disc?.metadata ?? null,
        manifestError: disc?.error,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }

    // Stable alphabetical order for a predictable UI.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Look up a single derived entry (used to return the post-op state). */
  private async entry(kind: RegistryKind, name: string): Promise<RegistryEntry> {
    const all = await this.list(kind);
    const found = all.find(e => e.name === name);
    if (!found) throw new Error(`Registry entry '${name}' not found after operation`);
    return found;
  }

  /** Reject installing/enabling something that isn't a healthy on-disk manifest. */
  private assertInstallable(kind: RegistryKind, name: string): void {
    const disc = this.discovery(kind).find(d => d.name === name);
    if (!disc) {
      throw new Error(`Cannot install '${name}': not on disk (no manifest found).`);
    }
    if (disc.metadata === null) {
      throw new Error(`Cannot install '${name}': its manifest failed to parse (${disc.error ?? 'unknown error'}).`);
    }
  }

  async install(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.repo(kind).install(name, actor);
    return this.entry(kind, name);
  }

  async enable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new Error(`Cannot enable '${name}': not installed. Install it first.`);
    await this.repo(kind).enable(name, actor);
    return this.entry(kind, name);
  }

  async installAndEnable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.repo(kind).install(name, actor);
    await this.repo(kind).enable(name, actor);
    return this.entry(kind, name);
  }

  async disable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new Error(`Cannot disable '${name}': no registry row.`);
    await this.repo(kind).disable(name, actor);
    return this.entry(kind, name);
  }

  /** Uninstall is allowed even for ghosts — it's the only way to clear a ghost row. */
  async uninstall(kind: RegistryKind, name: string, _actor: string): Promise<void> {
    await this.repo(kind).uninstall(name);
  }
}
