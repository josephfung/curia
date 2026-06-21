// src/registry/mcp-reconcile.ts
// Boot-time reconciliation for the MCP server registry. Mirrors channel-reconcile.ts.
// Auto-installs every configured server; auto-enables those whose required secrets resolve.
// Existing admin state is never overwritten — if an operator disabled a server, it stays
// disabled after a restart.
import type { Logger } from '../logger.js';
import type { McpServerEntry } from '../skills/mcp-config-types.js';
import type { McpRegistryService } from './mcp-registry-service.js';
import { McpGuardError } from './mcp-registry-types.js';

export interface ReconcileMcpDeps {
  service: McpRegistryService;
  servers: McpServerEntry[];
  logger: Logger;
}

export async function reconcileMcpRegistry(deps: ReconcileMcpDeps): Promise<void> {
  const { service, servers, logger } = deps;
  const existing = new Map(
    (await service.list()).map(e => [e.name, e]),
  );

  for (const server of servers) {
    const entry = existing.get(server.name);

    // If already in the registry (any state), leave admin state alone.
    if (entry && entry.state !== 'uninstalled') continue;

    // First time seeing this server: install it.
    await service.install(server.name, 'reconciliation');
    logger.info({ server: server.name }, 'mcp registry: enrolled new server');

    // Attempt to auto-enable if all required secrets already resolve.
    try {
      await service.enable(server.name, 'reconciliation');
      logger.info({ server: server.name }, 'mcp registry: auto-enabled server with resolvable credentials');
    } catch (err) {
      if (err instanceof McpGuardError) {
        // Required credentials not yet configured — stays installed but not enabled.
        logger.info({ server: server.name }, 'mcp registry: server installed but not auto-enabled (credentials not yet configured)');
      } else {
        throw err;
      }
    }
  }
}
