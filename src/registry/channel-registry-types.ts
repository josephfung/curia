// src/registry/channel-registry-types.ts
// Types for the channel registry. Mirrors registry/types.ts but channels are
// code-defined (CHANNEL_CATALOG), carry is_toggleable, and never reach a 'ghost' state.
import type { CredentialFieldStatus } from '../channels/credential-resolver.js';

export type ChannelDerivedState = 'uninstalled' | 'installed' | 'enabled';

/** A row in channel_registry, mapped to camelCase. */
export interface ChannelRegistryRow {
  name: string;
  enabled: boolean;
  isToggleable: boolean;
  installedAt: string;
  installedBy: string;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

/** A fully-resolved entry the API returns: catalog × row × credential status → state. */
export interface ChannelRegistryEntry {
  name: string;
  description: string;
  state: ChannelDerivedState;
  isToggleable: boolean;
  credentialFields: CredentialFieldStatus[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** Thrown for expected guard rejections (unknown channel, not-installed enable,
 *  disable/uninstall of a non-toggleable channel, missing-credential enable).
 *  Routes catch this specifically to return HTTP 400. */
export class ChannelGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelGuardError';
  }
}

/** DB-access contract. Postgres impl is ChannelRegistryRepo; tests use an in-memory fake. */
export interface IChannelRegistryRepo {
  listRows(): Promise<ChannelRegistryRow[]>;
  getRow(name: string): Promise<ChannelRegistryRow | null>;
  /** Insert enabled=false with the given is_toggleable if absent; return existing row if present. */
  install(name: string, actor: string, isToggleable: boolean): Promise<ChannelRegistryRow>;
  enable(name: string, actor: string): Promise<ChannelRegistryRow>;
  disable(name: string, actor: string): Promise<ChannelRegistryRow>;
  uninstall(name: string): Promise<void>;
}
