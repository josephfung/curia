// src/contacts/authorization.ts
//
// Deterministic authorization evaluation. No LLM involved — this is pure logic.
//
// Three-layer check:
// 1. Contact status gate — provisional and blocked contacts get zero permissions
// 2. Per-contact overrides → role defaults → escalate (for permissions in neither)
// 3. Channel trust — high-sensitivity actions on low-trust channels are trust-blocked
//
// Role lookup is case-insensitive: LLM-assigned roles like 'Spouse' match 'spouse' in config.
// If the role has no config match, falls back to trust_level tier defaults so confirmed
// contacts with an explicit trust grant still get appropriate permissions.
// Effective trust = max(channel trust, contact trust_level) — a contact's explicit trust
// grant is not downgraded by the channel's inherent floor.

import type {
  AuthConfig,
  AuthorizationResult,
  ContactStatus,
  TrustLevel,
} from './types.js';
import { TRUST_RANK } from './types.js';

interface AuthOverrideInput {
  permission: string;
  granted: boolean;
}

export interface AuthEvaluateInput {
  role: string | null;
  /** Per-contact trust_level from DB, or null to use only the channel floor. */
  trustLevel: TrustLevel | null;
  status: ContactStatus;
  channel: string;
  overrides: AuthOverrideInput[];
}

/**
 * Deterministic authorization service.
 *
 * Evaluates what a contact is allowed to do based on:
 * 1. Contact status (provisional/blocked → zero permissions)
 * 2. Per-contact overrides (explicit grants/denials from the CEO)
 * 3. Role defaults (from config/role-defaults.yaml, case-insensitive lookup)
 *    Falls back to trust_level tier defaults when no role match exists.
 * 4. Effective trust (max of channel trust and contact trust_level) used for
 *    sensitivity gating, so explicit high-trust grants are not channel-downgraded.
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

    // Effective trust: the higher of the channel's inherent trust and the contact's
    // explicit trust_level grant. A contact with trust_level='high' on email (low)
    // should not have their CEO-granted trust overridden by the channel floor.
    // Contacts with no explicit trust_level (null) use only the channel floor.
    const channelTrustRank = TRUST_RANK[channelTrust] ?? 0;
    const contactTrustRank = (() => {
      if (input.trustLevel == null) return 0;
      const rank = TRUST_RANK[input.trustLevel];
      // Throw on unknown values: a corrupt DB row or a new enum value deployed before
      // TRUST_RANK is updated must fail loudly. The contact-resolver.ts catch block
      // will set authorization=null — a safe degradation that is logged and observable.
      if (rank === undefined) {
        throw new Error(
          `Unknown trustLevel value '${input.trustLevel}' — not a recognized TrustLevel enum. Check migration history or DB integrity.`,
        );
      }
      return rank;
    })();
    const effectiveTrustRank = Math.max(channelTrustRank, contactTrustRank);

    // Role lookup: case-insensitive so LLM-assigned 'Spouse' matches config key 'spouse'.
    // Fall back to trust_level tier defaults when the role has no config entry, so
    // contacts with an explicit trust grant still get appropriate permissions even when
    // the role is a free-text description ('Sister', 'Head Instructor, …').
    // Ultimate fallback is the 'unknown' role, then a hard-deny object.
    const roleName = (input.role ?? '').toLowerCase();
    const roleDefaults =
      (roleName !== '' ? this.config.roles[roleName] : undefined) ??
      (input.trustLevel != null ? this.config.trustLevelDefaults?.[input.trustLevel] : undefined) ??
      this.config.roles['unknown'] ??
      { description: 'fallback', defaultPermissions: [], defaultDeny: ['*'] };

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
      // Resolve sensitivity rank once per permission. If undefined (e.g. a future
      // 'critical' sensitivity added to permissions.yaml before TRUST_RANK is updated),
      // escalate so the CEO makes the call rather than silently denying or allowing.
      const sensitivityRank = TRUST_RANK[permDef.sensitivity as TrustLevel];

      // Layer 1: Check overrides first (highest precedence)
      if (overrideMap.has(permName)) {
        if (overrideMap.get(permName)) {
          if (sensitivityRank === undefined) {
            escalate.push(permName);
          } else if (effectiveTrustRank >= sensitivityRank) {
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
        if (sensitivityRank === undefined) {
          // Sensitivity value not in TRUST_RANK — programming/config error caught at runtime.
          // Escalate rather than silently trust-blocking a granted permission.
          escalate.push(permName);
        } else if (effectiveTrustRank >= sensitivityRank) {
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
    //
    // The wildcard '*' in allowed indicates the role has blanket permission.
    // Individual permissions may still appear in trustBlocked if the channel
    // trust is insufficient — callers should check trustBlocked even when
    // allowed contains '*'.
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
