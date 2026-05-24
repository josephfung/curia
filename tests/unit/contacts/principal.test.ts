import { describe, it, expect, vi } from 'vitest';
import { isPrincipalOriginated, isAgentOriginated, isSystemOriginated, makeSystemOriginator } from '../../../src/contacts/principal.js';
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
