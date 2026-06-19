import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import type { AuthConfig, ContactTier } from '../../../src/contacts/types.js';

const testConfig: AuthConfig = {
  roles: {
    ceo: {
      description: 'CEO',
      defaultPermissions: ['*'],
      defaultDeny: [],
    },
    cfo: {
      description: 'CFO',
      defaultPermissions: ['view_financial_reports', 'schedule_meetings'],
      defaultDeny: ['send_on_behalf'],
    },
    spouse: {
      description: 'Spouse or life partner',
      defaultPermissions: ['see_personal_calendar', 'schedule_meetings'],
      defaultDeny: ['view_financial_reports'],
    },
    unknown: {
      description: 'Unknown',
      defaultPermissions: [],
      defaultDeny: ['*'],
    },
  },
  tierDefaults: {
    principal: {
      description: 'Principal tier',
      defaultPermissions: ['*'],
      defaultDeny: [],
    },
    trusted: {
      description: 'Trusted tier',
      defaultPermissions: ['see_personal_calendar', 'schedule_meetings'],
      defaultDeny: ['view_financial_reports'],
    },
    known: {
      description: 'Known tier',
      defaultPermissions: ['schedule_meetings'],
      defaultDeny: ['view_financial_reports'],
    },
    unknown: {
      description: 'Unknown tier',
      defaultPermissions: [],
      defaultDeny: ['*'],
    },
  },
  permissions: {
    view_financial_reports: { description: 'View financials', sensitivity: 'high' },
    schedule_meetings: { description: 'Schedule meetings', sensitivity: 'low' },
    send_on_behalf: { description: 'Send as CEO', sensitivity: 'high' },
    see_personal_calendar: { description: 'See personal calendar', sensitivity: 'medium' },
  },
  channelTrust: {
    cli: 'high',
    email: 'low',
    http: 'medium',
  },
};

describe('AuthorizationService', () => {
  let authService: AuthorizationService;

  beforeEach(() => {
    authService = new AuthorizationService(testConfig);
  });

  it('CEO gets all permissions', () => {
    const result = authService.evaluate({
      role: 'ceo',
      tier: 'principal',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('*');
    expect(result.denied).toEqual([]);
    expect(result.contactStatus).toBe('confirmed');
  });

  it('provisional contacts get no permissions', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'provisional',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('provisional');
  });

  it('blocked contacts get no permissions', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'blocked',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('blocked');
  });

  it('blocked-tier contact on high-trust channel gets no permissions', () => {
    // tier='blocked' and status='confirmed' can diverge (tier is set independently).
    // Without a hard gate, Math.max(channelRank=2, tierRank=0)=2 would grant high-trust
    // permissions to a blocked contact on a cli/signal channel. Gate 2 prevents this.
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'blocked',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.trustBlocked).toEqual([]);
  });

  it('applies role defaults for confirmed contacts', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('view_financial_reports');
    expect(result.allowed).toContain('schedule_meetings');
    expect(result.denied).toContain('send_on_behalf');
  });

  it('overrides take precedence over role defaults', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'cli',
      overrides: [
        { permission: 'send_on_behalf', granted: true },
        { permission: 'view_financial_reports', granted: false },
      ],
    });
    expect(result.allowed).toContain('send_on_behalf');
    expect(result.denied).toContain('view_financial_reports');
  });

  it('channel trust blocks high-sensitivity actions on low-trust channels', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.trustBlocked).toContain('view_financial_reports');
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('unknown roles with unknown tier fall back to unknown tier defaults', () => {
    const result = authService.evaluate({
      role: 'some_new_role',
      tier: 'unknown',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  it('null role with unknown tier uses unknown tier defaults', () => {
    const result = authService.evaluate({
      role: null,
      tier: 'unknown',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
  });

  it('permissions not in role defaults or overrides go to escalate', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.escalate).toContain('see_personal_calendar');
  });

  it('returns correct channel trust level', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.channelTrust).toBe('low');
  });

  it('unknown channels default to low trust', () => {
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'unknown_channel',
      overrides: [],
    });
    expect(result.channelTrust).toBe('low');
  });

  // --- Case-insensitive role lookup ---

  it('role lookup is case-insensitive: Spouse matches spouse role', () => {
    // Bug: LLM sets role as 'Spouse' (capital S), config key is 'spouse' (lowercase).
    // Without normalization this falls to the 'unknown' role (denied: ['*']).
    const result = authService.evaluate({
      role: 'Spouse',
      tier: 'trusted',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // Should get spouse role permissions, not unknown's wildcard deny
    expect(result.allowed).not.toEqual([]);
    expect(result.denied).not.toContain('*');
  });

  it('role lookup is case-insensitive: CEO matches ceo role', () => {
    const result = authService.evaluate({
      role: 'CEO',
      tier: 'principal',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('*');
    expect(result.denied).toEqual([]);
  });

  // --- tier fallback when role has no config match ---

  it('unrecognized role with trusted tier falls back to tierDefaults', () => {
    // 'Sister' is a valid free-text role the LLM might set, but has no config key.
    // Should fall back to tierDefaults['trusted'] instead of 'unknown'.
    const result = authService.evaluate({
      role: 'Sister',
      tier: 'trusted',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // tierDefaults.trusted grants see_personal_calendar
    // After effective trust fix, max(low, trusted)=trusted → should not be trust-blocked
    expect(result.denied).not.toContain('*');
    expect(result.trustBlocked).not.toContain('see_personal_calendar');
  });

  it('unrecognized role with known tier falls back to tierDefaults', () => {
    const result = authService.evaluate({
      role: 'CEO, Communitech',
      tier: 'known',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // tierDefaults.known grants schedule_meetings (low sensitivity → not trust-blocked)
    expect(result.denied).not.toContain('*');
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('unrecognized role with unknown tier uses unknown tier defaults', () => {
    const result = authService.evaluate({
      role: 'Head Instructor, Kitchener Kicks',
      tier: 'unknown',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // No role match, unknown tier → tierDefaults.unknown → denied: ['*']
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  // --- Effective trust: contact tier rank overrides channel floor for sensitivity gating ---

  it('high-trust contact on low-trust channel gets medium-sensitivity perms (not trust-blocked)', () => {
    // Xiaopu scenario: tier=trusted, channel=email (low).
    // Without effective trust fix, spouse's see_personal_calendar (medium) is trust-blocked.
    // With fix: max(low, trusted)=trusted(2) >= medium(1) → allowed.
    const result = authService.evaluate({
      role: 'spouse',
      tier: 'trusted',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.trustBlocked).not.toContain('see_personal_calendar');
    expect(result.allowed).toContain('see_personal_calendar');
  });

  it('known-tier contact on low-trust channel still gets high-sensitivity perms trust-blocked', () => {
    // A contact with no special trust grant (tier=known, rank=1) on email (rank=0).
    // Uses cfo role (grants view_financial_reports, schedule_meetings) for this test.
    // effectiveTrustRank = max(0, 1) = 1; view_financial_reports sensitivity=high(rank=2) → blocked.
    const result = authService.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // view_financial_reports is high sensitivity → trust-blocked on email
    expect(result.trustBlocked).toContain('view_financial_reports');
    // schedule_meetings is low sensitivity → still allowed
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('known-tier contact on low-trust channel can access medium-sensitivity perms (intentional #1070 trade-off)', () => {
    // Old behavior: trustLevel=null → rank 0; email (rank 0): see_personal_calendar (medium, rank 1) → trust-blocked.
    // New behavior: tier='known' → rank 1 (medium-equivalent); effectiveTrust = max(0,1) = 1 >= 1 → allowed.
    // This is a deliberate trade-off in the trust_level→tier collapse: 'known' maps to the former 'medium'
    // trust level rather than null, so confirmed contacts with no explicit high/ceo grant get a slight
    // permission loosening for medium-sensitivity role grants on low-trust channels.
    // High-sensitivity permissions remain blocked (see test above).
    const result = authService.evaluate({
      role: 'spouse',
      tier: 'known',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // see_personal_calendar: medium sensitivity, spouse role grants it → now allowed (was trust-blocked pre-#1070)
    expect(result.allowed).toContain('see_personal_calendar');
    expect(result.trustBlocked).not.toContain('see_personal_calendar');
    // view_financial_reports: high sensitivity, spouse role denies it → still denied (not trust-blocked)
    expect(result.denied).toContain('view_financial_reports');
  });

  it('CEO on email gets medium-sensitivity perms via effective trust override', () => {
    // Joseph scenario: tier=principal, channel=email (low).
    // Without fix: see_personal_calendar trust-blocked. With fix: max(low,principal)=principal(3) → allowed.
    const result = authService.evaluate({
      role: 'ceo',
      tier: 'principal',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.trustBlocked).not.toContain('see_personal_calendar');
    // CEO role allows '*' so everything should be in allowed (wildcarded), not trustBlocked
    expect(result.allowed).toContain('*');
  });

  // --- Issue 6a/6b: fallback chain edge cases ---

  it('hard-deny fallback when config has no unknown role and no tierDefaults', () => {
    // Exercises the final hardcoded-deny sentinel in the fallback chain:
    //   role → tierDefaults → unknown → { defaultDeny: ['*'] }
    // When both unknown and tierDefaults are absent, the hard-deny object applies.
    const { unknown: _, ...rolesWithoutUnknown } = testConfig.roles;
    void _;
    const minimalConfig: AuthConfig = {
      roles: rolesWithoutUnknown,
      // No tierDefaults
      permissions: testConfig.permissions,
      channelTrust: testConfig.channelTrust,
      channelPolicies: {},
    };
    const service = new AuthorizationService(minimalConfig);
    const result = service.evaluate({
      role: 'some_unrecognized_role',
      tier: 'known',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    // Hard-deny fallback: defaultPermissions: [], defaultDeny: ['*']
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  it('falls to unknown role when tierDefaults has no entry for the contact tier', () => {
    // A contact with tier='trusted' and an unrecognized role falls through to
    // tierDefaults['trusted']. If that tier is absent from tierDefaults,
    // it falls further to the unknown role.
    const configWithPartialDefaults: AuthConfig = {
      ...testConfig,
      tierDefaults: {
        principal: testConfig.tierDefaults!.principal!,
        // Deliberately no 'trusted', 'known', or 'unknown' entries
      },
    };
    const service = new AuthorizationService(configWithPartialDefaults);
    const result = service.evaluate({
      role: 'Sister',     // No 'sister' in roles → tries tierDefaults
      tier: 'trusted',    // 'trusted' not in partial tierDefaults → falls to unknown role
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    // Falls through to unknown role → denied: ['*']
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  // --- Issue 1: throw on unknown tier value (not a valid ContactTier) ---

  it('throws when tier is not a recognized ContactTier value', () => {
    // A corrupt DB row or a new enum value deployed to DB before code catches up
    // must throw rather than silently collapsing to rank 0 (= low trust).
    // The contact-resolver.ts catch block will handle this with authorization=null.
    expect(() =>
      authService.evaluate({
        role: 'cfo',
        tier: 'super_trusted' as unknown as ContactTier,
        status: 'confirmed',
        channel: 'email',
        overrides: [],
      }),
    ).toThrow(/Unknown tier/);
  });

  // --- Issue 3: escalate when permission sensitivity has no TRUST_RANK entry ---

  it('escalates a permission when its sensitivity value has no TRUST_RANK entry', () => {
    // Protects against a future sensitivity value (e.g. 'critical') added to permissions.yaml
    // before a corresponding TRUST_RANK entry is added to types.ts.
    // Without guard: effectiveTrustRank >= undefined → false → trustBlocked (wrong, silent).
    // With guard: escalate (safe, explicit — needs CEO decision).
    const serviceWithBadSensitivity = new AuthorizationService({
      ...testConfig,
      permissions: {
        ...testConfig.permissions,
        // Override schedule_meetings to have an unrecognized sensitivity value.
        // CFO role grants schedule_meetings → hits the sensitivity guard.
        schedule_meetings: {
          description: 'Schedule meetings',
          sensitivity: 'critical' as unknown as 'low' | 'medium' | 'high',
        },
      },
    });
    const result = serviceWithBadSensitivity.evaluate({
      role: 'cfo',
      tier: 'known',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.escalate).toContain('schedule_meetings');
    expect(result.trustBlocked).not.toContain('schedule_meetings');
  });
});
