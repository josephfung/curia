// registry-defaults-coverage.test.ts — a FRESH install, end to end against the real files (#1974).
//
// Reconciles an empty registry against the real config/registry-defaults.yaml and the
// real manifests on disk, then loads what got enabled and resolves every default agent's
// pins. A bundle member that is neither enrolled nor held back by a declared gate (the
// doc-place / setup-status failure mode) shows up here as `member_tools_missing`, so a
// new bundle member that would silently miss enrollment fails CI instead of production.

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { createLogger } from '../../../src/logger.js';
import {
  bundleMembersFromDiscovery, loadRegistryDefaults, reconcileRegistries, toolManifestsFromDiscovery,
  type RegistryDefaults, type ToolGateInfo,
} from '../../../src/registry/reconcile.js';
import type { IRegistryRepo, RegistryRow, SecretsLister } from '../../../src/registry/types.js';
import { discoverToolManifests, loadToolsFromDirectory, type ToolDiscovery } from '../../../src/skills/loader.js';
import {
  discoverSkillManifests, loadSkillsFromDiscovery, registerSyntheticSingletonSkills,
} from '../../../src/skills/skill-loader.js';
import type { SkillDiscovery } from '../../../src/skills/skill-types.js';
import { discoverAgentManifests, type AgentDiscovery } from '../../../src/agents/loader.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { resolvePinnedSkills } from '../../../src/skills/pin-resolution.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const logger = createLogger('silent');

/** An empty registry table. Reconcile only ever calls listRows + installAndEnable. */
class FreshRepo implements IRegistryRepo {
  readonly rows = new Map<string, RegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async installAndEnable(name: string, actor: string) {
    if (this.rows.has(name)) return null;
    const row: RegistryRow = {
      name, enabled: true, installedAt: 't0', installedBy: actor, enabledAt: 't0', enabledBy: actor, updatedAt: 't0',
    };
    this.rows.set(name, row);
    return row;
  }
  enabledNames(): Set<string> {
    return new Set([...this.rows.values()].filter(r => r.enabled).map(r => r.name));
  }
  private unused(): never { throw new Error('reconcile must only call listRows/installAndEnable'); }
  async getRow(): Promise<RegistryRow | null> { return this.unused(); }
  async install(): Promise<RegistryRow> { return this.unused(); }
  async enable(): Promise<RegistryRow> { return this.unused(); }
  async disable(): Promise<RegistryRow> { return this.unused(); }
  async uninstall(): Promise<boolean> { return this.unused(); }
  async uninstallIfDisabled(): Promise<boolean> { return this.unused(); }
}

let defaults: RegistryDefaults;
let toolDiscovery: ToolDiscovery[];
let skillDiscovery: SkillDiscovery[];
let agentDiscovery: AgentDiscovery[];
let bundleMembers: Map<string, string[] | null>;
let toolManifests: Map<string, ToolGateInfo | null>;
/** Every vault key any tool declares in install.requires_secrets. */
let allDeclaredKeys: string[];

/** Capabilities boot leaves unbuilt when their integration isn't configured (src/index.ts). */
const INTEGRATION_CAPABILITIES = ['nylasCalendarClient'];

/** True when a tool declares a gate that can hold it back on an unconfigured install. */
function isGated(tool: string): boolean {
  const info = toolManifests.get(tool);
  if (!info) return false;
  return info.requiresSecrets.length > 0 || info.capabilities.some(c => INTEGRATION_CAPABILITIES.includes(c));
}

beforeAll(() => {
  defaults = loadRegistryDefaults(path.join(REPO_ROOT, 'config', 'registry-defaults.yaml'));
  toolDiscovery = discoverToolManifests(path.join(REPO_ROOT, 'skills'));
  skillDiscovery = discoverSkillManifests(path.join(REPO_ROOT, 'skills'));
  agentDiscovery = discoverAgentManifests(path.join(REPO_ROOT, 'agents'));
  bundleMembers = bundleMembersFromDiscovery(skillDiscovery);
  toolManifests = toolManifestsFromDiscovery(toolDiscovery);
  allDeclaredKeys = [...new Set([...toolManifests.values()].flatMap(i => i?.requiresSecrets ?? []))];
});

/** Reconcile a fresh install: bare (no credentials) or fully configured. */
async function freshInstall(mode: 'bare' | 'configured') {
  const vaultKeys = mode === 'configured' ? allDeclaredKeys : [];
  const toolRepo = new FreshRepo();
  const skillRepo = new FreshRepo();
  const agentRepo = new FreshRepo();
  const secrets: SecretsLister = { list: async () => vaultKeys };
  await reconcileRegistries({
    toolRepo, agentRepo, skillRepo,
    toolManifests,
    agentDiscoveryNames: new Set(agentDiscovery.map(d => d.name)),
    skillDiscoveryNames: new Set(skillDiscovery.map(d => d.name)),
    bundleMembers,
    secrets,
    unavailableCapabilities: new Set(mode === 'configured' ? [] : INTEGRATION_CAPABILITIES),
    defaults,
    logger,
  });
  return { tools: toolRepo.enabledNames(), skills: skillRepo.enabledNames(), agents: agentRepo.enabledNames() };
}

/** Every member of every default bundle, paired with its bundle. */
function defaultBundleMembers(): Array<{ bundle: string; tool: string }> {
  return (defaults.skills ?? []).flatMap(bundle =>
    (bundleMembers.get(bundle) ?? []).map(tool => ({ bundle, tool })),
  );
}

/** member_tools_missing pins for every default agent, after a real load of `enabled`. */
async function missingBundleMembers(enabled: Awaited<ReturnType<typeof freshInstall>>) {
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  await loadToolsFromDirectory(toolDiscovery, toolRegistry, logger, enabled.tools);
  loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, enabled.skills);
  registerSyntheticSingletonSkills(toolRegistry, skillRegistry, logger);

  const missing: Array<{ agent: string; pin: string; tools: string[] }> = [];
  for (const agent of defaults.agents) {
    const config = agentDiscovery.find(d => d.name === agent)?.config;
    const pins = resolvePinnedSkills(config?.pinned_skills ?? [], skillRegistry, toolRegistry);
    for (const u of pins.unresolvedPins) {
      if (u.reason === 'member_tools_missing') missing.push({ agent, pin: u.pin, tools: u.missingTools ?? [] });
    }
  }
  return missing;
}

describe('registry-defaults.yaml on a fresh install (#1974)', () => {
  it('names only items that exist on disk with parsable manifests', () => {
    const tools = new Map(toolDiscovery.map(d => [d.name, d]));
    const skills = new Map(skillDiscovery.map(d => [d.name, d]));
    const agents = new Set(agentDiscovery.map(d => d.name));
    for (const t of defaults.tools) expect(tools.get(t)?.metadata, `tool ${t}`).toBeTruthy();
    for (const s of defaults.skills ?? []) expect(skills.get(s)?.metadata, `skill ${s}`).toBeTruthy();
    for (const a of defaults.agents) expect(agents.has(a), `agent ${a}`).toBe(true);
  });

  it('lists only standalone tools under tools: — bundle members enroll through their bundle', () => {
    const owner = new Map<string, string>();
    for (const [bundle, members] of bundleMembers) for (const t of members ?? []) owner.set(t, bundle);
    const listedMembers = defaults.tools.filter(t => owner.has(t)).map(t => `${t} (bundle ${owner.get(t)})`);
    expect(listedMembers, 'remove these from tools: — membership lives in the SKILL.md').toEqual([]);
  });

  it('every default-bundle member is enabled, or held back by a gate it declares', async () => {
    const enabled = await freshInstall('bare');
    const neither = defaultBundleMembers()
      .filter(({ tool }) => !enabled.tools.has(tool) && !isGated(tool))
      .map(({ bundle, tool }) => `${bundle}/${tool}`);
    expect(neither, 'enabled by bundle expansion, or declare install.requires_secrets / an integration capability').toEqual([]);
  });

  it('enables the members that used to be missing (#1974)', async () => {
    const enabled = await freshInstall('bare');
    for (const tool of [
      'doc-place',
      'setup-status', 'setup-defer', 'system-secret-capture-request',
      'contact-set-role', 'contact-set-tier', 'contact-dedup-exclude',
      'scan-grant-recommendations', 'approve-grant-recommendation', 'decline-grant-recommendation',
      'context-bridge-clear',
    ]) {
      expect(enabled.tools.has(tool), tool).toBe(true);
    }
  });

  it('keeps credential-dependent members off without their credentials', async () => {
    const enabled = await freshInstall('bare');
    const calendar = bundleMembers.get('calendar') ?? [];
    expect(calendar.length).toBeGreaterThan(0);
    for (const tool of ['web-search', 'query-relationships', 'delete-relationship']) {
      expect(toolManifests.get(tool)?.requiresSecrets.length, `${tool} declares requires_secrets`).toBeGreaterThan(0);
      expect(enabled.tools.has(tool), tool).toBe(false);
    }
    // Every calendar member that talks to Nylas declares the client capability and stays
    // off. calendar-register is the exception by design: a DB-only write (links a calendar
    // id to a contact) callable only by the calendar agent, which isn't a default.
    const nylasBacked = calendar.filter(t => t !== 'calendar-register');
    expect(nylasBacked.length).toBeGreaterThanOrEqual(10);
    for (const tool of nylasBacked) {
      expect(toolManifests.get(tool)?.capabilities, `${tool} declares nylasCalendarClient`).toContain('nylasCalendarClient');
      expect(enabled.tools.has(tool), tool).toBe(false);
    }
  });

  it('enables every default-bundle member once its integrations are configured', async () => {
    const enabled = await freshInstall('configured');
    const off = defaultBundleMembers().filter(({ tool }) => !enabled.tools.has(tool)).map(m => m.tool);
    expect(off).toEqual([]);
  });

  it('boots with no member_tools_missing pin except gated tools, and none once credentials exist', async () => {
    const bare = await missingBundleMembers(await freshInstall('bare'));
    // Without credentials, a pinned bundle may only be missing its gated members.
    const ungatedMissing = bare.flatMap(m => m.tools.filter(t => !isGated(t)).map(t => `${m.agent}:${m.pin}/${t}`));
    expect(ungatedMissing).toEqual([]);
    for (const bundle of ['documents', 'setup', 'contacts', 'context-bridge']) {
      expect(bare.filter(m => m.pin === bundle), bundle).toEqual([]);
    }

    expect(await missingBundleMembers(await freshInstall('configured'))).toEqual([]);
  });
});
