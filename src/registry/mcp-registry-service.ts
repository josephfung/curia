// src/registry/mcp-registry-service.ts
// Drives the MCP server install/enable lifecycle, mirroring ChannelRegistryService.
// All MCP servers are toggleable; there is no non-toggleable equivalent.
import { normalizeSecretValue } from '../channels/credential-resolver.js';
import type { Logger } from '../logger.js';
import type { McpServerEntry } from '../skills/mcp-config-types.js';
import {
  McpGuardError,
  type McpRegistryEntry,
  type McpSecretFieldStatus,
  type IMcpRegistryRepo,
} from './mcp-registry-types.js';

type SecretStore = {
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
};

export class McpRegistryService {
  constructor(
    private readonly repo: IMcpRegistryRepo,
    private readonly servers: McpServerEntry[],
    private readonly secrets: SecretStore,
    /** Optional: returns the flat vault key names declared by local skills. Used during
     *  uninstall to avoid deleting keys still needed by skills (flat keys are shared). */
    private readonly getSkillDeclaredKeys: () => string[] = () => [],
    private readonly logger?: Logger,
  ) {}

  private descriptor(name: string): McpServerEntry {
    const d = this.servers.find(s => s.name === name);
    if (!d) throw new McpGuardError(`Unknown MCP server '${name}'.`);
    return d;
  }

  private async secretStatus(server: McpServerEntry): Promise<{ fields: McpSecretFieldStatus[]; requiredResolvable: boolean }> {
    const decls = server.transport === 'stdio' ? (server.secrets ?? []) : [];
    const fields: McpSecretFieldStatus[] = [];
    let requiredResolvable = true;

    for (const decl of decls) {
      let configured = false;
      try {
        const raw = await this.secrets.get(decl.key);
        configured = !!normalizeSecretValue(raw);
      } catch (err) {
        // Vault read failure: treat as unconfigured so list/enable don't crash,
        // but log at error so operators can distinguish "not set" from "vault broken".
        this.logger?.error({ err, key: decl.key }, 'vault read failed in secretStatus — treating as unconfigured');
        configured = false;
      }
      if (decl.required && !configured) requiredResolvable = false;
      fields.push({ key: decl.key, label: decl.label, secret: decl.secret, configured });
    }

    return { fields, requiredResolvable };
  }

  async list(): Promise<McpRegistryEntry[]> {
    const rows = await this.repo.listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const entries: McpRegistryEntry[] = [];

    for (const server of this.servers) {
      const row = rowByName.get(server.name);
      const { fields, requiredResolvable } = await this.secretStatus(server);
      entries.push({
        name: server.name,
        state: !row ? 'uninstalled' : row.enabled ? 'enabled' : 'installed',
        secretFields: fields,
        requiredResolvable,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async install(name: string, actor: string): Promise<McpRegistryEntry> {
    this.descriptor(name); // throws McpGuardError if unknown
    await this.repo.install(name, actor);
    return this.entry(name);
  }

  async enable(name: string, actor: string): Promise<McpRegistryEntry> {
    const server = this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new McpGuardError(`Cannot enable '${name}': not installed. Install it first.`);
    const { requiredResolvable } = await this.secretStatus(server);
    if (!requiredResolvable) {
      throw new McpGuardError(`Cannot enable '${name}': required credentials are not configured.`);
    }
    await this.repo.enable(name, actor);
    return this.entry(name);
  }

  async disable(name: string, actor: string): Promise<McpRegistryEntry> {
    this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new McpGuardError(`Cannot disable '${name}': no registry row.`);
    await this.repo.disable(name, actor);
    return this.entry(name);
  }

  async uninstall(name: string, _actor: string): Promise<void> {
    const server = this.descriptor(name);
    // Delete only vault keys exclusively owned by this server — flat keys may be
    // shared by other servers or local skills, and deleting them would break those.
    const ownKeys = new Set(
      server.transport === 'stdio' ? (server.secrets ?? []).map(d => d.key) : [],
    );
    // Remove keys shared with other MCP servers.
    for (const other of this.servers) {
      if (other.name === name) continue;
      for (const d of other.transport === 'stdio' ? (other.secrets ?? []) : []) {
        ownKeys.delete(d.key);
      }
    }
    // Remove keys also declared by local skills — flat keys are shared across
    // the platform; deleting them here would silently break skill invocations.
    for (const key of this.getSkillDeclaredKeys()) {
      ownKeys.delete(key);
    }
    for (const key of ownKeys) {
      await this.secrets.delete(key);
    }
    await this.repo.uninstall(name);
  }

  /** All vault keys declared across all configured servers. Used by vault.ts allowlist. */
  declaredSecretKeys(): string[] {
    const keys = new Set<string>();
    for (const server of this.servers) {
      for (const d of server.transport === 'stdio' ? (server.secrets ?? []) : []) {
        keys.add(d.key);
      }
    }
    return [...keys];
  }

  /** Names of currently enabled servers. Used by loadMcpServers to filter at boot. */
  async enabledServerNames(): Promise<Set<string>> {
    const rows = await this.repo.listRows();
    return new Set(rows.filter(r => r.enabled).map(r => r.name));
  }

  private async entry(name: string): Promise<McpRegistryEntry> {
    const server = this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new Error(`entry: '${name}' missing registry row after mutation`);
    const { fields, requiredResolvable } = await this.secretStatus(server);
    return {
      name: server.name,
      state: row.enabled ? 'enabled' : 'installed',
      secretFields: fields,
      requiredResolvable,
      installedAt: row.installedAt,
      installedBy: row.installedBy,
      enabledAt: row.enabledAt,
      enabledBy: row.enabledBy,
    };
  }
}
