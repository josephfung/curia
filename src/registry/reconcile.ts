// reconcile.ts — startup enrollment of the trusted core set.
//
// Runs after migrations, before the load+register pass. For each core item named in
// config/registry-defaults.yaml that has NO registry row, it inserts an enabled row.
// It never touches an item that already has a row, so an admin who disables a core
// item stays disabled across restarts. Non-core items are left uninstalled.
//
// The core set lives in a trusted in-repo file — NOT in individual manifests — so an
// uploaded skill cannot self-enable on upload (spec §3, security rationale).
//
// Bundle expansion (#1974): an enabled skill bundle owns its member tools. A bundle's
// membership is declared once, in its SKILL.md `tools:` list, and reconciliation enrolls
// every member that has no tool_registry row. Before this, membership also had to be
// repeated under registry-defaults.yaml `tools:`, and a member added to SKILL.md but not
// to that list (doc-place, setup-status, ...) never got a row and never loaded.
//
// Every tool enrollment passes the gates the tool itself declares (ToolGate below). A
// tool held back by a gate gets NO row, so a later boot enrolls it once the gate clears.

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import type { IRegistryRepo, SecretsLister } from './types.js';
import type { Logger } from '../logger.js';

export interface RegistryDefaults {
  /** Standalone tools only. Members of a bundle enroll through the bundle (see header). */
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

/** Bundle discovery as reconcile sees it: member tools, or `null` when the SKILL.md
 *  failed to parse (its members can't be known, so none are expanded). */
export type BundleMembers = ReadonlyMap<string, readonly string[] | null>;

export function bundleMembersFromDiscovery(
  discovery: ReadonlyArray<{ name: string; metadata: { tools: string[] } | null }>,
): Map<string, string[] | null> {
  return new Map(discovery.map(d => [d.name, d.metadata ? d.metadata.tools : null]));
}

/** What a tool's manifest declares that bears on whether it may be enrolled. */
export interface ToolGateInfo {
  /** install.requires_secrets — vault keys that must all exist. */
  requiresSecrets: readonly string[];
  /** Declared capabilities — checked against ReconcileDeps.unavailableCapabilities. */
  capabilities: readonly string[];
}

/** Every on-disk tool → its gate info, or `null` when its manifest failed to parse. */
export type ToolManifests = ReadonlyMap<string, ToolGateInfo | null>;

export function toolManifestsFromDiscovery(
  discovery: ReadonlyArray<{
    name: string;
    metadata: { requiresSecrets?: string[]; capabilities?: string[] } | null;
  }>,
): Map<string, ToolGateInfo | null> {
  return new Map(discovery.map(d => [
    d.name,
    d.metadata
      ? { requiresSecrets: d.metadata.requiresSecrets ?? [], capabilities: d.metadata.capabilities ?? [] }
      : null,
  ]));
}

export interface ReconcileDeps {
  toolRepo: IRegistryRepo;
  agentRepo: IRegistryRepo;
  skillRepo?: IRegistryRepo;
  /** Every tool on disk — see toolManifestsFromDiscovery(). Carries each tool's gates, so
   *  a caller can't enroll gated tools ungated by forgetting a separate argument. */
  toolManifests: ToolManifests;
  agentDiscoveryNames: Set<string>;
  skillDiscoveryNames?: Set<string>;
  /** Member tools of each on-disk bundle — see bundleMembersFromDiscovery(). */
  bundleMembers: BundleMembers;
  /** Vault key lister for the requires_secrets gate. `undefined` means no vault: every
   *  tool that declares secrets is held back (fail closed), never enrolled unverified. */
  secrets: SecretsLister | undefined;
  /** Capabilities whose backing service this boot did NOT build because its integration
   *  isn't configured (e.g. nylasCalendarClient without a Nylas key + principal grant).
   *  A tool declaring one is held back: it would only fail closed at call time while
   *  sitting in agents' tool lists. Only list integration-optional services here. */
  unavailableCapabilities: ReadonlySet<string>;
  defaults: RegistryDefaults;
  logger: Logger;
}

/**
 * Decides whether a tool may be enrolled, from what its own manifest declares:
 *
 * - An unparsable manifest is refused. RegistryService.assertInstallable refuses it too,
 *   and an enabled row for it would make loadToolsFromDirectory fail every boot.
 * - install.requires_secrets must all be in the vault — the same check an admin enable
 *   runs (RegistryService.assertSecretsConfigured). Vault keys only: env vars and user.*
 *   keys are not consulted, matching the admin path.
 * - No declared capability may be in unavailableCapabilities.
 *
 * Each tool is judged once per pass, so a tool in two bundles logs once.
 */
class ToolGate {
  private configured: Promise<Set<string>> | undefined;
  private readonly verdicts = new Map<string, Promise<boolean>>();

  constructor(
    private readonly manifests: ToolManifests,
    private readonly secrets: SecretsLister | undefined,
    private readonly unavailableCapabilities: ReadonlySet<string>,
    private readonly logger: Logger,
  ) {}

  allows(tool: string, via: string): Promise<boolean> {
    let verdict = this.verdicts.get(tool);
    if (!verdict) {
      verdict = this.judge(tool, via);
      this.verdicts.set(tool, verdict);
    }
    return verdict;
  }

  private async judge(tool: string, via: string): Promise<boolean> {
    const info = this.manifests.get(tool);
    if (info === null || info === undefined) {
      // error, not warn: a broken manifest is a bug someone has to fix, and until then the
      // tool is silently absent from every agent that pins it.
      this.logger.error(
        { tool, via },
        'registry: tool manifest is missing or failed to parse; not enrolled (fix tool.json — the next boot enrolls it)',
      );
      return false;
    }

    const unavailable = info.capabilities.filter(c => this.unavailableCapabilities.has(c));
    if (unavailable.length > 0) {
      // info, not warn: an unconfigured optional integration is a normal state, and pin
      // resolution already warns per agent when a pinned tool isn't loaded.
      this.logger.info(
        { tool, via, unavailableCapabilities: unavailable },
        'registry: tool not enrolled until its integration is configured',
      );
      return false;
    }

    if (info.requiresSecrets.length === 0) return true;
    if (!this.secrets) {
      this.logger.warn(
        { tool, via, requiredVaultKeys: info.requiresSecrets },
        'registry: tool requires vault secrets but no vault is available; not enrolled',
      );
      return false;
    }
    // Listed lazily, once per pass, only if some candidate declares secrets. A vault read
    // failure propagates: boot treats reconciliation failure as fatal, and guessing either
    // way would be worse (enroll unverified, or silently drop).
    this.configured ??= this.secrets.list().then(names => new Set(names));
    const configured = await this.configured;
    const missing = info.requiresSecrets.filter(s => !configured.has(s));
    if (missing.length > 0) {
      this.logger.info(
        { tool, via, missingVaultKeys: missing },
        'registry: tool not enrolled until its required vault key(s) are set (env vars and user.* keys are not consulted)',
      );
      return false;
    }
    return true;
  }
}

export async function reconcileRegistries(deps: ReconcileDeps): Promise<void> {
  const {
    toolRepo, agentRepo, skillRepo,
    toolManifests, agentDiscoveryNames, skillDiscoveryNames,
    bundleMembers, secrets, unavailableCapabilities,
    defaults, logger,
  } = deps;
  const gate = new ToolGate(toolManifests, secrets, unavailableCapabilities, logger);
  const toolDiscoveryNames = new Set(toolManifests.keys());

  await reconcileOne('tool', toolRepo, toolDiscoveryNames, defaults.tools, logger, gate);
  await reconcileOne('agent', agentRepo, agentDiscoveryNames, defaults.agents, logger);
  if (skillRepo) {
    await reconcileOne(
      'skill',
      skillRepo,
      skillDiscoveryNames ?? new Set(),
      defaults.skills ?? [],
      logger,
    );
    // After the skill pass, so bundles enrolled just now are expanded on this same boot.
    await expandEnabledBundles(skillRepo, toolRepo, toolDiscoveryNames, bundleMembers, logger, gate);
  } else if (bundleMembers.size > 0) {
    logger.warn('registry: no skill_registry repo wired; bundle member tools were not expanded');
  }
}

async function reconcileOne(
  kind: 'tool' | 'agent' | 'skill',
  repo: IRegistryRepo,
  discoveryNames: Set<string>,
  coreNames: string[],
  logger: Logger,
  gate?: ToolGate,
): Promise<void> {
  const existing = new Set((await repo.listRows()).map(r => r.name));

  for (const name of coreNames) {
    if (existing.has(name)) continue; // respect any existing admin state
    if (!discoveryNames.has(name)) {
      logger.warn({ kind, name }, 'registry: core default not found on disk; skipping enrollment');
      continue;
    }
    if (gate && !(await gate.allows(name, 'registry-defaults'))) continue;
    const enrolled = await repo.installAndEnable(name, 'reconciliation');
    if (enrolled) {
      logger.info({ kind, name }, 'registry: enrolled core default as enabled');
    } else {
      logger.info({ kind, name }, 'registry: core default already present on insert; left untouched');
    }
  }
}

/**
 * Enroll every member tool of every ENABLED bundle that has no tool_registry row.
 *
 * Every enabled bundle, not just the ones in registry-defaults.yaml: enabling a bundle
 * already means "enable its members" (the #1724 cascade), so a member added to the
 * SKILL.md of an admin-enabled bundle later deserves the same treatment as one added to
 * a default bundle. A bundle an admin DISABLED is skipped — its new members stay off,
 * matching the admin's choice for the bundle as a whole.
 *
 * Existing rows are never touched, so an admin who disabled one member keeps it disabled.
 * Uninstalling (deleting the row of) a member of an enabled bundle would be undone here,
 * which is why RegistryService.uninstall refuses that and points at disable.
 */
async function expandEnabledBundles(
  skillRepo: IRegistryRepo,
  toolRepo: IRegistryRepo,
  toolDiscoveryNames: Set<string>,
  bundleMembers: BundleMembers,
  logger: Logger,
  gate: ToolGate,
): Promise<void> {
  const enabledBundles = (await skillRepo.listRows()).filter(r => r.enabled).map(r => r.name);
  // Re-read: the tools: pass above may have just inserted rows.
  const existing = new Set((await toolRepo.listRows()).map(r => r.name));

  for (const bundle of enabledBundles) {
    const members = bundleMembers.get(bundle);
    if (!members) {
      // undefined = no SKILL.md on disk (ghost); null = SKILL.md failed to parse. Either
      // way the member list is unknown, so nothing can be expanded safely.
      logger.warn(
        { bundle, reason: members === null ? 'SKILL.md failed to parse' : 'no SKILL.md on disk' },
        'registry: enabled bundle has no readable member list; member tools not expanded',
      );
      continue;
    }

    for (const tool of members) {
      if (existing.has(tool)) continue; // respect any existing admin state
      if (!toolDiscoveryNames.has(tool)) {
        logger.warn(
          { bundle, tool },
          'registry: bundle member tool not found on disk; skipping enrollment',
        );
        continue;
      }
      if (!(await gate.allows(tool, `bundle:${bundle}`))) continue;
      const enrolled = await toolRepo.installAndEnable(tool, 'reconciliation');
      // Mark it seen either way so a second bundle listing the same tool doesn't retry.
      existing.add(tool);
      if (enrolled) {
        logger.info({ bundle, tool }, 'registry: enrolled bundle member tool as enabled');
      } else {
        logger.info({ bundle, tool }, 'registry: bundle member already present on insert; left untouched');
      }
    }
  }
}
