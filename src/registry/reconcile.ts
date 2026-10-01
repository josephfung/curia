// reconcile.ts — startup enrollment of the trusted core set.
//
// Runs after migrations, before the load+register pass. For each core item named in
// config/registry-defaults.yaml that has NO registry row, it inserts an enabled row.
// It never touches an item that already has a row, so an admin who disables a core
// item stays disabled across restarts. Non-core items are left uninstalled.
//
// The core set lives in a trusted in-repo file — NOT in individual manifests — so an
// uploaded skill cannot self-enable on upload (spec §3, security rationale).

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import type { IRegistryRepo } from './types.js';
import type { Logger } from '../logger.js';

export interface RegistryDefaults {
  tools: string[];
  agents: string[];
  /** Skill (bundle) names — Phase 2. Optional for older defaults fixtures. */
  skills?: string[];
}

/**
 * Read config/registry-defaults.yaml. Throws when the file is missing, empty or the
 * wrong shape: a missing file would silently leave nothing enrolled on a fresh DB.
 * Shared by boot and the test-mode stack (#1966).
 */
export function loadRegistryDefaults(defaultsPath: string): RegistryDefaults {
  if (!fs.existsSync(defaultsPath)) {
    throw new Error(`${defaultsPath} not found — cannot enroll core defaults`);
  }
  const loaded: unknown = yaml.load(fs.readFileSync(defaultsPath, 'utf-8'));
  if (!loaded) {
    throw new Error(`${defaultsPath} is empty or null`);
  }
  const candidate = loaded as RegistryDefaults;
  if (!Array.isArray(candidate.tools) || !Array.isArray(candidate.agents)) {
    throw new Error(`${defaultsPath} has wrong shape (expected {tools: [], agents: []})`);
  }
  return candidate;
}

export interface ReconcileDeps {
  toolRepo: IRegistryRepo;
  agentRepo: IRegistryRepo;
  skillRepo?: IRegistryRepo;
  toolDiscoveryNames: Set<string>;
  agentDiscoveryNames: Set<string>;
  skillDiscoveryNames?: Set<string>;
  defaults: RegistryDefaults;
  logger: Logger;
}

export async function reconcileRegistries(deps: ReconcileDeps): Promise<void> {
  const {
    toolRepo, agentRepo, skillRepo,
    toolDiscoveryNames, agentDiscoveryNames, skillDiscoveryNames,
    defaults, logger,
  } = deps;
  await reconcileOne('tool', toolRepo, toolDiscoveryNames, defaults.tools, logger);
  await reconcileOne('agent', agentRepo, agentDiscoveryNames, defaults.agents, logger);
  if (skillRepo) {
    await reconcileOne(
      'skill',
      skillRepo,
      skillDiscoveryNames ?? new Set(),
      defaults.skills ?? [],
      logger,
    );
  }
}

async function reconcileOne(
  kind: 'tool' | 'agent' | 'skill',
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
    const enrolled = await repo.installAndEnable(name, 'reconciliation');
    if (enrolled) {
      logger.info({ kind, name }, 'registry: enrolled core default as enabled');
    } else {
      logger.info({ kind, name }, 'registry: core default already present on insert; left untouched');
    }
  }
}
