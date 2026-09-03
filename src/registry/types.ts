// types.ts — shared types for the skill/agent registry (install/enable lifecycle).
// State is DERIVED (never stored): we cross-reference on-disk manifest discovery
// against registry rows to compute uninstalled / installed / enabled / ghost.

import type { ActionRisk } from '../skills/types.js';

export type RegistryKind = 'tool' | 'agent' | 'skill';

/** Operational state of a registry item. Derived, not stored. */
export type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

/** A row in tool_registry / agent_registry, mapped to camelCase. */
export interface RegistryRow {
  name: string;
  enabled: boolean;
  installedAt: string;
  installedBy: string;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

/** Manifest metadata surfaced to the UI. Superset for skills + agents; unused
 *  fields are simply absent. `null` only when the manifest failed to parse. */
export interface ManifestMetadata {
  name: string;
  description: string;
  version: string;
  // skills
  actionRisk?: ActionRisk;
  sensitivity?: string;
  capabilities?: string[];
  /** Vault keys the skill's install block declares it needs (install.requires_secrets).
   *  Surfaced to the registry UI and consulted by the install/enable secrets gate. */
  requiresSecrets?: string[];
  /** Member tool names for a SKILL.md bundle. Sourced from on-disk discovery, NOT
   *  SkillRegistry — a bundle that is disabled is never registered, so SkillRegistry
   *  cannot report its members. Skills only; undefined for tools and agents. */
  tools?: string[];
  /** Names of agents whose `pinned_skills` reference this bundle. Static, read from
   *  agent manifests on disk. The console cross-references each agent's own enabled
   *  state (via /api/registry/agents) to decide which combinations are broken. */
  pinnedBy?: string[];
  // agents
  role?: string;
  modelTier?: string;
  /** Raw `pinned_skills` for an agent — a mix of bundle names and first-class tool
   *  pins (ADR-032). Distinct from `tools`, which means bundle membership on a skill.
   *  The console uses this to warn before a bundle disable strips a tool that some
   *  other agent pins directly. Agents only. */
  pinnedTools?: string[];
}

/** One on-disk item found during discovery. `metadata` is null when the manifest
 *  could not be parsed (the parse error is captured in `error`). */
export interface Discovery {
  name: string;
  metadata: ManifestMetadata | null;
  error?: string;
}

/** A fully-resolved entry the API returns: discovery × row → derived state. */
export interface RegistryEntry {
  name: string;
  kind: RegistryKind;
  state: DerivedState;
  metadata: ManifestMetadata | null; // null for ghosts
  manifestError?: string;            // set when the on-disk manifest failed to parse
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** Thrown by RegistryService for expected guard rejections (not-on-disk, broken manifest,
 *  not-installed enable, etc.). Routes catch this specifically to return HTTP 400;
 *  all other errors bubble up as HTTP 500. */
export class RegistryGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryGuardError';
  }
}

/** Narrow read-only view of the secrets vault the registry's install/enable gate needs.
 *  SecretsService satisfies this; tests pass a fake. Keeps RegistryService decoupled from
 *  the full secrets surface (it only ever needs the configured key names). */
export interface SecretsLister {
  /** Names of all configured secrets — keys only, never values. */
  list(): Promise<string[]>;
}

/** The DB-access contract RegistryService and reconciliation depend on.
 *  The Postgres implementation is RegistryRepo; tests use an in-memory fake. */
export interface IRegistryRepo {
  listRows(): Promise<RegistryRow[]>;
  getRow(name: string): Promise<RegistryRow | null>;
  /** Insert enabled=false if absent; no-op + return existing row if present. */
  install(name: string, actor: string): Promise<RegistryRow>;
  /** Insert enabled=true if absent; no-op if present. Returns the new row, or null on conflict. */
  installAndEnable(name: string, actor: string): Promise<RegistryRow | null>;
  /** Set enabled=true (+ enabled_at/by). Throws if no row exists. */
  enable(name: string, actor: string): Promise<RegistryRow>;
  /** Set enabled=false (+ clear enabled_at/by). Throws if no row exists. */
  disable(name: string, actor: string): Promise<RegistryRow>;
  /** Delete the row. No error if absent. */
  uninstall(name: string): Promise<void>;
}

/** Cross-table bundle operations. Separate from IRegistryRepo, which is deliberately
 *  one-instance-per-table; enabling a bundle must write skill_registry and every
 *  member's tool_registry row in a single transaction (#1724). */
export interface IBundleCascadeRepo {
  enableBundle(bundle: string, tools: string[], actor: string): Promise<void>;
  disableBundle(bundle: string, tools: string[], actor: string): Promise<void>;
}
