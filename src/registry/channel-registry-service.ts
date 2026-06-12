// src/registry/channel-registry-service.ts
// Drives the channel install/enable lifecycle. Channels are code-defined (CHANNEL_CATALOG),
// so there is no on-disk discovery and no 'ghost' state. enable() is gated on the channel's
// required credentials resolving (vault/env/config); disable()/uninstall() are blocked for
// non-toggleable channels (http, cli).
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { ChannelCredentialStatus } from '../channels/credential-resolver.js';
import {
  ChannelGuardError,
  type ChannelRegistryEntry,
  type IChannelRegistryRepo,
} from './channel-registry-types.js';

/** Resolves the live credential status for a descriptor (vault/env/config). Injected so the
 *  service stays decoupled from the vault + config wiring and is trivially fakeable in tests. */
export type CredentialStatusFn = (descriptor: ChannelDescriptor) => Promise<ChannelCredentialStatus>;

export class ChannelRegistryService {
  constructor(
    private readonly repo: IChannelRegistryRepo,
    private readonly catalog: ChannelDescriptor[],
    private readonly credentialStatus: CredentialStatusFn,
    /** Used by uninstall() to clear the channel's vault keys. Optional in tests. */
    private readonly secrets?: { delete(name: string): Promise<void> },
  ) {}

  private descriptor(name: string): ChannelDescriptor {
    const d = this.catalog.find(c => c.name === name);
    if (!d) throw new ChannelGuardError(`Unknown channel '${name}'.`);
    return d;
  }

  async list(): Promise<ChannelRegistryEntry[]> {
    const rows = await this.repo.listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const entries: ChannelRegistryEntry[] = [];

    for (const d of this.catalog) {
      const row = rowByName.get(d.name);
      const status = await this.credentialStatus(d);
      const state = !row ? 'uninstalled' : row.enabled ? 'enabled' : 'installed';
      entries.push({
        name: d.name,
        description: d.description,
        state,
        isToggleable: d.isToggleable,
        credentialFields: status.fields,
        requiredResolvable: status.requiredResolvable,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async install(name: string, actor: string): Promise<ChannelRegistryEntry> {
    const d = this.descriptor(name);
    await this.repo.install(name, actor, d.isToggleable);
    return this.entry(name);
  }

  async enable(name: string, actor: string): Promise<ChannelRegistryEntry> {
    const d = this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new ChannelGuardError(`Cannot enable '${name}': not installed. Install it first.`);
    const status = await this.credentialStatus(d);
    if (!status.requiredResolvable) {
      throw new ChannelGuardError(`Cannot enable '${name}': required credentials are not configured.`);
    }
    await this.repo.enable(name, actor);
    return this.entry(name);
  }

  async disable(name: string, actor: string): Promise<ChannelRegistryEntry> {
    const d = this.descriptor(name);
    if (!d.isToggleable) throw new ChannelGuardError(`Channel '${name}' cannot be disabled.`);
    const row = await this.repo.getRow(name);
    if (!row) throw new ChannelGuardError(`Cannot disable '${name}': no registry row.`);
    await this.repo.disable(name, actor);
    return this.entry(name);
  }

  async uninstall(name: string, _actor: string): Promise<void> {
    const d = this.descriptor(name);
    if (!d.isToggleable) throw new ChannelGuardError(`Channel '${name}' cannot be uninstalled.`);
    // Clear the channel's vault keys (best-effort; delete is a no-op if the key is absent).
    if (this.secrets) {
      for (const field of d.credentialFields) {
        await this.secrets.delete(`channel.${name}.${field.key}`);
      }
    }
    await this.repo.uninstall(name);
  }

  private async entry(name: string): Promise<ChannelRegistryEntry> {
    const entries = await this.list();
    const found = entries.find(e => e.name === name);
    if (!found) throw new Error(`entry: '${name}' not in catalog after mutation`);
    return found;
  }
}
