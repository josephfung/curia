import { describe, it, expect, vi } from 'vitest';
import { McpRegistryService } from './mcp-registry-service.js';
import { McpGuardError } from './mcp-registry-types.js';
import type { IMcpRegistryRepo, McpRegistryRow } from './mcp-registry-types.js';
import type { McpStdioServerEntry } from '../skills/mcp-config-types.js';

// Fake in-memory repo
function makeRepo(rows: McpRegistryRow[] = []): IMcpRegistryRepo {
  const store = new Map(rows.map(r => [r.name, r]));
  const now = '2026-06-21T00:00:00Z';
  return {
    listRows: async () => [...store.values()],
    getRow: async (name) => store.get(name) ?? null,
    install: async (name, actor) => {
      if (!store.has(name)) {
        const row: McpRegistryRow = { name, enabled: false, installedAt: now, installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: now };
        store.set(name, row);
        return row;
      }
      return store.get(name)!;
    },
    enable: async (name, actor) => {
      const row = store.get(name);
      if (!row) throw new Error(`no row for '${name}'`);
      const updated = { ...row, enabled: true, enabledAt: now, enabledBy: actor };
      store.set(name, updated);
      return updated;
    },
    disable: async (name) => {
      const row = store.get(name);
      if (!row) throw new Error(`no row for '${name}'`);
      const updated = { ...row, enabled: false, enabledAt: null, enabledBy: null };
      store.set(name, updated);
      return updated;
    },
    uninstall: async (name) => { store.delete(name); },
  };
}

const ATPROTO: McpStdioServerEntry = {
  name: 'atproto-mcp',
  transport: 'stdio',
  command: './cmd',
  action_risk: 'medium',
  secrets: [
    { key: 'atproto_identifier', label: 'Handle', required: true, secret: false, inject: { env: 'ATPROTO_IDENTIFIER' } },
    { key: 'atproto_password',   label: 'Password', required: true, secret: true, inject: { env: 'ATPROTO_PASSWORD' } },
  ],
};

const GOOGLE: McpStdioServerEntry = {
  name: 'google-workspace',
  transport: 'stdio',
  command: 'uvx',
  action_risk: 'low',
  secrets: [
    { key: 'google_oauth_client_id', label: 'Client ID', required: true, secret: false, inject: { env: 'GOOGLE_OAUTH_CLIENT_ID' } },
  ],
};

function makeSecrets(map: Record<string, string | null>) {
  return {
    get: async (key: string) => map[key] ?? null,
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('McpRegistryService', () => {
  it('list(): shows uninstalled state for servers with no registry row', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({}));
    const entries = await svc.list();
    expect(entries[0]!.state).toBe('uninstalled');
  });

  it('list(): shows installed state for servers with row but enabled=false', async () => {
    const now = '2026-06-21T00:00:00Z';
    const repo = makeRepo([{ name: 'atproto-mcp', enabled: false, installedAt: now, installedBy: 'test', enabledAt: null, enabledBy: null, updatedAt: now }]);
    const svc = new McpRegistryService(repo, [ATPROTO], makeSecrets({}));
    const entries = await svc.list();
    expect(entries[0]!.state).toBe('installed');
  });

  it('list(): secretFields shows configured=true when vault has value', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'secret' }));
    const entries = await svc.list();
    const field = entries[0]!.secretFields.find(f => f.key === 'atproto_identifier')!;
    expect(field.configured).toBe(true);
  });

  it('list(): requiredResolvable=false when a required secret is missing', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({}));
    const entries = await svc.list();
    expect(entries[0]!.requiredResolvable).toBe(false);
  });

  it('list(): requiredResolvable=true when all required secrets are present', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'secret' }));
    const entries = await svc.list();
    expect(entries[0]!.requiredResolvable).toBe(true);
  });

  it('install(): throws McpGuardError for unknown server name', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({}));
    await expect(svc.install('nonexistent', 'actor')).rejects.toBeInstanceOf(McpGuardError);
  });

  it('enable(): throws McpGuardError when not installed', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'secret' }));
    await expect(svc.enable('atproto-mcp', 'actor')).rejects.toBeInstanceOf(McpGuardError);
  });

  it('enable(): throws McpGuardError when required secret is missing', async () => {
    const repo = makeRepo();
    const svc = new McpRegistryService(repo, [ATPROTO], makeSecrets({}));
    await svc.install('atproto-mcp', 'actor');
    await expect(svc.enable('atproto-mcp', 'actor')).rejects.toBeInstanceOf(McpGuardError);
  });

  it('enable(): succeeds when all required secrets resolve', async () => {
    const repo = makeRepo();
    const svc = new McpRegistryService(repo, [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'pw' }));
    await svc.install('atproto-mcp', 'actor');
    const entry = await svc.enable('atproto-mcp', 'actor');
    expect(entry.state).toBe('enabled');
  });

  it('uninstall(): rejects and preserves secrets when server has no registry row', async () => {
    const secrets = makeSecrets({});
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], secrets);
    // Server exists in config but was never installed — no registry row
    await expect(svc.uninstall('atproto-mcp', 'actor')).rejects.toBeInstanceOf(McpGuardError);
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it('uninstall(): deletes exclusively-owned vault keys', async () => {
    const secrets = makeSecrets({});
    const repo = makeRepo();
    const svc = new McpRegistryService(repo, [ATPROTO], secrets);
    await svc.install('atproto-mcp', 'actor');
    await svc.uninstall('atproto-mcp', 'actor');
    expect(secrets.delete).toHaveBeenCalledWith('atproto_identifier');
    expect(secrets.delete).toHaveBeenCalledWith('atproto_password');
  });

  it('uninstall(): does not delete vault keys declared by local skills', async () => {
    const secrets = makeSecrets({});
    // ATPROTO declares atproto_identifier and atproto_password
    const svc = new McpRegistryService(
      makeRepo(),
      [ATPROTO],
      secrets,
      () => ['atproto_identifier'],  // local skill also declares this key
    );
    await svc.install('atproto-mcp', 'actor');
    await svc.uninstall('atproto-mcp', 'actor');
    // atproto_identifier is shared with a local skill → must NOT be deleted
    expect(secrets.delete).not.toHaveBeenCalledWith('atproto_identifier');
    // atproto_password is exclusively owned by this MCP server → may be deleted
    expect(secrets.delete).toHaveBeenCalledWith('atproto_password');
  });

  it('uninstall(): does not delete vault keys shared by another server', async () => {
    const SHARED: McpStdioServerEntry = {
      name: 'other-server', transport: 'stdio', command: './cmd', action_risk: 'low',
      secrets: [{ key: 'google_oauth_client_id', label: 'ID', required: true, secret: false, inject: { env: 'GID' } }],
    };
    const secrets = makeSecrets({});
    const svc = new McpRegistryService(makeRepo(), [GOOGLE, SHARED], secrets);
    await svc.install('google-workspace', 'actor');
    await svc.uninstall('google-workspace', 'actor');
    // google_oauth_client_id is also in SHARED → should NOT be deleted
    expect(secrets.delete).not.toHaveBeenCalledWith('google_oauth_client_id');
  });

  it('declaredSecretKeys(): returns union of all declared keys across servers', () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO, GOOGLE], makeSecrets({}));
    const keys = svc.declaredSecretKeys();
    expect(keys).toContain('atproto_identifier');
    expect(keys).toContain('atproto_password');
    expect(keys).toContain('google_oauth_client_id');
  });

  it('enabledServerNames(): returns only names of enabled servers', async () => {
    const now = '2026-06-21T00:00:00Z';
    const repo = makeRepo([
      { name: 'atproto-mcp', enabled: true, installedAt: now, installedBy: 'test', enabledAt: now, enabledBy: 'test', updatedAt: now },
      { name: 'google-workspace', enabled: false, installedAt: now, installedBy: 'test', enabledAt: null, enabledBy: null, updatedAt: now },
    ]);
    const svc = new McpRegistryService(repo, [ATPROTO, GOOGLE], makeSecrets({}));
    const names = await svc.enabledServerNames();
    expect(names.has('atproto-mcp')).toBe(true);
    expect(names.has('google-workspace')).toBe(false);
  });
});
