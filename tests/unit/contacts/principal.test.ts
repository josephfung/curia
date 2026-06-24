import { describe, it, expect, vi } from 'vitest';
import { isPrincipalOriginated, isAgentOriginated, isSystemOriginated, isLivePrincipalTurn, makeSystemOriginator, capOriginatorToParent } from '../../../src/contacts/principal.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

describe('isPrincipalOriginated', () => {
  it('returns true when originator systemRole is principal', () => {
    const metadata = {
      originator: {
        contactId: 'c-1',
        systemRole: 'principal',
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(true);
  });

  it('returns false when originator systemRole is agent', () => {
    const metadata = {
      originator: {
        contactId: 'c-2',
        systemRole: 'agent',
        channel: 'cli',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(false);
  });

  it('returns false when originator systemRole is null', () => {
    const metadata = {
      originator: {
        contactId: 'c-3',
        systemRole: null,
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(false);
  });

  it('returns false when originator is missing', () => {
    expect(isPrincipalOriginated({})).toBe(false);
    expect(isPrincipalOriginated(undefined)).toBe(false);
  });
});

describe('isAgentOriginated', () => {
  it('returns true when originator systemRole is agent', () => {
    const metadata = {
      originator: {
        contactId: 'c-2',
        systemRole: 'agent',
        channel: 'scheduler',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isAgentOriginated(metadata)).toBe(true);
  });

  it('returns false when originator systemRole is principal', () => {
    const metadata = {
      originator: {
        contactId: 'c-1',
        systemRole: 'principal',
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isAgentOriginated(metadata)).toBe(false);
  });

  it('returns false when originator systemRole is system', () => {
    const metadata = {
      originator: {
        contactId: 'system',
        systemRole: 'system',
        channel: 'declarative',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isAgentOriginated(metadata)).toBe(false);
  });

  it('returns false when metadata is missing', () => {
    expect(isAgentOriginated(undefined)).toBe(false);
  });
});

describe('isSystemOriginated', () => {
  it('returns true when originator systemRole is system', () => {
    const metadata = {
      originator: {
        contactId: 'system',
        systemRole: 'system',
        channel: 'declarative',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isSystemOriginated(metadata)).toBe(true);
  });

  it('returns false when originator systemRole is principal', () => {
    const metadata = {
      originator: {
        contactId: 'c-1',
        systemRole: 'principal',
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isSystemOriginated(metadata)).toBe(false);
  });

  it('returns false when originator systemRole is agent', () => {
    const metadata = {
      originator: {
        contactId: 'c-2',
        systemRole: 'agent',
        channel: 'scheduler',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isSystemOriginated(metadata)).toBe(false);
  });

  it('returns false when metadata is missing', () => {
    expect(isSystemOriginated(undefined)).toBe(false);
    expect(isSystemOriginated({})).toBe(false);
  });
});

describe('isPrincipalOriginated — system role regression', () => {
  it('returns false for system-originated tasks', () => {
    const metadata = {
      originator: {
        contactId: 'system',
        systemRole: 'system',
        channel: 'declarative',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(false);
  });
});

describe('makeSystemOriginator', () => {
  it('returns a TaskOriginator with systemRole system and channel declarative', () => {
    const originator = makeSystemOriginator();
    expect(originator.contactId).toBe('system');
    expect(originator.systemRole).toBe('system');
    expect(originator.channel).toBe('declarative');
    expect(originator.initiatedAt).toBeTruthy();
  });

  it('generates a fresh initiatedAt timestamp on each call', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const a = makeSystemOriginator();
    vi.advanceTimersByTime(1000);
    const b = makeSystemOriginator();
    vi.useRealTimers();

    expect(new Date(a.initiatedAt).getTime()).not.toBeNaN();
    expect(new Date(b.initiatedAt).getTime()).not.toBeNaN();
    expect(a.initiatedAt).not.toBe(b.initiatedAt);
  });
});

describe('capOriginatorToParent', () => {
  function originator(systemRole: 'principal' | 'system' | 'agent', contactId: string = systemRole): TaskOriginator {
    return { contactId, systemRole, channel: 'test', initiatedAt: '2026-06-23T00:00:00.000Z' };
  }

  it('returns the child when it is below the parent (no upgrade needed)', () => {
    const child = originator('agent');
    expect(capOriginatorToParent(child, originator('principal'))).toBe(child);
  });

  it('caps the child DOWN to the parent when the child claims higher standing', () => {
    const parent = originator('system');
    const result = capOriginatorToParent(originator('principal'), parent);
    expect(result).toBe(parent);
    expect(result?.systemRole).toBe('system');
  });

  it('prefers the child on equal rank (preserves its audit fields)', () => {
    const child = originator('principal', 'ceo-a');
    const result = capOriginatorToParent(child, originator('principal', 'ceo-b'));
    expect(result?.contactId).toBe('ceo-a');
  });

  it('floors to null when the parent has no lineage', () => {
    expect(capOriginatorToParent(originator('principal'), null)).toBeNull();
    expect(capOriginatorToParent(originator('principal'), undefined)).toBeNull();
  });

  it('returns null when the child has no lineage', () => {
    expect(capOriginatorToParent(null, originator('principal'))).toBeNull();
  });
});

describe('isLivePrincipalTurn (#1126 — the elevated gate predicate)', () => {
  const principal: TaskOriginator = {
    contactId: 'ceo-1', systemRole: 'principal', channel: 'cli',
    initiatedAt: '2026-06-23T00:00:00.000Z',
  };
  const meta = { originator: principal };

  it('is true only when BOTH the distinct liveTurn flag AND principal lineage are present', () => {
    expect(isLivePrincipalTurn(true, meta)).toBe(true);
  });

  it('is false for principal lineage WITHOUT the live flag (a wake / derived turn)', () => {
    // The self-approval hole closure: a woken principal-lineage task carries the originator
    // (for the autonomy ladder) but never the live-turn flag.
    expect(isLivePrincipalTurn(undefined, meta)).toBe(false);
    expect(isLivePrincipalTurn(false, meta)).toBe(false);
  });

  it('is false for the live flag WITHOUT principal lineage (forgery / downgrade defence)', () => {
    expect(isLivePrincipalTurn(true, { originator: { ...principal, systemRole: 'agent' } })).toBe(false);
    expect(isLivePrincipalTurn(true, { originator: { ...principal, systemRole: 'system' } })).toBe(false);
    expect(isLivePrincipalTurn(true, {})).toBe(false);
    expect(isLivePrincipalTurn(true, undefined)).toBe(false);
  });

  it('is false for empty/absent inputs', () => {
    expect(isLivePrincipalTurn(undefined, undefined)).toBe(false);
  });
});
