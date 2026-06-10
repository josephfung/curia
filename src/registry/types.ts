// types.ts — shared types for the skill/agent registry (install/enable lifecycle).
// State is DERIVED (never stored): we cross-reference on-disk manifest discovery
// against registry rows to compute uninstalled / installed / enabled / ghost.

import type { ActionRisk } from '../skills/types.js';

export type RegistryKind = 'skill' | 'agent';

/** Operational state of a registry item. Derived, not stored. */
export type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

/** A row in skill_registry / agent_registry, mapped to camelCase. */
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
  // agents
  role?: string;
  modelTier?: string;
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

/** The DB-access contract RegistryService and reconciliation depend on.
 *  The Postgres implementation is RegistryRepo; tests use an in-memory fake. */
export interface IRegistryRepo {
  listRows(): Promise<RegistryRow[]>;
  getRow(name: string): Promise<RegistryRow | null>;
  /** Insert enabled=false if absent; no-op + return existing row if present. */
  install(name: string, actor: string): Promise<RegistryRow>;
  /** Set enabled=true (+ enabled_at/by). Throws if no row exists. */
  enable(name: string, actor: string): Promise<RegistryRow>;
  /** Set enabled=false (+ clear enabled_at/by). Throws if no row exists. */
  disable(name: string, actor: string): Promise<RegistryRow>;
  /** Delete the row. No error if absent. */
  uninstall(name: string): Promise<void>;
}
