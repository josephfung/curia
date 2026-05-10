import { describe, it, expect } from 'vitest';
import { isPrincipalOriginated, isAgentOriginated } from '../../../src/contacts/principal.js';
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

  it('returns false when metadata is missing', () => {
    expect(isAgentOriginated(undefined)).toBe(false);
  });
});
