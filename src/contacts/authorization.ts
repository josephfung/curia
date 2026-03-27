// src/contacts/authorization.ts
//
// Deterministic authorization evaluation. No LLM involved — this is pure logic.
//
// Three-layer check:
// 1. Contact status gate — provisional and blocked contacts get zero permissions
// 2. Per-contact overrides → role defaults → escalate (for permissions in neither)
// 3. Channel trust — high-sensitivity actions on low-trust channels are trust-blocked

import type {
  AuthConfig,
  AuthorizationResult,
  ContactStatus,
  TrustLevel,
} from './types.js';

interface AuthOverrideInput {
  permission: string;
  granted: boolean;
}

export interface AuthEvaluateInput {
  role: string | null;
  status: ContactStatus;
  channel: string;
  overrides: AuthOverrideInput[];
}

// Trust level numeric values for comparison.
const TRUST_RANK: Record<TrustLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Deterministic authorization service.
 *
 * Evaluates what a contact is allowed to do based on:
 * 1. Contact status (provisional/blocked → zero permissions)
 * 2. Per-contact overrides (explicit grants/denials from the CEO)
 * 3. Role defaults (from config/role-defaults.yaml)
 * 4. Channel trust (from config/channel-trust.yaml + config/permissions.yaml sensitivity)
 *
 * This is NOT an LLM decision — it's a deterministic function of config + data.
 */
export class AuthorizationService {
  constructor(private config: AuthConfig) {}

  evaluate(input: AuthEvaluateInput): AuthorizationResult {
    const channelTrust = this.config.channelTrust[input.channel] ?? 'low';

    // Gate 1: provisional and blocked contacts get zero permissions.
    // This is the hardest gate — no overrides or role defaults can bypass it.
    if (input.status !== 'confirmed') {
      return {
        allowed: [],
        denied: ['*'],
        escalate: [],
        channelTrust,
        trustBlocked: [],
        contactStatus: input.status,
      };
    }

    // Look up role defaults. Unknown roles (including null) fall back to 'unknown'.
    const roleName = input.role ?? 'unknown';
    const roleDefaults = this.config.roles[roleName] ?? this.config.roles.unknown;

    // Build override map for O(1) lookup
    const overrideMap = new Map<string, boolean>();
    for (const o of input.overrides) {
      overrideMap.set(o.permission, o.granted);
    }

    const allowed: string[] = [];
    const denied: string[] = [];
    const escalate: string[] = [];
    const trustBlocked: string[] = [];

    // Check for wildcard permissions/denials in role defaults
    const roleAllowsAll = roleDefaults.defaultPermissions.includes('*');
    const roleDeniesAll = roleDefaults.defaultDeny.includes('*');

    for (const [permName, permDef] of Object.entries(this.config.permissions)) {
      // Layer 1: Check overrides first (highest precedence)
      if (overrideMap.has(permName)) {
        if (overrideMap.get(permName)) {
          if (TRUST_RANK[channelTrust] >= TRUST_RANK[permDef.sensitivity]) {
            allowed.push(permName);
          } else {
            trustBlocked.push(permName);
          }
        } else {
          denied.push(permName);
        }
        continue;
      }

      // Layer 2: Check role defaults
      if (roleAllowsAll || roleDefaults.defaultPermissions.includes(permName)) {
        if (TRUST_RANK[channelTrust] >= TRUST_RANK[permDef.sensitivity]) {
          allowed.push(permName);
        } else {
          trustBlocked.push(permName);
        }
        continue;
      }

      if (roleDeniesAll || roleDefaults.defaultDeny.includes(permName)) {
        denied.push(permName);
        continue;
      }

      // Not in defaults or deny list — needs CEO decision
      escalate.push(permName);
    }

    // Carry through wildcard sentinels if role has them.
    // These are used by callers to quickly identify "allow all" or "deny all" roles
    // without having to enumerate every permission in the config.
    if (roleAllowsAll && !allowed.includes('*')) {
      allowed.unshift('*');
    }
    if (roleDeniesAll && !denied.includes('*')) {
      denied.unshift('*');
    }

    return {
      allowed,
      denied,
      escalate,
      channelTrust,
      trustBlocked,
      contactStatus: input.status,
    };
  }
}
