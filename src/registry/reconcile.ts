// reconcile.ts — startup enrollment of the trusted core set.
//
// Runs after migrations, before the load+register pass. For each core item named in
// config/registry-defaults.yaml that has NO registry row, it inserts an enabled row.
// It never touches an item that already has a row, so an admin who disables a core
// skill stays disabled across restarts. Non-core items are left uninstalled.
//
// The core set lives in a trusted in-repo file — NOT in individual manifests — so an
// uploaded skill cannot self-enable on upload (spec §3, security rationale).

import type { IRegistryRepo } from './types.js';
import type { Logger } from '../logger.js';

export interface RegistryDefaults {
  skills: string[];
  agents: string[];
}

export interface ReconcileDeps {
  skillRepo: IRegistryRepo;
  agentRepo: IRegistryRepo;
  skillDiscoveryNames: Set<string>;
  agentDiscoveryNames: Set<string>;
  defaults: RegistryDefaults;
  logger: Logger;
}

export async function reconcileRegistries(deps: ReconcileDeps): Promise<void> {
  const { skillRepo, agentRepo, skillDiscoveryNames, agentDiscoveryNames, defaults, logger } = deps;
  await reconcileOne('skill', skillRepo, skillDiscoveryNames, defaults.skills, logger);
  await reconcileOne('agent', agentRepo, agentDiscoveryNames, defaults.agents, logger);
}

async function reconcileOne(
  kind: 'skill' | 'agent',
  repo: IRegistryRepo,
  discoveryNames: Set<string>,
  coreNames: string[],
  logger: Logger,
): Promise<void> {
  const existing = new Set((await repo.listRows()).map(r => r.name));

  for (const name of coreNames) {
    if (existing.has(name)) continue; // respect any existing admin state
    if (!discoveryNames.has(name)) {
      logger.warn({ kind, name }, 'registry: core default not found on disk; skipping enrollment');
      continue;
    }
    await repo.install(name, 'reconciliation');
    await repo.enable(name, 'reconciliation');
    logger.info({ kind, name }, 'registry: enrolled core default as enabled');
  }
}
