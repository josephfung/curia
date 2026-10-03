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
// Declared gates still apply: a tool whose manifest declares install.requires_secrets is
// only enrolled once every one of those keys exists in the vault — the same check an
// admin enable runs (RegistryService.assertSecretsConfigured). A gated tool that is
// skipped gets NO row, so a later boot enrolls it once its credentials are configured.

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

/** Bundle name → member tool names, from on-disk SKILL.md discovery. A bundle whose
 *  SKILL.md failed to parse is absent: its members can't be known, so none are expanded. */
export function bundleMembersFromDiscovery(
  discovery: ReadonlyArray<{ name: string; metadata: { tools: string[] } | null }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of discovery) {
    if (d.metadata) out.set(d.name, d.metadata.tools);
  }
  return out;
}

/** Tool name → its declared install.requires_secrets, from on-disk tool discovery.
 *  Tools that declare none are absent. A tool whose manifest failed to parse is absent
 *  too, and so contributes no gate: an enabled tool with an unparsable manifest fails
 *  boot at load time (loadToolsFromDirectory), so it can never go live without its
 *  credential — the same reasoning as RegistryService.assertBundleSecretsConfigured. */
export function requiredSecretsFromDiscovery(
  discovery: ReadonlyArray<{ name: string; metadata: { requiresSecrets?: string[] } | null }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of discovery) {
    const required = d.metadata?.requiresSecrets ?? [];
    if (required.length > 0) out.set(d.name, required);
  }
  return out;
}

export interface ReconcileDeps {
  toolRepo: IRegistryRepo;
  agentRepo: IRegistryRepo;
  skillRepo?: IRegistryRepo;
  toolDiscoveryNames: Set<string>;
  agentDiscoveryNames: Set<string>;
  skillDiscoveryNames?: Set<string>;
  /** Member tools of each on-disk bundle — see bundleMembersFromDiscovery(). Required so a
   *  caller can't silently skip bundle expansion by forgetting to pass it. */
  bundleMembers: ReadonlyMap<string, readonly string[]>;
  /** Declared install.requires_secrets per tool — see requiredSecretsFromDiscovery().
   *  Required for the same reason: omitting it would enroll gated tools ungated. */
  toolRequiredSecrets: ReadonlyMap<string, readonly string[]>;
  /** Vault key lister for the requires_secrets gate. `undefined` means no vault: every
   *  gated tool is skipped (fail closed), never enrolled unverified. */
  secrets: SecretsLister | undefined;
  defaults: RegistryDefaults;
  logger: Logger;
}

/** Lazily lists vault keys once per reconcile pass, and only if some candidate tool
 *  actually declares a requirement — most boots never need the round-trip. */
class SecretsGate {
  private configured: Promise<Set<string>> | undefined;

  constructor(
    private readonly required: ReadonlyMap<string, readonly string[]>,
    private readonly secrets: SecretsLister | undefined,
    private readonly logger: Logger,
  ) {}

  /** True when `tool` may be enrolled: it declares no secrets, or all of them are configured. */
  async allows(tool: string, via: string): Promise<boolean> {
    const required = this.required.get(tool) ?? [];
    if (required.length === 0) return true;

    if (!this.secrets) {
      this.logger.warn(
        { tool, via, requiredSecrets: required },
        'registry: tool requires secrets but no vault is available; not enrolled',
      );
      return false;
    }
    // A vault read failure propagates: boot treats reconciliation failure as fatal, and
    // guessing either way here would be worse (enroll unverified, or silently drop).
    this.configured ??= this.secrets.list().then(names => new Set(names));
    const configured = await this.configured;
    const missing = required.filter(s => !configured.has(s));
    if (missing.length > 0) {
      // info, not warn: an unconfigured optional integration (Tavily, calendar, ...) is a
      // normal state. No row is written, so the next boot after configuring it enrolls it.
      this.logger.info(
        { tool, via, missingSecrets: missing },
        'registry: tool not enrolled until its required secret(s) are configured',
      );
      return false;
    }
    return true;
  }
}

export async function reconcileRegistries(deps: ReconcileDeps): Promise<void> {
  const {
    toolRepo, agentRepo, skillRepo,
    toolDiscoveryNames, agentDiscoveryNames, skillDiscoveryNames,
    bundleMembers, toolRequiredSecrets, secrets,
    defaults, logger,
  } = deps;
  const gate = new SecretsGate(toolRequiredSecrets, secrets, logger);

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
  }
}

async function reconcileOne(
  kind: 'tool' | 'agent' | 'skill',
  repo: IRegistryRepo,
  discoveryNames: Set<string>,
  coreNames: string[],
  logger: Logger,
  gate?: SecretsGate,
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
 */
async function expandEnabledBundles(
  skillRepo: IRegistryRepo,
  toolRepo: IRegistryRepo,
  toolDiscoveryNames: Set<string>,
  bundleMembers: ReadonlyMap<string, readonly string[]>,
  logger: Logger,
  gate: SecretsGate,
): Promise<void> {
  const enabledBundles = (await skillRepo.listRows()).filter(r => r.enabled).map(r => r.name);
  // Re-read: the tools: pass above may have just inserted rows.
  const existing = new Set((await toolRepo.listRows()).map(r => r.name));

  for (const bundle of enabledBundles) {
    const members = bundleMembers.get(bundle);
    // No entry = ghost bundle or unparsable SKILL.md. Boot already warns about ghosts,
    // and an unparsable bundle never loads, so there is nothing safe to expand.
    if (!members) continue;

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
