import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import type { AuthConfig } from '../../../src/contacts/types.js';

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
      trustLevel: 'ceo',
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
      trustLevel: null,
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
      trustLevel: null,
      status: 'blocked',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('blocked');
  });

  it('applies role defaults for confirmed contacts', () => {
    const result = authService.evaluate({
      role: 'cfo',
      trustLevel: null,
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
      trustLevel: null,
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
      trustLevel: null,
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.trustBlocked).toContain('view_financial_reports');
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('unknown roles with no trustLevel fall back to unknown defaults', () => {
    const result = authService.evaluate({
      role: 'some_new_role',
      trustLevel: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  it('null role with no trustLevel uses unknown defaults', () => {
    const result = authService.evaluate({
      role: null,
      trustLevel: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
  });

  it('permissions not in role defaults or overrides go to escalate', () => {
    const result = authService.evaluate({
      role: 'cfo',
      trustLevel: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.escalate).toContain('see_personal_calendar');
  });

  it('returns correct channel trust level', () => {
    const result = authService.evaluate({
      role: 'cfo',
      trustLevel: null,
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.channelTrust).toBe('low');
  });

  it('unknown channels default to low trust', () => {
    const result = authService.evaluate({
      role: 'cfo',
      trustLevel: null,
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
      trustLevel: 'high',
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
      trustLevel: 'ceo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('*');
    expect(result.denied).toEqual([]);
  });

  // --- tier fallback when role has no config match ---

  it('unrecognized role with high trustLevel falls back to tierDefaults', () => {
    // 'Sister' is a valid free-text role the LLM might set, but has no config key.
    // Should fall back to tierDefaults['high'] instead of 'unknown'.
    const result = authService.evaluate({
      role: 'Sister',
      trustLevel: 'high',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // tierDefaults.high grants see_personal_calendar
    // After effective trust fix, max(low, high)=high → should not be trust-blocked
    expect(result.denied).not.toContain('*');
    expect(result.trustBlocked).not.toContain('see_personal_calendar');
  });

  it('unrecognized role with medium trustLevel falls back to tierDefaults', () => {
    const result = authService.evaluate({
      role: 'CEO, Communitech',
      trustLevel: 'medium',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // tierDefaults.medium grants schedule_meetings (low sensitivity → not trust-blocked)
    expect(result.denied).not.toContain('*');
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('unrecognized role with null trustLevel still uses unknown defaults', () => {
    const result = authService.evaluate({
      role: 'Head Instructor, Kitchener Kicks',
      trustLevel: null,
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // No role match, no trustLevel → falls to unknown → denied: ['*']
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  // --- Effective trust: contact trustLevel overrides channel floor for sensitivity gating ---

  it('high-trust contact on low-trust channel gets medium-sensitivity perms (not trust-blocked)', () => {
    // Xiaopu scenario: trust_level=high, channel=email (low).
    // Without effective trust fix, spouse's see_personal_calendar (medium) is trust-blocked.
    // With fix: max(low, high)=high → allowed.
    const result = authService.evaluate({
      role: 'spouse',
      trustLevel: 'high',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.trustBlocked).not.toContain('see_personal_calendar');
    expect(result.allowed).toContain('see_personal_calendar');
  });

  it('null-trustLevel contact on low-trust channel still gets medium-sensitivity perms trust-blocked', () => {
    // Unrecognized sender with no explicit trust grant should still be gated by channel trust.
    // Uses cfo role (grants view_financial_reports, schedule_meetings) for this test.
    const result = authService.evaluate({
      role: 'cfo',
      trustLevel: null,
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // view_financial_reports is high sensitivity → trust-blocked on email
    expect(result.trustBlocked).toContain('view_financial_reports');
    // schedule_meetings is low sensitivity → still allowed
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('CEO on email gets medium-sensitivity perms via effective trust override', () => {
    // Joseph scenario: trust_level=ceo, channel=email (low).
    // Without fix: see_personal_calendar trust-blocked. With fix: max(low,ceo)=ceo → allowed.
    const result = authService.evaluate({
      role: 'ceo',
      trustLevel: 'ceo',
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
      trustLevel: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    // Hard-deny fallback: defaultPermissions: [], defaultDeny: ['*']
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  it('falls to unknown role when tierDefaults has no entry for the contact trust level', () => {
    // A contact with trust_level='high' and an unrecognized role falls through to
    // tierDefaults['high']. If that tier is absent from tierDefaults,
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
      role: 'Sister',       // No 'sister' in roles → tries trustLevelDefaults
      trustLevel: 'high',   // 'high' not in partial trustLevelDefaults → falls to unknown
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    // Falls through to unknown role → denied: ['*']
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  // --- Issue 1: throw on unknown trustLevel value (not a valid TrustLevel enum) ---

  it('throws when trustLevel is not a recognized enum value (e.g. legacy DB value or migration gap)', () => {
    // A corrupt DB row or a new enum value deployed to DB before code catches up
    // must throw rather than silently collapsing to rank 0 (= low trust).
    // The contact-resolver.ts catch block will handle this with authorization=null.
    expect(() =>
      authService.evaluate({
        role: 'cfo',
        trustLevel: 'verified' as unknown as TrustLevel,
        status: 'confirmed',
        channel: 'email',
        overrides: [],
      }),
    ).toThrow(/Unknown trustLevel/);
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
      trustLevel: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.escalate).toContain('schedule_meetings');
    expect(result.trustBlocked).not.toContain('schedule_meetings');
  });
});
