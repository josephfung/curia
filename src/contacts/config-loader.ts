// src/contacts/config-loader.ts
//
// Loads authorization config from YAML files at boot time.
// Three files: role-defaults.yaml, permissions.yaml, channel-trust.yaml
// These are loaded once at startup and passed to the AuthorizationService.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { AuthConfig, RolePermissions, PermissionDef, TrustLevel } from './types.js';

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
  ) as { roles: Record<string, RawRoleEntry> };

  const roles: Record<string, RolePermissions> = {};
  for (const [roleName, entry] of Object.entries(rolesRaw.roles)) {
    roles[roleName] = {
      description: entry.description,
      defaultPermissions: entry.default_permissions,
      defaultDeny: entry.default_deny,
    };
  }

  // Permissions registry
  const permsRaw = yaml.load(
    readFileSync(path.join(configDir, 'permissions.yaml'), 'utf-8'),
  ) as { permissions: Record<string, RawPermissionEntry> };

  const permissions: Record<string, PermissionDef> = {};
  for (const [permName, entry] of Object.entries(permsRaw.permissions)) {
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
  ) as { channels: Record<string, string> };

  const channelTrust: Record<string, TrustLevel> = {};
  for (const [channel, level] of Object.entries(trustRaw.channels)) {
    if (!['high', 'medium', 'low'].includes(level)) {
      throw new Error(`Invalid trust level '${level}' for channel '${channel}'`);
    }
    channelTrust[channel] = level as TrustLevel;
  }

  return { roles, permissions, channelTrust };
}
