// src/contacts/config-loader.ts
//
// Loads authorization config from YAML files at boot time.
// Three files: role-defaults.yaml, permissions.yaml, channel-trust.yaml
// These are loaded once at startup and passed to the AuthorizationService.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { AuthConfig, RolePermissions, PermissionDef, TrustLevel, UnknownSenderPolicy, ChannelPolicyConfig } from './types.js';

interface RawRoleEntry {
  description: string;
  default_permissions: string[];
  default_deny: string[];
}

interface RawPermissionEntry {
  description: string;
  sensitivity: string;
}

/**
 * Load authorization configuration from the config directory.
 * Reads role-defaults.yaml, permissions.yaml, and channel-trust.yaml.
 * Throws on missing files or invalid YAML — fail hard at startup.
 */
export function loadAuthConfig(configDir: string): AuthConfig {
  // Role defaults
  const rolesRaw = yaml.load(
    readFileSync(path.join(configDir, 'role-defaults.yaml'), 'utf-8'),
  );
  if (!rolesRaw || typeof rolesRaw !== 'object' || !('roles' in rolesRaw)) {
    throw new Error("Missing or invalid 'roles' section in role-defaults.yaml");
  }
  const rolesTyped = rolesRaw as { roles: Record<string, RawRoleEntry> };

  const roles: Record<string, RolePermissions> = {};
  for (const [roleName, entry] of Object.entries(rolesTyped.roles)) {
    roles[roleName] = {
      description: entry.description ?? roleName,
      defaultPermissions: entry.default_permissions ?? [],
      defaultDeny: entry.default_deny ?? [],
    };
  }

  // Permissions registry
  const permsRaw = yaml.load(
    readFileSync(path.join(configDir, 'permissions.yaml'), 'utf-8'),
  );
  if (!permsRaw || typeof permsRaw !== 'object' || !('permissions' in permsRaw)) {
    throw new Error("Missing or invalid 'permissions' section in permissions.yaml");
  }
  const permsTyped = permsRaw as { permissions: Record<string, RawPermissionEntry> };

  const permissions: Record<string, PermissionDef> = {};
  for (const [permName, entry] of Object.entries(permsTyped.permissions)) {
    const sensitivity = entry.sensitivity as TrustLevel;
    if (!['high', 'medium', 'low'].includes(sensitivity)) {
      throw new Error(`Invalid sensitivity '${sensitivity}' for permission '${permName}'`);
    }
    permissions[permName] = {
      description: entry.description,
      sensitivity,
    };
  }

  // Channel trust levels
  const trustRaw = yaml.load(
    readFileSync(path.join(configDir, 'channel-trust.yaml'), 'utf-8'),
  );
  if (!trustRaw || typeof trustRaw !== 'object' || !('channels' in trustRaw)) {
    throw new Error("Missing or invalid 'channels' section in channel-trust.yaml");
  }
  // Accept either flat strings (legacy) or objects with trust + unknown_sender fields
  const trustTyped = trustRaw as { channels: Record<string, string | { trust: string; unknown_sender: string }> };

  const channelTrust: Record<string, TrustLevel> = {};
  const channelPolicies: Record<string, ChannelPolicyConfig> = {};

  for (const [channel, config] of Object.entries(trustTyped.channels)) {
    if (typeof config === 'string') {
      // Backwards compat: plain string is just trust level
      const trust = config as TrustLevel;
      if (!['high', 'medium', 'low'].includes(trust)) {
        throw new Error(`Invalid trust level '${trust}' for channel '${channel}'`);
      }
      channelTrust[channel] = trust;
      // Default to 'allow' for legacy configs — silently holding messages would be
      // a surprising behavior change for deployments using the old flat-string format.
      channelPolicies[channel] = { trust, unknownSender: 'allow' };
    } else {
      const trust = (config as { trust: string }).trust as TrustLevel;
      if (!['high', 'medium', 'low'].includes(trust)) {
        throw new Error(`Invalid trust level '${trust}' for channel '${channel}'`);
      }
      const unknownSender = (config as { unknown_sender: string }).unknown_sender as UnknownSenderPolicy;
      if (!['allow', 'hold_and_notify', 'reject'].includes(unknownSender)) {
        throw new Error(`Invalid unknown_sender policy '${unknownSender}' for channel '${channel}'`);
      }
      channelTrust[channel] = trust;
      channelPolicies[channel] = { trust, unknownSender };
    }
  }

  return { roles, permissions, channelTrust, channelPolicies };
}
