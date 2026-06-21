// src/registry/mcp-registry-types.ts
// Types for the MCP server registry. Mirrors channel-registry-types.ts.
// All MCP servers are toggleable — there is no is_toggleable column.

export type McpDerivedState = 'uninstalled' | 'installed' | 'enabled';

/** Per-secret status returned to the console. Mirrors CredentialFieldStatus. */
export interface McpSecretFieldStatus {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
}

/** A row in mcp_server_registry, mapped to camelCase. */
export interface McpRegistryRow {
  name: string;
  enabled: boolean;
  installedAt: string;
  installedBy: string;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

/** Fully-resolved API entry: config × row × credential status → state. */
export interface McpRegistryEntry {
  name: string;
  state: McpDerivedState;
  secretFields: McpSecretFieldStatus[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** Thrown for expected guard rejections. Routes catch this to return HTTP 400. */
export class McpGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpGuardError';
  }
}

/** DB-access contract. Postgres impl is McpRegistryRepo; tests use an in-memory fake. */
export interface IMcpRegistryRepo {
  listRows(): Promise<McpRegistryRow[]>;
  getRow(name: string): Promise<McpRegistryRow | null>;
  install(name: string, actor: string): Promise<McpRegistryRow>;
  enable(name: string, actor: string): Promise<McpRegistryRow>;
  disable(name: string, actor: string): Promise<McpRegistryRow>;
  uninstall(name: string): Promise<void>;
}
